'use strict';
// Layer 7 — the deployed callables against the Auth, Firestore, Storage and Functions emulators
// (npm run test:emulator). The same scenarios as service.test.js, through the real SDKs: auth
// and admin refusal, a draft published end to end with a passing live check, a draft object
// tampered in the Storage emulator, and two publishes racing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const { initializeApp, deleteApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signOut } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-hcec';
const PUBLIC_BUCKET = `${PROJECT}-results`;
const EID = '2026-11-03-general';
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SAMPLE = (n) => fs.readFileSync(path.join(ROOT, 'Test_Files', 'Web Results Samples', `${n} (92).csv`), 'utf8');
const skip = !process.env.FUNCTIONS_EMULATOR_HOST && !process.env.FIREBASE_EMULATOR_HUB && 'emulators not running (npm run test:emulator)';

let app;
let auth;
let call;
let db;
let pub;
const hp = (v) => v.split(':');

test.before(async () => {
  if (skip) return;
  admin.initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });
  db = admin.firestore();
  pub = admin.storage().bucket(PUBLIC_BUCKET);
  app = initializeApp({ projectId: PROJECT, apiKey: 'demo-key', authDomain: `${PROJECT}.firebaseapp.com` }, 'client');
  auth = getAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const fns = getFunctions(app, 'us-east1');
  const [fh, fp] = hp(process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001');
  connectFunctionsEmulator(fns, fh, Number(fp));
  call = (name, data) => httpsCallable(fns, name, { timeout: 120000 })(data).then((r) => r.data);
});
test.after(async () => { if (app) await deleteApp(app); if (admin.apps.length) await admin.app().delete(); });

async function signInAs(email, { isAdmin }) {
  if (auth.currentUser) await signOut(auth);
  const { user } = await createUserWithEmailAndPassword(auth, email, 'test-password-1');
  if (isAdmin) await db.doc(`admins/${user.uid}`).set({ email, added: new Date().toISOString() });
  return user;
}
const reviewAnswers = (d) => ({ acknowledged: d.checks.filter((c) => c.severity === 'warn').map((c) => c.key), confirmCount: d.confirmCount });
const draftDoc = async (id) => (await db.doc(`elections/${EID}/drafts/${id}`).get()).data();
const code = (c) => (e) => e.code === `functions/${c}`;

test('refusals: signed out, then signed in but not an admin', { skip }, async () => {
  await assert.rejects(call('ping', {}), code('unauthenticated'));
  await signInAs(`user${Date.now()}@example.gov`, { isAdmin: false });
  await assert.rejects(call('ping', {}), code('permission-denied'));
  await assert.rejects(call('upsertElection', { id: EID }), code('permission-denied'));
});

test('an admin drafts, reviews and publishes; the public bucket serves the reviewed bytes', { skip }, async () => {
  await signInAs(`admin${Date.now()}@example.gov`, { isAdmin: true });
  assert.deepEqual(await call('ping', {}), { ok: true, admin: true });
  await call('upsertElection', { id: EID, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 92, makeActive: true });
  await assert.rejects(call('upsertElection', { id: EID, name: 'x', date: '2026-11-03', county: 'H', precinctCap: 0 }), code('invalid-argument'));

  const d = await call('createDraft', { electionId: EID, kind: 'early', filename: '02.csv', csv: SAMPLE('02-After EV') });
  assert.equal(d.status, 'ready');
  const doc = await draftDoc(d.draftId);
  const [meta] = await pub.file(`drafts/${d.draftId}/summary.json`).getMetadata();
  assert.equal(meta.contentEncoding, 'gzip');
  assert.equal(meta.cacheControl, 'no-store');

  await assert.rejects(call('publishDraft', { electionId: EID, draftId: d.draftId, ...reviewAnswers(doc), confirmCount: 99 }), code('failed-precondition'));
  const r = await call('publishDraft', { electionId: EID, draftId: d.draftId, ...reviewAnswers(doc) });
  assert.equal(r.liveCheck.ok, true);
  const [live] = await pub.file('current/summary.json').download();
  assert.equal(require('node:crypto').createHash('sha256').update(live).digest('hex'), doc.outputSha256['summary.json']);
  const [liveMeta] = await pub.file('current/summary.json').getMetadata();
  assert.deepEqual([liveMeta.cacheControl, liveMeta.contentType, liveMeta.contentEncoding], ['public, max-age=15', 'application/json; charset=utf-8', 'gzip']);
  assert.equal((await db.doc(`elections/${EID}`).get()).data().currentVersion, doc.dataVersion);
  assert.deepEqual(await call('auditLiveNow', { electionId: EID }), { ok: true, problems: [] });
});

test('a draft object tampered in Storage is refused', { skip }, async () => {
  const d = await call('createDraft', { electionId: EID, kind: 'ed', filename: '03.csv', csv: SAMPLE('03-After 5 Reporting') });
  const doc = await draftDoc(d.draftId);
  await pub.file(`drafts/${d.draftId}/reporting.json`).save('{"tampered":true}', { resumable: false });
  await assert.rejects(call('publishDraft', { electionId: EID, draftId: d.draftId, ...reviewAnswers(doc) }),
    (e) => code('failed-precondition')(e) && /changed since review/.test(e.message));
});

test('two publishes racing on the same base: exactly one wins', { skip }, async () => {
  const a = await call('createDraft', { electionId: EID, kind: 'ed', filename: '04.csv', csv: SAMPLE('04-After 10 Reporting') });
  const b = await call('createDraft', { electionId: EID, kind: 'ed', filename: '05.csv', csv: SAMPLE('05-End of Election Day') });
  const [da, dbb] = [await draftDoc(a.draftId), await draftDoc(b.draftId)];
  const results = await Promise.allSettled([
    call('publishDraft', { electionId: EID, draftId: a.draftId, ...reviewAnswers(da) }),
    call('publishDraft', { electionId: EID, draftId: b.draftId, ...reviewAnswers(dbb) }),
  ]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1, JSON.stringify(results.map((x) => x.reason?.message ?? 'ok')));
  const lost = results.find((x) => x.status === 'rejected').reason;
  assert.ok(code('failed-precondition')(lost) || code('aborted')(lost), lost.message);
  assert.equal((await db.doc(`elections/${EID}`).get()).data().publishLock, null);
});
