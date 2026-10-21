'use strict';
// Layer 7 (logic half) — the whole callable contract against in-memory Firestore and Storage:
// a full election night 00 -> 06, every publish refusal, a tampered draft object, concurrent
// publishes, rollback, discard, settings validation, the live check and auditLive.
// The emulator suite re-runs the same scenarios against the real SDKs (Phase 2, emulator run).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./helpers/fixtures');
const { MemoryDb, MemoryBucket, clock } = require('./helpers/fakes');
const { createService, ServiceError, validateSettings, paths } = require('../src/service');
const { sha256Hex, DRAFT_TTL_MS, LOCK_TTL_MS } = require('../src/publish');
const { validateSet } = require('../src/validate');

const EID = '2026-11-03-general';
const SETTINGS = { id: EID, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 92, enablePrecinctResults: true, makeActive: true };
const ADMIN = { uid: 'u1', email: 'admin@example.gov' };
const SAMPLE = (n) => fs.readFileSync(path.join(REPO, 'Test_Files', 'Web Results Samples', `${n} (92).csv`), 'utf8');
const NIGHT = [
  ['zero', '00-Zero File'], ['early', '01-After NH&ABS'], ['early', '02-After EV'], ['ed', '03-After 5 Reporting'],
  ['ed', '04-After 10 Reporting'], ['ed', '05-End of Election Day'], ['ed', '06-End of Provisional'],
];

function setup({ fetchLive } = {}) {
  const db = new MemoryDb();
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const now = clock();
  const svc = createService({ db, publicBucket, privateBucket, now, fetchLive: fetchLive ?? ((p) => publicBucket.read(p)) });
  return { db, publicBucket, privateBucket, now, svc };
}

async function draftOf(env, kind, name, extra = {}) {
  const csv = typeof name === 'string' && !name.includes('\n') ? SAMPLE(name) : name;
  const r = await env.svc.createDraft(ADMIN, { electionId: EID, kind, filename: `${kind}.csv`, csv, ...extra });
  return { ...r, doc: await env.db.get(paths.draft(EID, r.draftId)) };
}

/** What a reviewer does: acknowledge every warning and type the count shown. */
const reviewAnswers = (doc) => ({ acknowledged: doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key), confirmCount: doc.confirmCount });

async function publish(env, d, over = {}) {
  return env.svc.publishDraft(ADMIN, { electionId: EID, draftId: d.draftId, ...reviewAnswers(d.doc), ...over });
}

const refusal = (code) => (e) => e instanceof ServiceError && (e.details?.refusals ?? []).some((r) => r.code === code);

test('a full election night 00 -> 06: every draft publishes the reviewed bytes', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  let previous = null;
  for (const [kind, name] of NIGHT) {
    const d = await draftOf(env, kind, name);
    assert.equal(d.status, 'ready', `${name}: ${JSON.stringify(d.doc.checks.filter((c) => c.severity === 'block'))}`);
    assert.equal(d.counts.block, 0);
    assert.equal(d.doc.baseVersion, previous);
    const r = await publish(env, d);
    assert.equal(r.liveCheck.ok, true, name);
    env.now.advance(60_000);

    const e = await env.db.get(paths.election(EID));
    assert.equal(e.currentVersion, d.doc.dataVersion);
    assert.equal(e.publishLock, null);
    for (const f of ['summary.json', 'reporting.json', 'precincts.json', 'data.js']) {
      assert.equal(sha256Hex(await env.publicBucket.read(`current/${f}`)), d.doc.outputSha256[f], `${name} ${f}`);
      assert.equal(env.publicBucket.meta(`current/${f}`).cacheControl, 'public, max-age=15');
      assert.equal(env.publicBucket.meta(`elections/${EID}/v/${d.doc.dataVersion}/${f}`).cacheControl, 'public, max-age=31536000, immutable');
    }
    const manifest = JSON.parse(env.publicBucket.text('current/manifest.json'));
    const pages = Object.fromEntries(['summary.json', 'reporting.json', 'precincts.json'].map((f) => [f, JSON.parse(env.publicBucket.text(`current/${f}`))]));
    assert.deepEqual(validateSet(manifest, pages).errors, [], name);
    const v = await env.db.get(paths.version(EID, d.doc.dataVersion));
    assert.equal(v.draftId, d.draftId);
    assert.deepEqual(v.liveCheck.ok, true);
    previous = d.doc.dataVersion;
  }
  const e = await env.db.get(paths.election(EID));
  const early = await env.db.get(paths.upload(EID, e.selectedEarlyUploadId));
  const ed = await env.db.get(paths.upload(EID, e.selectedEdUploadId));
  assert.deepEqual([early.kind, ed.kind], ['early', 'ed']);
  assert.equal(env.privateBucket.text(early.storagePath), SAMPLE('02-After EV'));
  const summary = JSON.parse(env.publicBucket.text('current/summary.json'));
  assert.equal(summary.latest.overallPrecinctsReporting, 92);
  assert.deepEqual(summary.config, { enablePrecinctResults: true, precinctCap: 92 });
  const actions = (await env.db.list('audit')).map((a) => a.data.action);
  assert.equal(actions.filter((a) => a === 'publish').length, 7);
  assert.equal(actions.filter((a) => a === 'draft').length, 7);
  assert.equal(env.privateBucket.list('uploads/').length, 7, 'every upload archived');
});

test('an ED upload keeps the selected Early file; review files are written with the draft', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  await publish(env, await draftOf(env, 'early', '02-After EV'));
  const d = await draftOf(env, 'ed', '04-After 10 Reporting');
  assert.ok(d.doc.earlyUploadId && d.doc.edUploadId);
  assert.equal(d.doc.confirmCount, 10);
  const review = JSON.parse(env.publicBucket.text(`drafts/${d.draftId}/review.json`));
  assert.equal(review.otherSlot.kind, 'early');
  assert.deepEqual(review.headline.precinctsReporting.draft, 10);
  const trace = JSON.parse(env.publicBucket.text(`drafts/${d.draftId}/trace.json`));
  assert.ok(trace.contests.Governor.length > 0);
  for (const f of ['summary.json', 'review.json', 'trace.json']) {
    const meta = env.publicBucket.meta(`drafts/${d.draftId}/${f}`);
    assert.deepEqual([meta.cacheControl, meta.gzip], ['no-store', true]);
  }
});

test('publish refusals: unacknowledged, wrong typed count, expired then extended', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  await publish(env, await draftOf(env, 'early', '02-After EV'));
  const d = await draftOf(env, 'ed', '03-After 5 Reporting');
  assert.ok(d.doc.checks.some((c) => c.severity === 'warn'));
  await assert.rejects(publish(env, d, { acknowledged: [] }), refusal('unacknowledged'));
  await assert.rejects(publish(env, d, { confirmCount: 92 }), refusal('confirm-mismatch'));
  await assert.rejects(publish(env, d, { acknowledged: 'all' }), (e) => e.code === 'invalid-argument');
  env.now.advance(DRAFT_TTL_MS);
  await assert.rejects(publish(env, d), refusal('expired'));
  const { expiresAt } = await env.svc.extendDraft(ADMIN, { electionId: EID, draftId: d.draftId });
  assert.equal(expiresAt, env.now() + DRAFT_TTL_MS);
  assert.equal((await publish(env, d)).liveCheck.ok, true);
  await assert.rejects(publish(env, d), refusal('not-ready')); // already published
});

test('a draft object changed after review is refused (and cannot be extended)', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  const d = await draftOf(env, 'early', '02-After EV');
  const p = `drafts/${d.draftId}/summary.json`;
  await env.publicBucket.write(p, env.publicBucket.text(p).replace('"totalBallots":', '"totalBallots":1'));
  await assert.rejects(publish(env, d), refusal('tampered'));
  await assert.rejects(env.svc.extendDraft(ADMIN, { electionId: EID, draftId: d.draftId }), refusal('tampered'));
  assert.equal(env.publicBucket.text('current/summary.json'), null, 'nothing went live');
});

test('stale: publishing B after A was drafted makes A stale', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  const a = await draftOf(env, 'early', '01-After NH&ABS');
  const b = await draftOf(env, 'early', '02-After EV');
  await publish(env, b);
  await assert.rejects(publish(env, a), refusal('stale'));
  assert.equal((await env.db.get(paths.draft(EID, a.draftId))).status, 'stale');
});

test('concurrent publishes of two drafts on the same base: exactly one wins', async () => {
  for (let round = 0; round < 5; round++) {
    const env = setup();
    await env.svc.upsertElection(ADMIN, SETTINGS);
    const a = await draftOf(env, 'early', '01-After NH&ABS');
    const b = await draftOf(env, 'early', '02-After EV');
    const results = await Promise.allSettled([publish(env, a), publish(env, b)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    assert.equal(won.length, 1, JSON.stringify(results.map((r) => r.status)));
    const lost = results.find((r) => r.status === 'rejected').reason;
    assert.ok(refusal('stale')(lost) || refusal('busy')(lost), lost.message);
    const e = await env.db.get(paths.election(EID));
    assert.equal(e.currentVersion, won[0].value.dataVersion);
    assert.equal(e.publishLock, null);
  }
});

test('the lock is released when a publish fails part-way, and a held lock expires', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  const d = await draftOf(env, 'early', '02-After EV');
  const copy = env.publicBucket.copy.bind(env.publicBucket);
  env.publicBucket.copy = async (from, to, meta) => { if (to.startsWith('current/')) throw new Error('storage outage'); return copy(from, to, meta); };
  await assert.rejects(publish(env, d), /storage outage/);
  assert.equal((await env.db.get(paths.election(EID))).publishLock, null);
  env.publicBucket.copy = copy;

  await env.db.update(paths.election(EID), { publishLock: { holder: 'other', until: env.now() + LOCK_TTL_MS } });
  await assert.rejects(publish(env, d), refusal('busy'));
  env.now.advance(LOCK_TTL_MS);
  assert.equal((await publish(env, d)).liveCheck.ok, true);
});

test('blocked and unreadable uploads never publish; nothing is written for an unreadable file', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  const zeroWithVotes = await draftOf(env, 'zero', '02-After EV');
  assert.equal(zeroWithVotes.status, 'blocked');
  assert.ok(zeroWithVotes.doc.checks.some((c) => c.id === 'zero-file-has-votes'));
  await assert.rejects(publish(env, zeroWithVotes), refusal('blocked'));

  const junk = await draftOf(env, 'ed', 'not,a\nreport\n');
  assert.equal(junk.status, 'blocked');
  assert.deepEqual(junk.doc.checks.map((c) => c.id), ['not-custom-table-report', 'unreadable']);
  assert.deepEqual(env.publicBucket.list(`drafts/${junk.draftId}/`), []);
  const broken = await draftOf(env, 'ed', `Custom Table Report\n\n\nx\ny\n"${'z'.repeat(140000)}"`);
  assert.deepEqual(broken.doc.checks.map((c) => c.id), ['unreadable']);
  assert.equal((await env.db.list(paths.uploads(EID))).length, 3, 'still archived');
});

test('duplicate uploads are flagged; the date must match the election', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  await draftOf(env, 'early', '02-After EV');
  const again = await draftOf(env, 'early', '02-After EV');
  assert.ok(again.doc.checks.some((c) => c.id === 'duplicate-upload'));
  await env.svc.upsertElection(ADMIN, { ...SETTINGS, date: '2026-11-04' });
  const wrongDay = await draftOf(env, 'early', '02-After EV');
  assert.equal(wrongDay.status, 'blocked');
  assert.ok(wrongDay.doc.checks.some((c) => c.id === 'date-mismatch'));
});

test('rollback: a stored version republishes through the same review and publish path', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  await publish(env, await draftOf(env, 'early', '02-After EV'));
  const d3 = await draftOf(env, 'ed', '03-After 5 Reporting');
  await publish(env, d3);
  await publish(env, await draftOf(env, 'ed', '04-After 10 Reporting'));

  const rb = await env.svc.createRollbackDraft(ADMIN, { electionId: EID, version: d3.doc.dataVersion });
  const doc = await env.db.get(paths.draft(EID, rb.draftId));
  assert.equal(rb.status, 'ready');
  assert.deepEqual([doc.kind, doc.rollbackOf, doc.confirmCount], ['rollback', d3.doc.dataVersion, 5]);
  assert.ok(doc.checks.some((c) => c.id === 'rollback') && doc.checks.some((c) => c.id === 'reporting-decreased'));
  const r = await env.svc.publishDraft(ADMIN, { electionId: EID, draftId: rb.draftId, ...reviewAnswers(doc) });
  assert.equal(r.dataVersion, d3.doc.dataVersion);
  assert.equal(sha256Hex(await env.publicBucket.read('current/summary.json')), d3.doc.outputSha256['summary.json']);
  const e = await env.db.get(paths.election(EID));
  assert.deepEqual([e.selectedEarlyUploadId, e.selectedEdUploadId], [d3.doc.earlyUploadId, d3.doc.edUploadId]);
  assert.equal((await env.db.get(paths.version(EID, r.dataVersion))).rollbackOf, d3.doc.dataVersion);
  await assert.rejects(env.svc.createRollbackDraft(ADMIN, { electionId: EID, version: 'ffffffffffff' }), (e2) => e2.code === 'not-found');
  await assert.rejects(env.svc.createRollbackDraft(ADMIN, { electionId: EID, version: '../x' }), (e2) => e2.code === 'not-found');
});

test('discard deletes the draft files; published drafts cannot be discarded', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  const d = await draftOf(env, 'early', '02-After EV');
  assert.ok(env.publicBucket.list(`drafts/${d.draftId}/`).length >= 6);
  await env.svc.discardDraft(ADMIN, { electionId: EID, draftId: d.draftId });
  assert.deepEqual(env.publicBucket.list(`drafts/${d.draftId}/`), []);
  assert.equal((await env.db.get(paths.draft(EID, d.draftId))).status, 'discarded');
  await assert.rejects(publish(env, d), refusal('not-ready'));
  const p = await draftOf(env, 'early', '02-After EV');
  await publish(env, p);
  await assert.rejects(env.svc.discardDraft(ADMIN, { electionId: EID, draftId: p.draftId }), (e) => e.code === 'failed-precondition');
  await assert.rejects(env.svc.discardDraft(ADMIN, { electionId: EID, draftId: 'f'.repeat(32) }), (e) => e.code === 'not-found');
  await assert.rejects(env.svc.discardDraft(ADMIN, { electionId: EID, draftId: 'nope' }), (e) => e.code === 'invalid-argument');
});

test('live check fails loudly when the public URL serves something else', async () => {
  const env = setup({ fetchLive: async () => Buffer.from('stale edge copy') });
  await env.svc.upsertElection(ADMIN, SETTINGS);
  const d = await draftOf(env, 'early', '02-After EV');
  const r = await publish(env, d);
  assert.equal(r.liveCheck.ok, false);
  assert.equal((await env.db.get(paths.version(EID, r.dataVersion))).liveCheck.ok, false);
  const last = (await env.db.list('audit')).map((a) => a.data).find((a) => a.action === 'publish');
  assert.match(last.detail, /live check FAILED/);
});

test('auditLive: served bytes must equal the published version', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  assert.deepEqual(await env.svc.auditLive(ADMIN, { electionId: EID }), { ok: true, problems: [] }); // nothing published yet
  await publish(env, await draftOf(env, 'early', '02-After EV'));
  assert.deepEqual(await env.svc.auditLive(ADMIN, { electionId: EID }), { ok: true, problems: [] });
  await env.publicBucket.write('current/reporting.json', '{"broken":true}');
  const bad = await env.svc.auditLive(ADMIN, { electionId: EID });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /reporting.json differs/.test(p)));
  await env.publicBucket.deletePrefix('current/manifest.json');
  assert.deepEqual((await env.svc.auditLive(ADMIN, { electionId: EID })).problems, ['manifest.json could not be fetched or is not JSON']);
  const audits = (await env.db.list('audit')).map((a) => a.data).filter((a) => a.action === 'auditLive');
  assert.deepEqual(audits.map((a) => a.ok), [true, true, false, false]);
  const lastAudit = (await env.db.get(paths.election(EID))).lastAudit;
  assert.equal(lastAudit.ok, false);
  assert.deepEqual(lastAudit.problems, ['manifest.json could not be fetched or is not JSON']);
});

test('settings: validation with the fix in the message; one active election', async () => {
  const env = setup();
  const r = await env.svc.upsertElection(ADMIN, SETTINGS);
  assert.deepEqual(r, { id: EID, created: true });
  const e = await env.db.get(paths.election(EID));
  assert.deepEqual([e.active, e.precinctCap, e.currentVersion, e.enablePrecinctResults], [true, 92, null, true]);
  await env.svc.upsertElection(ADMIN, { ...SETTINGS, id: '2027-08-05-primary', makeActive: true });
  assert.equal((await env.db.get(paths.election(EID))).active, false);
  assert.equal((await env.svc.upsertElection(ADMIN, { ...SETTINGS, precinctCap: 94, makeActive: false })).created, false);
  assert.equal((await env.db.get(paths.election(EID))).precinctCap, 94);

  for (const [over, field] of [[{ id: 'Bad Id' }, 'id'], [{ name: ' ' }, 'name'], [{ county: 'x'.repeat(101) }, 'county'], [{ date: '2026-02-30' }, 'date'],
    [{ date: '11/3/2026' }, 'date'], [{ precinctCap: 0 }, 'precinctCap'], [{ precinctCap: 1000 }, 'precinctCap'], [{ precinctCap: 92.5 }, 'precinctCap'],
    [{ enablePrecinctResults: 'yes' }, 'enablePrecinctResults'], [{ makeActive: 1 }, 'makeActive']]) {
    assert.throws(() => validateSettings({ ...SETTINGS, ...over }), (err) => err.code === 'invalid-argument' && err.details.field === field, field);
  }
  assert.throws(() => validateSettings(null), (err) => err.details.field === 'settings');
  assert.throws(() => validateSettings({ ...SETTINGS, precinctCap: 0 }), { message: 'precinctCap: Max precincts must be a whole number from 1 to 999' });
  assert.equal(validateSettings({ ...SETTINGS, precinctCap: undefined }).precinctCap, 92);
  await assert.rejects(env.svc.createDraft(ADMIN, { electionId: 'missing', kind: 'ed', filename: 'a.csv', csv: 'x' }), (err) => err.code === 'not-found');
  await assert.rejects(env.svc.createDraft(ADMIN, { electionId: '../x', kind: 'ed', filename: 'a.csv', csv: 'x' }), (err) => err.code === 'invalid-argument');
  await assert.rejects(env.svc.createDraft(ADMIN, { electionId: EID, kind: 'x', filename: 'a.csv', csv: 'x' }), (err) => err.code === 'invalid-argument');
});
