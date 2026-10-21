'use strict';
// Layer 6 — security rules against the Firestore and Storage emulators (npm run test:emulator).
// Non-admins read nothing; admins read election data but never write; nobody reads another
// user's admins doc; the private bucket denies every client.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } = require('firebase/firestore');
const { ref, uploadString, getBytes } = require('firebase/storage');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const hostPort = (v) => { const [host, port] = v.split(':'); return { host, port: Number(port) }; };
const skip = !process.env.FIRESTORE_EMULATOR_HOST && 'emulators not running (npm run test:emulator)';

let env;
test.before(async () => {
  if (skip) return;
  env = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT || 'demo-hcec',
    firestore: { rules: fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8'), ...hostPort(process.env.FIRESTORE_EMULATOR_HOST) },
    storage: { rules: fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8'), ...hostPort(process.env.FIREBASE_STORAGE_EMULATOR_HOST) },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'admins/admin1'), { email: 'a@x' });
    await setDoc(doc(db, 'elections/e1'), { name: 'E' });
    await setDoc(doc(db, 'elections/e1/drafts/d1'), { status: 'ready' });
    await setDoc(doc(db, 'elections/e1/uploads/u1'), { kind: 'ed' });
    await setDoc(doc(db, 'elections/e1/versions/v1'), { draftId: 'd1' });
    await setDoc(doc(db, 'audit/a1'), { action: 'publish' });
    await setDoc(doc(db, 'other/x'), { y: 1 });
    await uploadString(ref(ctx.storage(), 'uploads/e1/u1.csv'), 'csv');
  });
});
test.after(async () => { if (env) await env.cleanup(); });

const READABLE = ['elections/e1', 'elections/e1/drafts/d1', 'elections/e1/uploads/u1', 'elections/e1/versions/v1', 'audit/a1'];

test('signed out: nothing readable, nothing writable', { skip }, async () => {
  const db = env.unauthenticatedContext().firestore();
  for (const p of [...READABLE, 'admins/admin1', 'other/x']) await assertFails(getDoc(doc(db, p)));
  await assertFails(setDoc(doc(db, 'elections/e2'), { name: 'x' }));
  await assertFails(getDocs(collection(db, 'elections')));
});

test('signed-in non-admin: only their own (missing) admins doc', { skip }, async () => {
  const db = env.authenticatedContext('user1', { email: 'u@x' }).firestore();
  await assertSucceeds(getDoc(doc(db, 'admins/user1')));
  await assertFails(getDoc(doc(db, 'admins/admin1')));
  for (const p of READABLE) await assertFails(getDoc(doc(db, p)));
  await assertFails(setDoc(doc(db, 'admins/user1'), { email: 'u@x' })); // cannot make themselves admin
  await assertFails(getDocs(collection(db, 'audit')));
});

test('admin: reads election data and audit, writes nothing', { skip }, async () => {
  const db = env.authenticatedContext('admin1', { email: 'a@x' }).firestore();
  for (const p of READABLE) await assertSucceeds(getDoc(doc(db, p)));
  await assertSucceeds(getDocs(collection(db, 'elections/e1/drafts')));
  await assertSucceeds(getDocs(collection(db, 'audit')));
  await assertSucceeds(getDoc(doc(db, 'admins/admin1')));
  await assertFails(getDoc(doc(db, 'other/x')));
  for (const p of [...READABLE, 'admins/admin1', 'admins/admin2', 'other/y']) {
    await assertFails(setDoc(doc(db, p), { hacked: true }));
  }
  await assertFails(updateDoc(doc(db, 'elections/e1'), { currentVersion: 'x' }));
  await assertFails(deleteDoc(doc(db, 'elections/e1/drafts/d1')));
});

test('private bucket: no client access, admin or not', { skip }, async () => {
  for (const ctx of [env.unauthenticatedContext(), env.authenticatedContext('user1'), env.authenticatedContext('admin1')]) {
    await assertFails(getBytes(ref(ctx.storage(), 'uploads/e1/u1.csv')));
    await assertFails(uploadString(ref(ctx.storage(), 'uploads/e1/evil.csv'), 'x'));
  }
});
