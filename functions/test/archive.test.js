'use strict';
// Official archive and "no current election" (docs/ARCHIVE.md): the pure rules in archive.js and the
// archiveElection / clearCurrentResults callables against in-memory Firestore and Storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./helpers/fixtures');
const { MemoryDb, MemoryBucket, clock } = require('./helpers/fakes');
const { createService, ServiceError, paths } = require('../src/service');
const { sha256Hex } = require('../src/publish');
const { validateSet, validateFile } = require('../src/validate');
const A = require('../src/archive');

const EID = '2026-11-03-general';
const SETTINGS = { id: EID, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 92, enablePrecinctResults: true, makeActive: true };
const ADMIN = { uid: 'u1', email: 'admin@example.gov' };
const SAMPLE = (n) => fs.readFileSync(path.join(REPO, 'Test_Files', 'Web Results Samples', `${n} (92).csv`), 'utf8');
const DATA_FILES = ['summary.json', 'reporting.json', 'precincts.json', 'data.js'];

function setup() {
  const db = new MemoryDb();
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const now = clock(Date.UTC(2026, 10, 20, 17, 0));
  const svc = createService({ db, publicBucket, privateBucket, now, sleep: async () => {}, fetchLive: (p) => publicBucket.read(p) });
  return { db, publicBucket, privateBucket, now, svc };
}

async function publishFile(env, kind, name, eid = EID) {
  const r = await env.svc.createDraft(ADMIN, { electionId: eid, kind, filename: `${kind}.csv`, csv: SAMPLE(name) });
  const doc = await env.db.get(paths.draft(eid, r.draftId));
  await env.svc.publishDraft(ADMIN, {
    electionId: eid, draftId: r.draftId, confirmCount: doc.confirmCount,
    acknowledged: doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key),
  });
  return doc.dataVersion;
}

/** An election with its final results published. */
async function finalNight() {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  await publishFile(env, 'early', '02-After EV');
  const version = await publishFile(env, 'ed', '06-End of Provisional');
  return { env, version };
}

const refusal = (code) => (e) => e instanceof ServiceError && (e.details?.refusals ?? []).some((r) => r.code === code);
const json = (env, p) => JSON.parse(env.publicBucket.text(p));

test('archive: the live version, relabelled OFFICIAL RESULTS, valid, in its own folder and the index', async () => {
  const { env, version } = await finalNight();
  const r = await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  assert.equal(r.version, version);
  assert.equal(r.path, `archive/${EID}/`);

  const files = Object.fromEntries(['summary.json', 'reporting.json', 'precincts.json'].map((f) => [f, json(env, `archive/${EID}/${f}`)]));
  const manifest = json(env, `archive/${EID}/manifest.json`);
  assert.deepEqual(validateSet(manifest, files).errors, []);
  assert.equal(manifest.dataVersion, version);
  assert.deepEqual(manifest.official, { certifiedDate: '2026-11-20', archivedAt: '2026-11-20T17:00:00.000Z', sourceVersion: version });
  for (const f of DATA_FILES) {
    assert.equal(env.publicBucket.meta(`archive/${EID}/${f}`).cacheControl, A.ARCHIVE_CACHE);
    assert.equal(manifest.files[f], sha256Hex(env.publicBucket.text(`archive/${EID}/${f}`)), f);
  }
  for (const f of ['summary.json', 'reporting.json', 'precincts.json']) {
    assert.equal(files[f].metadata.statusLabel, 'OFFICIAL RESULTS', f);
    assert.equal(files[f].metadata.official.certifiedDate, '2026-11-20', f);
  }
  assert.equal(files['summary.json'].latest.statusLabel, 'OFFICIAL RESULTS');

  // Same numbers as the live version: only the label and the certification block differ.
  const live = json(env, 'current/summary.json');
  assert.deepEqual(files['summary.json'].latest.contests, live.latest.contests);
  assert.equal(files['summary.json'].latest.totalBallots, live.latest.totalBallots);
  const bundle = JSON.parse(env.publicBucket.text(`archive/${EID}/data.js`).replace(/^[^=]*= /, '').replace(/;\n$/, ''));
  assert.equal(bundle.latest.statusLabel, 'OFFICIAL RESULTS');
  assert.equal(bundle.metadata.official.sourceVersion, version);

  // current/ is untouched by archiving.
  assert.equal(json(env, 'current/manifest.json').dataVersion, version);

  const index = json(env, 'archive/index.json');
  assert.equal(env.publicBucket.meta('archive/index.json').cacheControl, A.INDEX_CACHE);
  assert.equal(index.elections.length, 1);
  assert.deepEqual(index.elections[0], {
    id: EID, name: '2026-11-03 General', date: '2026-11-03', title: live.latest.electionTitle, county: live.latest.county,
    certifiedDate: '2026-11-20', archivedAt: '2026-11-20T17:00:00.000Z', archivedBy: ADMIN.email, version,
    totalBallots: live.latest.totalBallots, turnoutPercent: live.latest.turnoutPercent, contests: live.latest.contests.length, precinctPage: true,
  });

  const e = await env.db.get(paths.election(EID));
  assert.deepEqual(e.archive, { version, certifiedDate: '2026-11-20', archivedAt: '2026-11-20T17:00:00.000Z', archivedBy: ADMIN.email });
  const audit = (await env.db.list('audit')).map((a) => a.data).filter((a) => a.action === 'archive');
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /certified 2026-11-20/);
});

test('archive again after a correction: replaces the archive and its index entry', async () => {
  const { env } = await finalNight();
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-19' });
  env.now.advance(60_000);
  // A settings change publishes a new version of the same files.
  await env.svc.upsertElection(ADMIN, { ...SETTINGS, enablePrecinctResults: false });
  const r1 = await env.svc.createSettingsDraft(ADMIN, { electionId: EID });
  const doc = await env.db.get(paths.draft(EID, r1.draftId));
  await env.svc.publishDraft(ADMIN, { electionId: EID, draftId: r1.draftId, confirmCount: doc.confirmCount, acknowledged: doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key) });

  const r = await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  assert.equal(r.version, doc.dataVersion);
  const index = json(env, 'archive/index.json');
  assert.equal(index.elections.length, 1);
  assert.equal(index.elections[0].certifiedDate, '2026-11-20');
  assert.equal(index.elections[0].precinctPage, false);
  assert.equal(json(env, `archive/${EID}/manifest.json`).dataVersion, doc.dataVersion);
  const audit = (await env.db.list('audit')).map((a) => a.data).filter((a) => a.action === 'archive');
  assert.match(audit.find((a) => a.detail.includes('replaces')).detail, /replaces the archive of/);
});

test('archive refusals: nothing published, bad, early or future dates; a missing version file', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  await assert.rejects(env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' }), refusal('nothing-published'));
  await publishFile(env, 'early', '02-After EV');
  for (const d of ['2026-11-31', '20-11-2026', undefined, '2026-11-02', '2026-11-21']) {
    await assert.rejects(env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: d }), (e) => refusal('bad-date')(e) && e.code === 'invalid-argument' && e.details.field === 'certifiedDate', String(d));
  }
  // The election date itself and today (in Hamilton County) are fine.
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-03' });
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  const { currentVersion } = await env.db.get(paths.election(EID));
  await env.publicBucket.deletePrefix(`elections/${EID}/v/${currentVersion}/precincts.json`);
  await assert.rejects(env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' }), (e) => e.code === 'not-found' && /precincts\.json/.test(e.message));
  await assert.rejects(env.svc.archiveElection(ADMIN, { electionId: 'Bad Id', certifiedDate: '2026-11-20' }), (e) => e.code === 'invalid-argument');
});

test('two elections archived: the index lists both, newest election first', async () => {
  const { env } = await finalNight();
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  // An older election archived later still sorts after the newer one.
  const OLD = '2026-08-06-general';
  await env.svc.upsertElection(ADMIN, { ...SETTINGS, id: OLD, name: '2026-08-06 General', date: '2026-08-06' });
  await env.db.update(paths.election(OLD), { currentVersion: 'aaaaaaaaaaaa' });
  for (const f of DATA_FILES) await env.publicBucket.copy(`archive/${EID}/${f}`, `elections/${OLD}/v/aaaaaaaaaaaa/${f}`);
  await env.svc.archiveElection(ADMIN, { electionId: OLD, certifiedDate: '2026-08-20' });
  assert.deepEqual(json(env, 'archive/index.json').elections.map((e) => e.id), [EID, OLD]);
});

test('clear: refused until the live version is archived; then current/ says no election and the election is inactive', async () => {
  const { env, version } = await finalNight();
  await assert.rejects(env.svc.clearCurrentResults(ADMIN, { electionId: EID }), refusal('not-archived'));
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });

  // A later publish makes the archive out of date: clearing is refused again until it is redone.
  await env.db.update(paths.election(EID), { archive: { version: 'bbbbbbbbbbbb' } });
  await assert.rejects(env.svc.clearCurrentResults(ADMIN, { electionId: EID }), (e) => refusal('not-archived')(e) && /Create the official archive again/.test(e.message));
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });

  const r = await env.svc.clearCurrentResults(ADMIN, { electionId: EID });
  assert.equal(r.clearedAt, '2026-11-20T17:00:00.000Z');
  const manifest = json(env, 'current/manifest.json');
  assert.deepEqual(manifest, { noElection: true, dataVersion: null, updatedAt: '2026-11-20T17:00:00.000Z' });
  assert.match(env.publicBucket.text('current/manifest.json'), /dataVersion/); // what the uptime check looks for
  assert.equal(env.publicBucket.meta('current/manifest.json').cacheControl, 'public, max-age=15');
  assert.deepEqual(env.publicBucket.list('current/'), ['current/manifest.json']);
  // The archive and the published versions stay.
  assert.ok(env.publicBucket.text(`archive/${EID}/summary.json`));
  assert.ok(env.publicBucket.text(`elections/${EID}/v/${version}/summary.json`));

  const e = await env.db.get(paths.election(EID));
  assert.equal(e.active, false);
  assert.equal(e.publishLock, null);
  assert.equal(e.currentVersion, version);
  assert.deepEqual(e.cleared, { at: '2026-11-20T17:00:00.000Z', by: ADMIN.email, version });
  assert.ok((await env.db.list('audit')).some((a) => a.data.action === 'clear'));

  // Not active any more: a second clear is refused, and so is a publish.
  await assert.rejects(env.svc.clearCurrentResults(ADMIN, { electionId: EID }), refusal('not-active'));
  const d = await env.svc.createSettingsDraft(ADMIN, { electionId: EID });
  const doc = await env.db.get(paths.draft(EID, d.draftId));
  await assert.rejects(env.svc.publishDraft(ADMIN, { electionId: EID, draftId: d.draftId, confirmCount: doc.confirmCount, acknowledged: doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key) }), refusal('not-active'));
});

test('clear, then the next election: its first publish brings the results pages back', async () => {
  const { env } = await finalNight();
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  await env.svc.clearCurrentResults(ADMIN, { electionId: EID });
  const NEXT = '2026-11-03-rerun'; // a second election on the sample files' date
  await env.svc.upsertElection(ADMIN, { ...SETTINGS, id: NEXT, name: 'Next', date: '2026-11-03' });
  const version = await publishFile(env, 'early', '02-After EV', NEXT);
  const manifest = json(env, 'current/manifest.json');
  assert.equal(manifest.noElection, undefined);
  assert.equal(manifest.dataVersion, version);
  assert.deepEqual(validateFile('manifest.json', manifest).errors, []);
});

test('clear: an election with nothing published may be cleared; a failed write releases the lease and keeps it active', async () => {
  const env = setup();
  await env.svc.upsertElection(ADMIN, SETTINGS);
  const failing = setup();
  await failing.svc.upsertElection(ADMIN, SETTINGS);
  failing.publicBucket.write = async () => { throw new Error('bucket down'); };
  await assert.rejects(failing.svc.clearCurrentResults(ADMIN, { electionId: EID }), /bucket down/);
  const e = await failing.db.get(paths.election(EID));
  assert.equal(e.publishLock, null);
  assert.equal(e.active, true);

  await env.svc.clearCurrentResults(ADMIN, { electionId: EID });
  assert.equal(json(env, 'current/manifest.json').noElection, true);
});

test('clear while a publish holds the lease: refused as busy', async () => {
  const { env } = await finalNight();
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  await env.db.update(paths.election(EID), { publishLock: { holder: 'someone', until: env.now() + 30_000 } });
  await assert.rejects(env.svc.clearCurrentResults(ADMIN, { electionId: EID }), (e) => refusal('busy')(e) && e.code === 'aborted');
  assert.notEqual(json(env, 'current/manifest.json').noElection, true);
});

test('clear: the election changing between the check and the lease is caught in the transaction', async () => {
  const { env } = await finalNight();
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  const realTx = env.db.transaction.bind(env.db);
  let first = true;
  env.db.transaction = async (fn) => {
    if (first) { first = false; await env.db.update(paths.election(EID), { active: false }); }
    return realTx(fn);
  };
  await assert.rejects(env.svc.clearCurrentResults(ADMIN, { electionId: EID }), refusal('not-active'));
});

test('mergeIndex: an unreadable or odd index is rebuilt; at most 500 entries', () => {
  const entry = { id: 'b', date: '2026-01-01' };
  assert.deepEqual(JSON.parse(A.mergeIndex('not json', entry, 't')), { updatedAt: 't', elections: [entry] });
  assert.deepEqual(JSON.parse(A.mergeIndex(null, entry, 't')).elections, [entry]);
  assert.deepEqual(JSON.parse(A.mergeIndex('{"elections":"x"}', entry, 't')).elections, [entry]);
  assert.deepEqual(JSON.parse(A.mergeIndex(JSON.stringify({ elections: [null, { id: 'a' }, { id: 'c', date: '2026-01-01' }] }), entry, 't')).elections.map((e) => e.id), ['b', 'c', 'a']);
  const many = { elections: Array.from({ length: 600 }, (_, i) => ({ id: `e${i}`, date: '2020-01-01' })) };
  assert.equal(JSON.parse(A.mergeIndex(JSON.stringify(many), entry, 't')).elections.length, 500);
});

test('buildArchive: falls back to the data for a name and date; precinct page off; no contests', () => {
  const s = { metadata: { statusLabel: 'UNOFFICIAL RESULTS' }, config: { enablePrecinctResults: false }, latest: { electionTitle: 'T', county: 'C' } };
  const p = { metadata: {} };
  const files = { 'summary.json': JSON.stringify(s), 'reporting.json': JSON.stringify(p), 'precincts.json': JSON.stringify(p), 'data.js': `window.ELECTION_DATA = ${JSON.stringify(s)};\n` };
  const { entry, files: out } = A.buildArchive(files, { electionId: 'x', election: {}, version: 'abcdefabcdef', certifiedDate: '2026-01-02', archivedAt: 't', archivedBy: 'b' });
  assert.equal(entry.name, 'T');
  assert.equal(entry.date, null);
  assert.equal(entry.county, 'C');
  assert.equal(entry.contests, null);
  assert.equal(entry.totalBallots, null);
  assert.equal(entry.precinctPage, false);
  assert.equal(JSON.parse(out['reporting.json']).latest, undefined);
  const bare = A.buildArchive({ ...files, 'summary.json': JSON.stringify({ metadata: {} }) }, { electionId: 'x', election: {}, version: 'abcdefabcdef', certifiedDate: '2026-01-02', archivedAt: 't', archivedBy: 'b' }).entry;
  assert.deepEqual([bare.name, bare.title, bare.county, bare.precinctPage], ['x', null, null, true]);
});

test('localDate and isDate', () => {
  // 03:00 UTC on Nov 21 is still Nov 20 in Hamilton County.
  assert.equal(A.localDate(Date.UTC(2026, 10, 21, 3, 0)), '2026-11-20');
  assert.equal(A.isDate('2026-02-29'), false);
  assert.equal(A.isDate('2028-02-29'), true);
  assert.equal(A.isDate(20261120), false);
});

test('cleared, then made active again: auditLive is quiet until the next publish, which ends "cleared"', async () => {
  const { env } = await finalNight();
  await env.svc.archiveElection(ADMIN, { electionId: EID, certifiedDate: '2026-11-20' });
  await env.svc.clearCurrentResults(ADMIN, { electionId: EID });
  await env.svc.upsertElection(ADMIN, SETTINGS); // makeActive
  assert.deepEqual(await env.svc.auditLive(ADMIN, { electionId: EID }), { ok: true, problems: [] });
  const d = await env.svc.createSettingsDraft(ADMIN, { electionId: EID });
  const doc = await env.db.get(paths.draft(EID, d.draftId));
  await env.svc.publishDraft(ADMIN, { electionId: EID, draftId: d.draftId, confirmCount: doc.confirmCount, acknowledged: doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key) });
  assert.equal((await env.db.get(paths.election(EID))).cleared, null);
  assert.equal((await env.svc.auditLive(ADMIN, { electionId: EID })).ok, true);
  // A real fault after that is reported again.
  await env.publicBucket.write('current/manifest.json', 'not json');
  assert.equal((await env.svc.auditLive(ADMIN, { electionId: EID })).ok, false);
  // And with "cleared" still set, a manifest that is not the no-election one is checked as usual.
  await env.db.update(paths.election(EID), { cleared: { at: 'x' } });
  assert.equal((await env.svc.auditLive(ADMIN, { electionId: EID })).ok, false);
});
