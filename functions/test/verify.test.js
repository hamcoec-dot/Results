'use strict';
// verify.js (oracle 2) must pass clean data and fail every kind of tampering.
const test = require('node:test');
const assert = require('node:assert/strict');
const { caseInputs } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { readCsv } = require('../src/csv');
const { verify } = require('../src/verify');

const { early, ed } = caseInputs('samples-92-04-10-reporting');
const earlyRows = readCsv(early);
const edRows = readCsv(ed);
const fresh = () => buildResults({ early, ed }, { lastUpdated: 'x' });

/** Verify a tampered copy of the published data.js `latest`, as a reader of the file would. */
function verifyTampered(tamper, { files } = {}) {
  const r = fresh();
  const latest = JSON.parse(r.outputs.files['data.js'].replace(/^[^=]*= /, '').replace(/;\n$/, '')).latest;
  tamper(latest);
  return verify({ earlyRows, edRows, latest, files: files ?? r.outputs.files });
}
const failures = (checks) => checks.filter((c) => !c.pass);
const failedNames = (checks) => [...new Set(failures(checks).map((c) => c.name))].sort();

test('clean data passes, read back from the published data.js', () => {
  const checks = verifyTampered(() => {});
  assert.deepEqual(failures(checks), []);
  assert.ok(checks.length > 300, `${checks.length} checks`);
});

test('a tampered candidate total fails', () => {
  const checks = verifyTampered((l) => { l.contests[0].candidates[0].votes += 1; });
  assert.deepEqual(failedNames(checks), ['candidateVotes']);
  assert.match(failures(checks)[0].detail, /^Candidate 'Marsha Blackburn' vote sum \(\d+ == \d+\) in 'Governor'$/);
});

test('a tampered precinct vote fails', () => {
  const checks = verifyTampered((l) => { l.contests[0].candidates[1].precinctVotes['TYNER'] += 5; });
  assert.deepEqual(failedNames(checks), ['precinctVotes']);
  assert.match(failures(checks)[0].detail, /^Precinct 'TYNER' vote for 'Jerri Green' in 'Governor' \(\d+ != \d+\)$/);
});

test('a wrong precincts-reporting count fails (the D1 overstatement would be caught)', () => {
  assert.deepEqual(failedNames(verifyTampered((l) => { l.contests[2].precinctsReporting = 92; })), ['precinctsReporting']);
  assert.deepEqual(failedNames(verifyTampered((l) => { l.contests[2].precinctsTotal = 91; })), ['precinctsTotal']);
});

test('a dropped contest fails presence and count', () => {
  assert.deepEqual(failedNames(verifyTampered((l) => { l.contests.pop(); })), ['contest', 'contestCount']);
});

test('tampered headline, metadata and precinct stats fail', () => {
  const cases = [
    [(l) => { l.totalVoters += 1; }, ['voters']], // turnout is checked against the CSV, not recomputed
    [(l) => { l.totalBallots -= 1; }, ['ballots']],
    [(l) => { l.turnoutPercent = 0; }, ['turnout']],
    [(l) => { l.electionTitle = 'x'; }, ['title']],
    [(l) => { l.electionDate = 'x'; }, ['date']],
    [(l) => { l.county = 'Marion'; }, ['county']],
    [(l) => { l.dataVersion = ''; }, ['dataVersion']],
    [(l) => { l.masterPrecincts = []; }, ['masterPrecincts']],
    [(l) => { l.precinctStats.TYNER.voters += 1; }, ['precinctVoters']],
    [(l) => { l.precinctStats.TYNER.ballots += 1; }, ['precinctBallots']],
    [(l) => { delete l.precinctStats.TYNER; }, ['precinctStats']],
  ];
  for (const [tamper, expected] of cases) assert.deepEqual(failedNames(verifyTampered(tamper)), expected, String(tamper));
});

test('a missing output file fails', () => {
  const r = fresh();
  const { 'summary.json': _s, ...files } = r.outputs.files;
  assert.deepEqual(failedNames(verifyTampered(() => {}, { files })), ['files']);
});

test('no CSV at all is a failure, not a crash', () => {
  assert.deepEqual(verify({ earlyRows: null, edRows: null, latest: {} }), [{ name: 'input', pass: false, detail: 'Missing primary CSV file' }]);
});

test('Early-only data verifies against the early file alone', () => {
  const r = buildResults({ early, ed: null }, { lastUpdated: 'x' });
  assert.deepEqual(failures(r.verify), []);
  assert.deepEqual(failures(verify({ earlyRows, edRows: null, latest: r.merged, files: r.outputs.files })), []);
});

test('legacy mode: partial reporting (a precinct missing from every contest) verifies, and its overrides are checked', () => {
  const { LEGACY } = require('../src/parse');
  const lines = ed.toString('utf8').split('\n');
  const body = lines.findIndex((l) => l.includes('Precincts Reporting')) + 2;
  const partial = Buffer.from(lines.slice(0, body).concat(lines.slice(body).filter((l) => !l.startsWith('AIRPORT A,'))).join('\n'));
  const r = buildResults({ early, ed: partial }, { fixes: LEGACY, lastUpdated: 'x' });
  const gov = r.merged.contests[0];
  assert.deepEqual([gov.precinctsReporting, r.merged.overallPrecinctsReporting], [91, 91]); // legacy: 91 listed precincts "reported"
  assert.deepEqual(failures(r.verify), []);
  const rows = readCsv(partial);
  const tampered = structuredClone(r.merged);
  tampered.contests[0].precinctsReporting = 10; // the CSV's own R, which legacy overrides
  const checks = verify({ earlyRows, edRows: rows, latest: tampered, files: r.outputs.files }, { fixes: LEGACY });
  assert.deepEqual(failedNames(checks), ['precinctsReporting']);
  tampered.contests[0].precinctsReporting = 92;
  assert.deepEqual(failedNames(verify({ earlyRows, edRows: rows, latest: tampered, files: r.outputs.files }, { fixes: LEGACY })), ['precinctsReporting']);
});
