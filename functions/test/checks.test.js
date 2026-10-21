'use strict';
// checks.js: every check id fires exactly when its condition holds (one test each; the last test
// fails if any id in CHECK_IDS was never triggered), and the real 00 -> 06 night has no blocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { caseInputs } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { readCsv, CsvError } = require('../src/csv');
const { runChecks, runRollbackChecks, unreadableCheck, normalizeDate, closeMargin, CHECK_IDS, REPORTING_MISMATCH_SEVERITY } = require('../src/checks');

const ELECTION = { name: '2026-11-03 General', date: '2026-11-03', precinctCap: 92 };
const S = (id) => caseInputs(`samples-92-${id}`);
const EV = S('02-ev').early;
const ED3 = S('03-5-reporting').ed;
const ED4 = S('04-10-reporting').ed;
const text = (b) => b.toString('utf8');

/** Run the pipeline + checks for one upload of `kind` (ED uploads pair with the 02-ev Early file). */
function check(kind, file, { early = EV, current = null, election = ELECTION, upload = { sha256: 'abc' }, history, tamper } = {}) {
  const input = kind === 'ed' ? { early, ed: file } : { early: file, ed: null };
  let result = buildResults(input, { precinctCap: election.precinctCap, lastUpdated: 'x' });
  if (tamper) result = tamper(result);
  return runChecks({ kind, rows: readCsv(file), result, current, election, upload, history });
}
const currentOf = (kind, file, early = EV) => buildResults(kind === 'ed' ? { early, ed: file } : { early: file, ed: null }, { lastUpdated: 'x' }).merged;
const clone = (x) => structuredClone(x);

const triggered = new Set();
/** Assert `id` is among the checks with `severity`; returns those checks. */
function fires(checks, id, severity) {
  const hits = checks.filter((c) => c.id === id);
  assert.ok(hits.length, `${id} did not fire; got ${checks.map((c) => c.id).join(', ')}`);
  for (const h of hits) assert.equal(h.severity, severity, `${id} severity`);
  triggered.add(id);
  return hits;
}
const silent = (checks, id) => assert.ok(!checks.some((c) => c.id === id), `${id} fired unexpectedly`);
const ids = (checks) => checks.map((c) => c.id);

test('the real election night 00 -> 06 has no blocks; the clean ED draft has only close races', () => {
  const steps = [['zero', S('00-zero').early], ['early', S('01-nh-abs').early], ['early', EV], ['ed', ED3], ['ed', ED4],
    ['ed', S('05-end-ed').ed], ['ed', S('06-end-provisional').ed]];
  let current = null;
  for (const [kind, file] of steps) {
    const checks = check(kind, file, { current });
    assert.deepEqual(checks.filter((c) => c.severity === 'block'), [], kind);
    current = currentOf(kind, file);
  }
  const checks = check('ed', ED4, { current: currentOf('ed', ED3) });
  assert.deepEqual([...new Set(ids(checks))], ['close-race', 'summary']);
});

test('keys are unique and blocks come first', () => {
  const checks = check('ed', ED3, { election: { ...ELECTION, name: 'x', precinctCap: 4 } });
  assert.equal(new Set(checks.map((c) => c.key)).size, checks.length);
  const sev = checks.map((c) => c.severity);
  assert.deepEqual(sev, sev.slice().sort((a, b) => ['block', 'warn', 'info'].indexOf(a) - ['block', 'warn', 'info'].indexOf(b)));
  assert.match(checks[0].key, /^[a-z-]+:\d+$/);
  assert.throws(() => runChecks({ kind: 'final', rows: [], result: null, election: ELECTION, upload: {} }), TypeError);
});

test('unreadable', () => {
  const c = unreadableCheck(new CsvError('field larger than field limit (131072)', 9));
  assert.deepEqual([c.key, c.id, c.severity], ['unreadable:0', 'unreadable', 'block']);
  assert.match(c.detail, /line 9/);
  triggered.add('unreadable');
  const short = runChecks({ kind: 'ed', rows: readCsv('Custom Table Report\na\nb'), result: null, election: ELECTION, upload: { sha256: 'x' } });
  assert.deepEqual(ids(short), ['unreadable']);
});

test('not-custom-table-report', () => {
  fires(check('ed', text(ED3).replace(/^Custom Table Report/, 'Summary Report')), 'not-custom-table-report', 'block');
});

test('no-contests', () => {
  fires(check('ed', text(ED3).replaceAll('Precincts Reporting', 'Precincts Counted')), 'no-contests', 'block');
});

test('no-statistics', () => {
  const checks = check('ed', text(ED3).replaceAll('STATISTICS', 'TURNOUT'));
  fires(checks, 'no-statistics', 'block');
});

test('verify-failed', () => {
  const tamper = (r) => ({ ...r, verify: [...r.verify, { name: 'x', pass: false, detail: "Candidate 'A' vote sum (1 == 2) in 'B'" }] });
  const [c] = fires(check('ed', ED3, { tamper }), 'verify-failed', 'block');
  assert.match(c.detail, /vote sum/);
  const many = (r) => ({ ...r, verify: Array.from({ length: 25 }, (_, i) => ({ pass: false, detail: `f${i}` })) });
  assert.match(fires(check('ed', ED3, { tamper: many }), 'verify-failed', 'block')[0].detail, /and 5 more$/);
});

test('output-invalid: files the pages would reject are never published', () => {
  const tamper = (r) => {
    const summary = JSON.parse(r.outputs.files['summary.json']);
    summary.latest.contests[0].candidates[0].votes += 1;
    return { ...r, outputs: { ...r.outputs, files: { ...r.outputs.files, 'summary.json': JSON.stringify(summary) } } };
  };
  const [c] = fires(check('ed', ED3, { tamper }), 'output-invalid', 'block');
  assert.match(c.detail, /^summary.json latest.contests\[0\]: candidate votes add up to/);
  // A 94-precinct file under max precincts 92: count capped at 92 but 94 flags -> blocked twice over.
  const t = caseInputs('samples-94-06-end-provisional');
  const capped = check('ed', t.ed, { early: t.early });
  fires(capped, 'output-invalid', 'block');
  fires(capped, 'reporting-over-cap', 'block');
});

test('date-mismatch and date-unreadable', () => {
  fires(check('ed', ED3, { election: { ...ELECTION, date: '2026-11-04' } }), 'date-mismatch', 'block');
  fires(check('ed', ED3, { election: { ...ELECTION, date: 'Election Day' } }), 'date-unreadable', 'warn');
  silent(check('ed', ED3), 'date-mismatch');
});

test('normalizeDate reads every export style', () => {
  for (const [s, d] of [['November 3, 2026', '2026-11-03'], ['Nov. 3 2026', '2026-11-03'], ['6-Aug-26', '2026-08-06'], ['06-AUG-2026', '2026-08-06'],
    ['2026-08-06', '2026-08-06'], ['8/6/2026', '2026-08-06'], ['8/6/26', '2026-08-06'], ['February 30, 2026', null], ['Ma 3, 2026', null],
    ['13/1/2026', null], ['', null], [undefined, null], ['someday', null]]) {
    assert.equal(normalizeDate(s), d, String(s));
  }
});

test('reporting-over-cap and reporting-over-total', () => {
  fires(check('ed', ED3, { election: { ...ELECTION, precinctCap: 4 } }), 'reporting-over-cap', 'block');
  const over = text(ED3).replace(',5 of 92 Precincts Reporting,', ',95 of 92 Precincts Reporting,');
  fires(check('ed', over, { election: { ...ELECTION, precinctCap: 999 } }), 'reporting-over-total', 'block');
});

test('reporting-inconsistent: page headers of one contest disagree', () => {
  const pages = text(ED3).split(',5 of 92 Precincts Reporting,');
  assert.ok(pages.length > 3);
  const edited = pages[0] + ',7 of 92 Precincts Reporting,' + pages.slice(1).join(',5 of 92 Precincts Reporting,');
  const [c] = fires(check('ed', edited), 'reporting-inconsistent', 'block');
  assert.match(c.detail, /^Governor: 7 of 92 vs 5 of 92./);
});

test('reporting-mismatch is a warning that must be acknowledged', () => {
  assert.equal(REPORTING_MISMATCH_SEVERITY, 'warn');
  const six = text(ED3).replace(',5 of 92 Precincts Reporting,', ',6 of 92 Precincts Reporting,');
  const [c] = fires(check('ed', six), 'reporting-mismatch', REPORTING_MISMATCH_SEVERITY);
  assert.match(c.detail, /^Governor: the file says 6 reporting, but 5 precinct\(s\) show new votes: SIGNAL MOUNTAIN A, /);
  assert.deepEqual(c.refs, [{ contest: 'Governor' }]);
});

test('negative-votes and non-numeric-cell', () => {
  const at = (v) => text(ED3).replace('COLLEGEDALE B,7,14,', `COLLEGEDALE B,${v},14,`);
  const [neg] = fires(check('ed', at('-7')), 'negative-votes', 'block');
  assert.match(neg.detail, /row \d+, column 2: "-7"/);
  fires(check('ed', at('7.5')), 'non-numeric-cell', 'block');
  fires(check('ed', at('n/a')), 'non-numeric-cell', 'block');
  fires(check('ed', text(ED3).replace(/\nTotals,65,130,/, '\nTotals,6x5,130,')), 'non-numeric-cell', 'block');
  silent(check('ed', at('"1,007"')), 'non-numeric-cell');
});

test('zero-file-has-votes', () => {
  fires(check('zero', EV), 'zero-file-has-votes', 'block');
  silent(check('zero', S('00-zero').early), 'zero-file-has-votes');
});

test('title-mismatch and precinct-count', () => {
  fires(check('ed', ED3, { election: { ...ELECTION, name: '2026 General' } }), 'title-mismatch', 'warn');
  silent(check('ed', ED3, { election: { ...ELECTION, name: ' 2026-11-03 GENERAL ' } }), 'title-mismatch');
  fires(check('ed', ED3, { election: { ...ELECTION, precinctCap: 94 } }), 'precinct-count', 'warn');
});

test('overvote and ballots-over-registered are warnings (real 8-column exports trip them)', () => {
  const t = caseInputs('testfiles-ev-ed');
  const election = { name: '2026-08-06 State Primary & County General', date: '2026-08-06', precinctCap: 93 };
  const [ov] = fires(check('ed', t.ed, { early: t.early, election }), 'overvote', 'warn');
  assert.equal(ov.refs.length, 5);
  fires(check('early', t.early, { election }), 'ballots-over-registered', 'warn');
});

test('turnout-high (county over 100 %, precinct over 95 %)', () => {
  const hot = text(ED3).replace(',COLLEGEDALE B,"1,051",161,', ',COLLEGEDALE B,165,161,');
  assert.match(fires(check('ed', hot), 'turnout-high', 'warn')[0].detail, /COLLEGEDALE B: 97\.58 %/);
  const county = text(ED3).replace('Totals,"231,431","1,516"', 'Totals,"1,000","1,516"');
  // totalVoters is the larger of the two slots' counts, so this one runs without the Early file.
  assert.ok(fires(check('ed', county, { early: null }), 'turnout-high', 'warn').some((c) => /County turnout 151\.6 %/.test(c.detail)));
});

test('ed-none-reporting and early-has-reporting', () => {
  fires(check('ed', EV), 'ed-none-reporting', 'warn');
  fires(check('early', ED3), 'early-has-reporting', 'warn');
  assert.match(fires(check('zero', ED3), 'early-has-reporting', 'warn')[0].title, /^Zero file/);
});

test('close-race is one grouped warning', () => {
  const [c] = fires(check('ed', ED3), 'close-race', 'warn');
  assert.ok(c.refs.length > 1);
  assert.equal(c.detail.split('\n').length, c.refs.length);
  const contest = (votes, voteFor = 'VOTE FOR 1') => ({ voteFor, totalVotes: votes.reduce((a, b) => a + b, 0), candidates: votes.map((v) => ({ votes: v })) });
  assert.equal(closeMargin(contest([1000, 991])), 9);
  assert.equal(closeMargin(contest([100000, 99600])), 400); // 0.2 %
  assert.equal(closeMargin(contest([1000, 900])), null);
  assert.equal(closeMargin(contest([500, 499, 10], 'VOTE FOR 2')), null);
  assert.equal(closeMargin(contest([500, 20, 15], 'VOTE FOR 2')), 5);
  assert.equal(closeMargin(contest([5])), null);
  assert.equal(closeMargin(contest([0, 0])), null);
});

test('duplicate-upload, older-export, no-change', () => {
  fires(check('ed', ED3, { history: { uploadSha256s: ['abc'] } }), 'duplicate-upload', 'warn');
  fires(check('ed', ED3, { upload: { sha256: 'abc', lastModified: 1000 }, history: { lastPublishedFileTime: 2000 } }), 'older-export', 'warn');
  silent(check('ed', ED3, { upload: { sha256: 'abc', lastModified: 3000 }, history: { lastPublishedFileTime: 2000 } }), 'older-export');
  fires(check('ed', ED3, { current: currentOf('ed', ED3) }), 'no-change', 'warn');
});

test('decreases against what is published', () => {
  const checks = check('ed', ED3, { current: currentOf('ed', ED4) });
  fires(checks, 'reporting-decreased', 'warn');
  const dec = fires(checks, 'votes-decreased', 'warn');
  assert.ok(dec.some((c) => c.title === 'Total ballots went down'));
  assert.ok(dec.some((c) => c.title === 'Candidate total went down' && c.refs[0].candidate));
  assert.ok(dec.some((c) => c.title === 'Contest total went down'));
});

test('contests and candidates added or removed; status label', () => {
  const cur = clone(currentOf('ed', ED3));
  cur.contests.shift();
  cur.contests.push({ ...clone(cur.contests[0]), title: 'Old Contest' });
  cur.contests[0].candidates[0].name = 'Someone Else';
  cur.statusLabel = 'OFFICIAL RESULTS';
  const checks = check('ed', ED3, { current: cur });
  fires(checks, 'contest-added', 'warn');
  fires(checks, 'contest-removed', 'warn');
  fires(checks, 'candidate-added', 'warn');
  fires(checks, 'candidate-removed', 'warn');
  fires(checks, 'status-changed', 'warn');
});

test('leader-changed', () => {
  const cur = clone(currentOf('ed', ED3));
  const gov = cur.contests.find((c) => c.title === 'Governor');
  const draftLeaders = gov.candidates.filter((c) => c.isLeading).map((c) => c.name);
  for (const c of gov.candidates) c.isLeading = !draftLeaders.includes(c.name) && c === gov.candidates.find((x) => !draftLeaders.includes(x.name));
  const [c] = fires(check('ed', ED3, { current: cur }), 'leader-changed', 'warn');
  assert.deepEqual(c.refs, [{ contest: 'Governor' }]);
  assert.match(c.detail, /^Governor: .+ → .+\.$/);
});

test('summary (info) only when something is published', () => {
  const [c] = fires(check('ed', ED4, { current: currentOf('ed', ED3) }), 'summary', 'info');
  assert.match(c.detail, /contests changed; precincts reporting 5 → 10 of 92; ballots/);
  silent(check('ed', ED4), 'summary');
});

test('rollback drafts: acknowledge the rollback, see every reversal, and the files must be valid', () => {
  const r3 = buildResults({ early: EV, ed: ED3 }, { lastUpdated: 'x' });
  const latest = JSON.parse(r3.outputs.files['data.js'].replace(/^[^=]*= /, '').replace(/;\n$/, '')).latest;
  const checks = runRollbackChecks({ latest, files: r3.outputs.files, current: currentOf('ed', ED4), version: latest.dataVersion, publishedAt: 'Nov 3 9:10 PM' });
  const [rb] = fires(checks, 'rollback', 'warn');
  assert.match(rb.detail, /^Republishing version [0-9a-f]{12} \(first published Nov 3 9:10 PM\)/);
  fires(checks, 'reporting-decreased', 'warn');
  fires(checks, 'votes-decreased', 'warn');
  fires(checks, 'summary', 'info');
  assert.ok(!checks.some((c) => c.severity === 'block'));
  const bad = { ...r3.outputs.files, 'summary.json': r3.outputs.files['summary.json'].replace('"totalVotes":1430', '"totalVotes":1431') };
  fires(runRollbackChecks({ latest, files: bad, current: null, version: 'v' }), 'output-invalid', 'block');
  assert.deepEqual(runRollbackChecks({ latest, files: r3.outputs.files, current: null, version: 'v' }).map((c) => c.id), ['rollback']);
});

test('every check id has a test', () => {
  assert.deepEqual(CHECK_IDS.filter((id) => !triggered.has(id)), []);
});
