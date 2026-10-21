'use strict';
// Post-election records export (records.js) and its ZIP writer (zip.js). The archive is read back by
// a small reader here and, where Python is installed, by Python's zipfile (an independent oracle).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { REPO, pythonAvailable } = require('./helpers/fixtures');
const { MemoryDb, MemoryBucket, clock } = require('./helpers/fakes');
const { createService, paths } = require('../src/service');
const { sha256Hex, versionPath } = require('../src/publish');
const { buildZip, crc32 } = require('../src/zip');
const { exportElectionRecords } = require('../src/records');

const EID = '2026-11-03-general';
const ADMIN = { uid: 'u1', email: 'admin@example.gov' };
const SAMPLE = (n) => fs.readFileSync(path.join(REPO, 'Test_Files', 'Web Results Samples', `${n} (92).csv`), 'utf8');

/** Read a zip produced by buildZip: {name: Buffer}, checking every CRC. */
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const local = buf.readUInt32LE(p + 42);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + size));
    assert.equal(crc32(data), crc, `${name}: CRC`);
    out[name] = data;
    p += 46 + nameLen;
  }
  return out;
}

async function election() {
  const db = new MemoryDb();
  const publicBucket = new MemoryBucket();
  const privateBucket = new MemoryBucket();
  const now = clock();
  const svc = createService({ db, publicBucket, privateBucket, now, fetchLive: (p) => publicBucket.read(p) });
  await svc.upsertElection(ADMIN, { id: EID, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 92, enablePrecinctResults: true, makeActive: true });
  const versions = [];
  for (const [kind, name] of [['early', '02-After EV'], ['ed', '03-After 5 Reporting']]) {
    const r = await svc.createDraft(ADMIN, { electionId: EID, kind, filename: `${name}.csv`, csv: SAMPLE(name) });
    const doc = await db.get(paths.draft(EID, r.draftId));
    const acknowledged = doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key);
    versions.push((await svc.publishDraft(ADMIN, { electionId: EID, draftId: r.draftId, acknowledged, confirmCount: doc.confirmCount })).dataVersion);
  }
  // One draft never published.
  await svc.createDraft(ADMIN, { electionId: EID, kind: 'ed', filename: '04.csv', csv: SAMPLE('04-After 10 Reporting') });
  return { db, publicBucket, privateBucket, now, versions };
}

test('records export: every version as served, its record and acknowledgements, drafts, raw uploads, audit, checksums', async () => {
  const env = await election();
  const { zip, entries, missing } = await exportElectionRecords(env, EID, { by: 'clerk@example.gov' });
  assert.deepEqual(missing, []);
  const files = readZip(zip);
  assert.deepEqual(Object.keys(files), entries);
  assert.equal(entries[0], 'README.txt');
  assert.equal(entries.at(-1), 'SHA256SUMS');

  for (const v of env.versions) {
    for (const f of ['summary.json', 'reporting.json', 'precincts.json', 'data.js', 'manifest.json']) {
      assert.deepEqual(files[`versions/${v}/${f}`], await env.publicBucket.read(versionPath(EID, v, f)), `${v}/${f} is byte-identical`);
    }
    const record = JSON.parse(files[`versions/${v}/record.json`]);
    assert.equal(record.dataVersion, v);
    assert.equal(record.publishedBy, ADMIN.email);
    assert.ok(Array.isArray(record.acknowledgements));
  }
  const drafts = entries.filter((n) => n.startsWith('drafts/'));
  assert.equal(drafts.length, 3);
  const published = drafts.map((n) => JSON.parse(files[n])).filter((d) => d.status === 'published');
  assert.equal(published.length, 2);
  for (const d of published) for (const a of d.acknowledgements) assert.deepEqual(Object.keys(a).sort(), ['at', 'by', 'key']);

  const csvs = entries.filter((n) => n.endsWith('.csv'));
  assert.equal(csvs.length, 3);
  assert.ok(csvs.map((n) => files[n].toString('utf8')).includes(SAMPLE('02-After EV')));

  const audit = JSON.parse(files['audit.json']);
  assert.ok(audit.length >= 5);
  assert.ok(audit.every((a) => a.eid === EID));
  assert.deepEqual(audit.map((a) => a.at), [...audit.map((a) => a.at)].sort());

  const sums = files.SHA256SUMS.toString('utf8').trim().split('\n');
  assert.equal(sums.length, entries.length - 1);
  for (const line of sums) {
    const [hash, name] = line.split('  ');
    assert.equal(sha256Hex(files[name]), hash, name);
  }
  const readme = files['README.txt'].toString('utf8');
  assert.match(readme, /2 published version\(s\), 3 draft record\(s\), 3 uploaded file\(s\)/);
  assert.match(readme, /by clerk@example\.gov/);
  assert.doesNotMatch(readme, /MISSING/);
});

test('records export: an object a record names but storage lacks is listed, not silently skipped', async () => {
  const env = await election();
  const object = versionPath(EID, env.versions[0], 'data.js');
  await env.publicBucket.deletePrefix(object);
  const up = (await env.db.list(paths.uploads(EID)))[0];
  await env.privateBucket.deletePrefix(up.data.storagePath);
  const { zip, missing } = await exportElectionRecords(env, EID);
  assert.deepEqual(missing.sort(), [object, up.data.storagePath].sort());
  assert.match(readZip(zip)['README.txt'].toString('utf8'), new RegExp(`MISSING[^\\n]*: 2\\n  .*\\n  .*`));
});

test('records export: refuses a bad or unknown election id', async () => {
  const env = await election();
  await assert.rejects(exportElectionRecords(env, '../etc'), TypeError);
  await assert.rejects(exportElectionRecords(env, 'no-such-election'), /No election no-such-election/);
});

test('zip: entries round-trip with CRCs; names are checked; an empty archive is valid', () => {
  const entries = [{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255]) }, { name: 'ünï.txt', data: '' }];
  const files = readZip(buildZip(entries, { date: new Date(2026, 10, 3, 21, 42, 30) }));
  assert.deepEqual(Object.keys(files), ['a.txt', 'dir/b.bin', 'ünï.txt']);
  assert.equal(files['a.txt'].toString(), 'hello');
  assert.deepEqual([...files['dir/b.bin']], [0, 1, 2, 255]);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926); // the CRC-32 check value
  for (const name of ['', '/abs', 'a/../b', 'a\\b']) assert.throws(() => buildZip([{ name, data: 'x' }]), TypeError, JSON.stringify(name));
  assert.throws(() => buildZip([{ name: 'x', data: '1' }, { name: 'x', data: '2' }]), /duplicate/);
  assert.equal(buildZip([]).length, 22);
  assert.deepEqual(readZip(buildZip([], { date: new Date(1970, 0, 1) })), {}); // dates before 1980 clamp
});

test('zip: Python zipfile reads the export and every CRC checks', { skip: !pythonAvailable() && 'python not found' }, async () => {
  const env = await election();
  const { zip, entries } = await exportElectionRecords(env, EID);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'records-')), 'export.zip');
  fs.writeFileSync(file, zip);
  const py = process.env.PYTHON || 'python';
  const out = JSON.parse(execFileSync(py, ['-c', [
    'import json, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'print(json.dumps({"bad": z.testzip(), "names": z.namelist()}))',
  ].join('\n'), file], { encoding: 'utf8' }));
  assert.equal(out.bad, null);
  assert.deepEqual(out.names, entries);
});

test('records export: a bare election (one audit entry, an upload record without a stored file)', async () => {
  const db = new MemoryDb();
  const bucket = new MemoryBucket();
  await db.set(`elections/${EID}`, { name: 'Bare', currentVersion: null });
  await db.set(`elections/${EID}/uploads/u2`, { kind: 'early', filename: 'b.csv' });
  await db.set(`elections/${EID}/uploads/u1`, { kind: 'early', filename: 'a.csv' });
  await db.set('audit/a2', { eid: EID, at: '2026-11-03T20:00:00Z', action: 'x' });
  await db.set('audit/a1', { eid: 'other-election', at: '2026-11-03T19:00:00Z', action: 'y' });
  const { zip, entries, missing } = await exportElectionRecords({ db, publicBucket: bucket, privateBucket: bucket, now: () => 0 }, EID);
  assert.deepEqual(missing, ['uploads/u1 (no storagePath)', 'uploads/u2 (no storagePath)']);
  assert.deepEqual(entries.filter((n) => n.startsWith('uploads/')), ['uploads/u1.json', 'uploads/u2.json']);
  const readme = readZip(zip)['README.txt'].toString('utf8');
  assert.match(readme, /0 published version\(s\), 0 draft record\(s\), 0 uploaded file\(s\), 1 audit entry\./);
  assert.match(readme, /Current version: none\./);
  assert.match(readme, /by unknown/);
});
