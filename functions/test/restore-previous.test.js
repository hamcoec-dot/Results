'use strict';
// tools/restore-previous.js: after a staging-election.js run, the election that was active before
// gets its place and its public files back (staging auditLive alert, 2026-11-20). Run against the
// real service with in-memory Firestore and Storage; auditLive is the judge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./helpers/fixtures');
const { MemoryDb, MemoryBucket, clock } = require('./helpers/fakes');
const { createService, paths } = require('../src/service');
const { restorePrevious } = require('../../tools/restore-previous');

const PREV = '2026-11-03-general';
const TEST = 'test-certified';
const ADMIN = { uid: 'staging-bot', email: 'staging-bot@example.gov' };
const SETTINGS = (id, extra = {}) => ({ id, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 92, enablePrecinctResults: true, makeActive: true, ...extra });
const SAMPLE = (n) => fs.readFileSync(path.join(REPO, 'Test_Files', 'Web Results Samples', `${n} (92).csv`), 'utf8');

function setup() {
  const db = new MemoryDb();
  const publicBucket = new MemoryBucket();
  const now = clock(Date.UTC(2026, 10, 20, 17, 0));
  const svc = createService({ db, publicBucket, privateBucket: new MemoryBucket(), now, sleep: async () => {}, fetchLive: (p) => publicBucket.read(p) });
  const calls = [];
  const env = { db, publicBucket, svc, calls };
  env.deps = (over = {}) => ({
    previous: PREV, electionId: TEST, log: () => {}, error: () => {},
    call: async (name, data) => { calls.push(name); return svc[name](ADMIN, data); },
    getElection: (id) => db.get(paths.election(id)),
    getDraft: (eid, id) => db.get(paths.draft(eid, id)),
    readManifest: async () => { const b = await publicBucket.read('current/manifest.json'); return b ? JSON.parse(b.toString('utf8')) : null; },
    ...over,
  });
  return env;
}

async function publishFile(env, eid, kind, name) {
  const r = await env.svc.createDraft(ADMIN, { electionId: eid, kind, filename: `${kind}.csv`, csv: SAMPLE(name) });
  const doc = await env.db.get(paths.draft(eid, r.draftId));
  await env.svc.publishDraft(ADMIN, { electionId: eid, draftId: r.draftId, confirmCount: doc.confirmCount, acknowledged: doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key) });
  return doc.dataVersion;
}

/** What staging-election.js does: the test election made active, and (optionally) published. */
async function testRun(env, { publish = true } = {}) {
  await env.svc.upsertElection(ADMIN, SETTINGS(TEST));
  if (publish) return publishFile(env, TEST, 'ed', '04-After 10 Reporting');
  return null;
}

const election = (env, id) => env.db.get(paths.election(id));
const manifest = (env) => JSON.parse(env.publicBucket.text('current/manifest.json'));
const audit = (env, id) => env.svc.auditLive(ADMIN, { electionId: id });

test('a published previous election: active again, its version republished, auditLive ok', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
  const version = await publishFile(env, PREV, 'ed', '06-End of Provisional');
  const testVersion = await testRun(env);
  assert.equal(manifest(env).dataVersion, testVersion);
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV)); // as if the tool had only switched back (the bug)
  assert.equal((await audit(env, PREV)).ok, false, 'the bug: current/ holds the test election\'s files');
  await env.svc.upsertElection(ADMIN, SETTINGS(TEST));

  const r = await restorePrevious(env.deps());
  assert.deepEqual(r, { ok: true, action: 'rollback' });
  assert.equal((await election(env, PREV)).active, true);
  assert.equal((await election(env, TEST)).active, false);
  assert.equal(manifest(env).dataVersion, version);
  assert.equal((await election(env, PREV)).currentVersion, version);
  assert.equal((await audit(env, PREV)).ok, true);
});

test('nothing published by the run (a preview): only made active again, no rollback', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
  const version = await publishFile(env, PREV, 'ed', '06-End of Provisional');
  await testRun(env, { publish: false });
  const r = await restorePrevious(env.deps());
  assert.deepEqual(r, { ok: true, action: 'activated' });
  assert.deepEqual(env.calls, ['upsertElection']);
  assert.equal(manifest(env).dataVersion, version);
  assert.equal((await audit(env, PREV)).ok, true);
});

test('an older election doc without enablePrecinctResults / precinctCap keeps the service defaults', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV, { precinctCap: 94 }));
  await publishFile(env, PREV, 'ed', '06-End of Provisional');
  await testRun(env);
  const doc = await election(env, PREV);
  delete doc.enablePrecinctResults;
  delete doc.precinctCap;
  await env.db.set(paths.election(PREV), doc);

  assert.equal((await restorePrevious(env.deps())).ok, true);
  const after = await election(env, PREV);
  assert.equal(after.enablePrecinctResults, true, 'a missing field means the precinct page is shown (pageConfig)');
  assert.equal(after.precinctCap, 92);
  assert.equal((await audit(env, PREV)).ok, true);
});

test('enablePrecinctResults false is kept', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV, { enablePrecinctResults: false }));
  await publishFile(env, PREV, 'ed', '06-End of Provisional');
  await testRun(env);
  assert.equal((await restorePrevious(env.deps())).ok, true);
  assert.equal((await election(env, PREV)).enablePrecinctResults, false);
});

test('a cleared previous election: the "no current election" state comes back, never its old results', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
  await publishFile(env, PREV, 'ed', '06-End of Provisional');
  await env.svc.archiveElection(ADMIN, { electionId: PREV, certifiedDate: '2026-11-20' });
  await env.svc.clearCurrentResults(ADMIN, { electionId: PREV });
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV)); // docs/ARCHIVE.md: cleared, then made active again
  await testRun(env);

  const r = await restorePrevious(env.deps());
  assert.deepEqual(r, { ok: true, action: 'cleared' });
  assert.ok(!env.calls.includes('createRollbackDraft') && !env.calls.includes('publishDraft'));
  assert.equal(manifest(env).noElection, true);
  assert.equal(manifest(env).dataVersion, null);
  assert.equal(env.publicBucket.text('current/summary.json'), null, 'the test election\'s files are gone');
  const prev = await election(env, PREV);
  assert.equal(prev.active, true);
  assert.ok(prev.cleared);
  assert.equal((await election(env, TEST)).active, false);
  assert.equal((await audit(env, PREV)).ok, true);
});

test('a cleared previous election already showing "no current election": only made active again', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
  await publishFile(env, PREV, 'ed', '06-End of Provisional');
  await env.svc.archiveElection(ADMIN, { electionId: PREV, certifiedDate: '2026-11-20' });
  await env.svc.clearCurrentResults(ADMIN, { electionId: PREV });
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
  await testRun(env, { publish: false });
  assert.deepEqual(await restorePrevious(env.deps()), { ok: true, action: 'activated' });
  assert.deepEqual(env.calls, ['upsertElection']);
});

test('a previous election that never published: the test election stays active, with a warning', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
  const testVersion = await testRun(env);
  const logs = [];
  const r = await restorePrevious(env.deps({ log: (m) => logs.push(m) }));
  assert.deepEqual(r, { ok: true, action: 'left' });
  assert.deepEqual(env.calls, []);
  assert.match(logs.join('\n'), /WARNING: .* stays the active election/);
  assert.equal((await election(env, TEST)).active, true);
  assert.equal(manifest(env).dataVersion, testVersion);
  assert.equal((await audit(env, TEST)).ok, true);
});

test('a publish that throws: the error reaches the caller (staging-election.js prints FAIL, exit 1)', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
  await publishFile(env, PREV, 'ed', '06-End of Provisional');
  await testRun(env);
  const deps = env.deps();
  const call = deps.call;
  deps.call = async (name, data) => { if (name === 'publishDraft') throw new Error('busy'); return call(name, data); };
  await assert.rejects(restorePrevious(deps), /busy/);
});

test('a rollback draft that is not ready, or a publish that does not go live: ok false', async () => {
  for (const over of [
    { createRollbackDraft: (r) => ({ ...r, status: 'blocked' }) },
    { publishDraft: (r) => ({ ...r, liveCheck: { ok: false } }) },
  ]) {
    const env = setup();
    await env.svc.upsertElection(ADMIN, SETTINGS(PREV));
    await publishFile(env, PREV, 'ed', '06-End of Provisional');
    await testRun(env);
    const errors = [];
    const deps = env.deps({ error: (m) => errors.push(m) });
    const call = deps.call;
    deps.call = async (name, data) => { const r = await call(name, data); return over[name] ? over[name](r) : r; };
    assert.deepEqual(await restorePrevious(deps), { ok: false, action: 'rollback' });
    assert.match(errors.join('\n'), /^FAIL/);
  }
});

test('a previous election that no longer exists: ok false', async () => {
  const env = setup();
  await testRun(env);
  assert.deepEqual(await restorePrevious(env.deps()), { ok: false, action: 'missing' });
});
