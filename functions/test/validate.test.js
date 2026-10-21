'use strict';
// validate.js: every real output is valid; every kind of corruption is caught; the manifest set check.
const test = require('node:test');
const assert = require('node:assert/strict');
const { goldenCases, caseInputs } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { validateFile, validateSet, MAX_ERRORS } = require('../src/validate');

const FILES = ['summary.json', 'reporting.json', 'precincts.json'];
const build = (id = 'samples-92-04-10-reporting', opts = {}) => {
  const { early, ed } = caseInputs(id);
  const r = buildResults({ early, ed }, { lastUpdated: 'x', ...opts });
  return Object.fromEntries(FILES.map((f) => [f, JSON.parse(r.outputs.files[f])]));
};
const manifestOf = (files) => ({
  dataVersion: files['summary.json'].metadata.dataVersion,
  updatedAt: '2026-11-04T01:45:00Z',
  files: Object.fromEntries(FILES.map((f) => [f, 'a'.repeat(64)])),
});

test('every golden case, at its own precinct count, validates', () => {
  for (const id of goldenCases()) {
    const files = build(id, { precinctCap: id.includes('-94-') ? 94 : 92 });
    for (const f of FILES) assert.deepEqual(validateFile(f, files[f]).errors, [], `${id} ${f}`);
    assert.ok(validateSet(manifestOf(files), files).ok, id);
  }
});

/** Each corruption must be caught, with an error naming the path. */
const CORRUPTIONS = [
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].votes += 1; }, /candidate votes add up to/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].votes = -1; }, /votes: expected a whole number/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].votes = 1.5; }, /whole number/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].votes = 'NaN'; }, /whole number/],
  ['summary.json', (d) => { d.latest.contests[0].totalVotes = null; }, /totalVotes/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].percentage = 101; }, /percentage: over 100/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].percentage = -1; }, /percentage/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].party = 'GRN'; }, /unexpected party/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].isLeading = 1; }, /isLeading/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0].name = 42; }, /name: expected text/],
  ['summary.json', (d) => { d.latest.contests[0].candidates.push({ ...d.latest.contests[0].candidates[0], votes: 0 }); }, /duplicate candidate/],
  ['summary.json', (d) => { d.latest.contests[0].candidates = {}; }, /candidates: expected a list/],
  ['summary.json', (d) => { d.latest.contests[0].candidates[0] = null; }, /expected an object/],
  ['summary.json', (d) => { d.latest.contests.push(d.latest.contests[0]); }, /duplicate contest/],
  ['summary.json', (d) => { d.latest.contests[0].precinctsReporting = 93; }, /is more than the total/],
  ['summary.json', (d) => { d.latest.contests[1] = 'x'; }, /contests\[1\]: expected an object/],
  ['summary.json', (d) => { d.latest.contests = null; }, /latest.contests: expected a list/],
  ['summary.json', (d) => { d.latest.overallPrecinctsReporting = 99; }, /overall precincts reporting/],
  ['summary.json', (d) => { d.latest.totalBallots = Infinity; }, /totalBallots/],
  ['summary.json', (d) => { d.latest.turnoutPercent = '5%'; }, /turnoutPercent/],
  ['summary.json', (d) => { d.latest = []; }, /latest: expected an object/],
  ['summary.json', (d) => { d.metadata.dataVersion = 'abc'; }, /dataVersion: expected 12 hex/],
  ['summary.json', (d) => { d.metadata.lastUpdated = 5; }, /lastUpdated/],
  ['summary.json', (d) => { delete d.metadata; }, /metadata: expected an object/],
  ['summary.json', (d) => { d.config = null; }, /config/],
  ['reporting.json', (d) => { d.latest.contests[0].precinctsStatusIndexed[0] = [0, 2]; }, /expected \[index, 0\|1\]/],
  ['reporting.json', (d) => { d.latest.contests[0].precinctsStatusIndexed[0] = [999, 0]; }, /index out of range/],
  ['reporting.json', (d) => { d.latest.contests[0].precinctsStatusIndexed[0] = [-1, 0]; }, /whole number/],
  ['reporting.json', (d) => { d.latest.contests[0].precinctsStatusIndexed.forEach((p) => { p[1] = 1; }); }, /flagged reported, count says 10/],
  ['reporting.json', (d) => { d.latest.contests[0].precinctsStatusIndexed = 'x'; }, /expected a list/],
  ['reporting.json', (d) => { d.masterPrecincts = null; }, /masterPrecincts: expected a list/],
  ['reporting.json', (d) => { d.latest.overallPrecinctsTotal = -2; }, /overallPrecinctsTotal/],
  ['precincts.json', (d) => { d.precinctStats.TYNER.voters = -5; }, /precinctStats\["TYNER"\].voters/],
  ['precincts.json', (d) => { d.precinctStats.TYNER.turnoutPercent = null; }, /turnoutPercent/],
  ['precincts.json', (d) => { d.precinctStats.TYNER = 7; }, /expected an object/],
  ['precincts.json', (d) => { d.precinctStats = []; }, /precinctStats: expected an object/],
  ['precincts.json', (d) => { d.contests[0].candidates[0].precinctVotes.TYNER = 2.5; }, /precinctVotes\["TYNER"\]/],
  ['precincts.json', (d) => { d.contests[0].candidates[0].precinctVotes = null; }, /precinctVotes: expected an object/],
  ['precincts.json', (d) => { d.contests[0].candidates[0].votes += 3; }, /add up to/],
];

test('every corruption is caught', () => {
  const clean = build();
  for (const [file, corrupt, message] of CORRUPTIONS) {
    const d = structuredClone(clean[file]);
    corrupt(d);
    const res = validateFile(file, d);
    assert.equal(res.ok, false, `${file}: ${corrupt}`);
    assert.ok(res.errors.some((e) => message.test(e)), `${corrupt}\n${res.errors.join('\n')}`);
  }
});

test('wrong input types', () => {
  assert.deepEqual(validateFile('other.json', {}).errors, ['other.json: unknown file']);
  assert.deepEqual(validateFile('summary.json', []).errors, ['summary.json: expected a JSON object']);
  assert.deepEqual(validateFile('summary.json', null).errors, ['summary.json: expected a JSON object']);
  const many = { metadata: {}, config: {}, latest: { contests: Array.from({ length: 80 }, () => null) } };
  assert.equal(validateFile('summary.json', many).errors.length, MAX_ERRORS);
});

test('manifest and set: every file must carry the manifest dataVersion', () => {
  const files = build();
  const m = manifestOf(files);
  assert.deepEqual(validateSet(m, files), { ok: true, errors: [] });
  assert.deepEqual(validateSet(m, { 'summary.json': files['summary.json'] }), { ok: true, errors: [] });

  const stale = structuredClone(files);
  stale['reporting.json'] = build('samples-92-03-5-reporting')['reporting.json']; // read during the copy window
  assert.match(validateSet(m, stale).errors.join('\n'), /reporting.json: dataVersion \w+ does not match the manifest/);

  for (const [bad, re] of [[{ ...m, dataVersion: 'x' }, /dataVersion/], [{ ...m, files: { 'a.json': 'nope' } }, /files.a.json: expected a sha256/],
    [{ ...m, files: null }, /files: expected an object/], [{ ...m, updatedAt: 1 }, /updatedAt/]]) {
    const res = validateSet(bad, files);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), re);
  }
  // A broken manifest is reported once, not as a mismatch in every file.
  assert.ok(!validateSet({ ...m, dataVersion: 'x' }, files).errors.some((e) => /does not match/.test(e)));
});

test('runs in a browser-like global without module', () => {
  const vm = require('node:vm');
  const src = require('node:fs').readFileSync(require.resolve('../src/validate'), 'utf8');
  const ctx = { self: {} };
  vm.runInNewContext(src, ctx);
  assert.equal(typeof ctx.self.ResultsValidate.validateFile, 'function');
});
