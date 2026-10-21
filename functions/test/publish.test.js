'use strict';
// publish.js and upload.js: every refusal reason, the copy order, the manifest, the publish lease,
// draft lifetime, and upload decoding (sizes, gzip bombs, hashing).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const P = require('../src/publish');
const { decodeUpload, MAX_CSV_CHARS } = require('../src/upload');
const { validateFile } = require('../src/validate');

const NOW = Date.UTC(2026, 10, 4, 1, 45);
const HASHES = { 'summary.json': 'a'.repeat(64), 'data.js': 'b'.repeat(64) };
const draft = (over = {}) => ({
  status: 'ready',
  checks: [
    { key: 'close-race:0', id: 'close-race', severity: 'warn', title: 'Close races' },
    { key: 'summary:0', id: 'summary', severity: 'info', title: 'Size' },
  ],
  baseVersion: 'abc123abc123',
  expiresAt: NOW + 1000,
  outputSha256: HASHES,
  confirmCount: 10,
  ...over,
});
const OK = { election: { currentVersion: 'abc123abc123' }, acknowledged: ['close-race:0'], confirmCount: 10, now: NOW, rehashed: HASHES };
const codes = (r) => r.map((x) => x.code);

test('publish: a clean, acknowledged, fresh, untampered draft may publish', () => {
  assert.deepEqual(P.publishRefusals({ draft: draft(), ...OK }), []);
  assert.deepEqual(P.publishRefusals({ draft: draft(), ...OK, rehashed: null }), []); // before re-reading
});

test('publish: every refusal reason', () => {
  const cases = [
    [{ draft: null }, ['not-found']],
    [{ draft: draft({ status: 'published' }) }, ['not-ready']],
    [{ draft: draft({ status: 'blocked', checks: [{ key: 'verify-failed:0', severity: 'block', title: 'Verify failed' }] }) }, ['not-ready', 'blocked']],
    [{ acknowledged: [] }, ['unacknowledged']],
    [{ acknowledged: ['close-race:1'] }, ['unacknowledged']],
    [{ election: { currentVersion: 'fff000fff000' } }, ['stale']],
    [{ election: {} }, ['stale']],
    [{ now: NOW + 1000 }, ['expired']],
    [{ confirmCount: 92 }, ['confirm-mismatch']],
    [{ confirmCount: '10' }, ['confirm-mismatch']],
    [{ rehashed: { ...HASHES, 'data.js': 'c'.repeat(64) } }, ['tampered']],
    [{ rehashed: { 'summary.json': HASHES['summary.json'] } }, ['tampered']],
  ];
  for (const [over, want] of cases) {
    const r = P.publishRefusals({ draft: draft(), ...OK, ...over });
    assert.deepEqual(codes(r), want, JSON.stringify(over));
    assert.ok(r.every((x) => typeof x.detail === 'string' && x.detail.length > 5));
  }
  const first = P.publishRefusals({ draft: draft({ baseVersion: null }), ...OK, election: { currentVersion: null } });
  assert.deepEqual(first, [], 'first publish: no base, nothing current');
  const detail = P.publishRefusals({ draft: draft(), ...OK, acknowledged: [] })[0].detail;
  assert.match(detail, /close-race:0/);
});

test('extend: only integrity rules; expired drafts can be extended', () => {
  assert.deepEqual(codes(P.extendRefusals({ draft: draft({ expiresAt: NOW - 5 * P.DRAFT_TTL_MS }), election: OK.election, now: NOW, rehashed: HASHES })), []);
  assert.deepEqual(codes(P.extendRefusals({ draft: draft(), election: { currentVersion: 'x' }, now: NOW, rehashed: HASHES })), ['stale']);
  assert.deepEqual(codes(P.extendRefusals({ draft: draft(), election: OK.election, now: NOW, rehashed: {} })), ['tampered']);
  assert.deepEqual(codes(P.extendRefusals({ draft: null, election: OK.election, now: NOW })), ['not-found']);
  assert.deepEqual(codes(P.extendRefusals({ draft: draft({ status: 'discarded' }), election: OK.election, now: NOW })), ['not-ready']);
  assert.equal(P.expiryFrom(NOW), NOW + 2 * 3600 * 1000);
});

test('copy plan: archive first, then data files, then summary (the manifest is written after)', () => {
  const id = P.newDraftId();
  const plan = P.copyPlan({ electionId: '2026-11-03-general', draftId: id, dataVersion: '0123456789ab' });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan[0].map((s) => s.to), ['precincts.json', 'reporting.json', 'data.js', 'summary.json']
    .map((f) => `elections/2026-11-03-general/v/0123456789ab/${f}`));
  assert.ok(plan[0].every((s) => s.from.startsWith(`drafts/${id}/`) && /immutable/.test(s.cacheControl)));
  assert.deepEqual(plan.slice(1).map((st) => st.map((s) => s.to)), [['current/precincts.json', 'current/reporting.json', 'current/data.js'], ['current/summary.json']]);
  assert.equal(P.versionPath('e1', '0123456789ab', 'x.json'), 'elections/e1/v/0123456789ab/x.json');
  assert.ok(plan.slice(1).flat().every((s) => s.cacheControl === 'public, max-age=15' && s.from.includes('/v/0123456789ab/')));
  for (const bad of [{ electionId: '../x' }, { draftId: 'nothex' }, { dataVersion: 'zz' }, { electionId: 'A' }]) {
    assert.throws(() => P.copyPlan({ electionId: 'e', draftId: id, dataVersion: '0123456789ab', ...bad }), TypeError);
  }
});

test('ids', () => {
  const a = P.newDraftId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, P.newDraftId());
  assert.ok(P.isDraftId(a) && !P.isDraftId(a.toUpperCase()) && !P.isDraftId(`${a}0`) && !P.isDraftId(5));
  assert.ok(P.isElectionId('2026-11-03-general') && !P.isElectionId('-x') && !P.isElectionId('a/b') && !P.isElectionId('x'.repeat(64)));
});

test('manifest: sha256 of every published file, valid for the pages', () => {
  const files = { 'summary.json': '{"a":1}', 'reporting.json': '{}', 'precincts.json': '[]', 'data.js': 'x' };
  const m = P.buildManifest(files, { dataVersion: '0123456789ab', updatedAt: '2026-11-04T01:45:00.000Z' });
  assert.deepEqual(Object.keys(m.files), ['precincts.json', 'reporting.json', 'data.js', 'summary.json']);
  assert.equal(m.files['summary.json'], P.sha256Hex('{"a":1}'));
  assert.equal(P.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.deepEqual(validateFile('manifest.json', m).errors, []);
  assert.deepEqual(Object.keys(P.buildManifest({ 'summary.json': '' }, m).files), ['summary.json']);
});

test('publish lease: one holder at a time; expired leases can be taken; release only your own', () => {
  const a = P.acquireLock(null, { holder: 'A', now: NOW });
  assert.deepEqual(a, { holder: 'A', until: NOW + P.LOCK_TTL_MS });
  assert.throws(() => P.acquireLock(a, { holder: 'B', now: NOW + 1 }), (e) => e.code === 'busy');
  assert.deepEqual(P.acquireLock(a, { holder: 'A', now: NOW + 5 }), { holder: 'A', until: NOW + 5 + P.LOCK_TTL_MS }); // re-entrant
  assert.deepEqual(P.acquireLock(a, { holder: 'B', now: a.until }), { holder: 'B', until: a.until + P.LOCK_TTL_MS }); // expired
  assert.equal(P.releaseLock(a, { holder: 'A' }), null);
  assert.equal(P.releaseLock(a, { holder: 'B' }), a);
  assert.equal(P.releaseLock(null, { holder: 'A' }), null);
});

test('upload: text and gzip decode to the same text and hash', () => {
  const text = 'Custom Table Report,,UNOFFICIAL\nx,y\n';
  const plain = decodeUpload({ kind: 'ed', filename: ' 03.CSV ', csv: text, lastModified: 1234 });
  const gz = decodeUpload({ kind: 'ed', filename: '03.csv', csvGzipBase64: zlib.gzipSync(text).toString('base64') });
  assert.equal(plain.text, text);
  assert.equal(gz.text, text);
  assert.equal(plain.sha256, gz.sha256);
  assert.equal(plain.sha256, P.sha256Hex(text));
  assert.deepEqual([plain.filename, plain.size, plain.lastModified, gz.lastModified], ['03.CSV', text.length, 1234, null]);
  assert.equal(decodeUpload({ kind: 'zero', filename: 'é.csv', csv: 'é' }).size, 2);
});

test('upload: refusals', () => {
  const bad = (data, code, re) => assert.throws(() => decodeUpload(data), (e) => e.name === 'UploadError' && e.code === code && re.test(e.message), JSON.stringify(data).slice(0, 80));
  const base = { kind: 'ed', filename: 'a.csv', csv: 'x' };
  bad(null, 'invalid-argument', /No upload/);
  bad({ ...base, kind: 'final' }, 'invalid-argument', /Choose Zero/);
  bad({ ...base, filename: '' }, 'invalid-argument', /file name/);
  bad({ ...base, filename: 5 }, 'invalid-argument', /file name/);
  bad({ ...base, filename: `${'a'.repeat(200)}.csv` }, 'invalid-argument', /file name/);
  bad({ ...base, filename: 'a.xlsx' }, 'invalid-argument', /\.csv/);
  bad({ kind: 'ed', filename: 'a.csv' }, 'invalid-argument', /once/);
  bad({ ...base, csvGzipBase64: 'AAAA' }, 'invalid-argument', /once/);
  bad({ ...base, csv: 7 }, 'invalid-argument', /text/);
  bad({ ...base, csv: '' }, 'invalid-argument', /empty/);
  bad({ ...base, csv: 'x'.repeat(MAX_CSV_CHARS + 1) }, 'too-large', /over 5,000,000/);
  const gz = { kind: 'ed', filename: 'a.csv' };
  bad({ ...gz, csvGzipBase64: 'not base64!' }, 'invalid-argument', /not base64/);
  bad({ ...gz, csvGzipBase64: Buffer.from('plain').toString('base64') }, 'invalid-argument', /could not be read/);
  bad({ ...gz, csvGzipBase64: 'A'.repeat(4_000_004) }, 'too-large', /too large/);
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_CSV_CHARS * 4 + 1, 0x41)).toString('base64');
  bad({ ...gz, csvGzipBase64: bomb }, 'too-large', /too large/);
  const justOver = zlib.gzipSync('x'.repeat(MAX_CSV_CHARS + 1)).toString('base64');
  bad({ ...gz, csvGzipBase64: justOver }, 'too-large', /over/);
  assert.equal(decodeUpload({ ...base, csv: 'x'.repeat(MAX_CSV_CHARS) }).text.length, MAX_CSV_CHARS);
});
