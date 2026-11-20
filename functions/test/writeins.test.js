'use strict';
// Fix d6 (named write-ins) and d7 (STATISTICS columns by header name): the certified export of the
// 2026-11-03 general election adds "Write-in: <name>" columns and a "Ballots Cast - Blank" column.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readCsv } = require('../src/csv');
const { parseRows, resultColumns, FIXES, LEGACY } = require('../src/parse');
const { mergeParsedData, splitEarly, HIDE_ZERO_VOTE_WRITE_INS } = require('../src/merge');
const { verify, candidateColumns } = require('../src/verify');
const { buildResults } = require('../src/pipeline');
const { badNumberCells } = require('../src/checks');
const { buildReview } = require('../src/review');
const Validate = require('../src/validate');

// Two contests side by side (the second in its own column block, as Governor is in the certified
// file), a page-break continuation of the precinct rows, and every kind of write-in column.
const CERT = [
  'Custom Table Report,,,,,,OFFICIAL RESULTS',
  '2026 General,,,,,,',
  '"November 3, 2026",,,,,,Hamilton',
  ',,STATISTICS,,,,',
  ',,Registered Voters - Total,Ballots Cast - Total,Ballots Cast - Blank,Voter Turnout - Total,',
  ',P1,100,40,2,40%,',
  ',STATISTICS,,,',
  ',Registered Voters - Total,Ballots Cast - Total,Ballots Cast - Blank,Voter Turnout - Total',
  'P2,200,50,1,25%',
  'Totals,300,90,3,',
  ',Commission,,,,,,Governor,,,,',
  ',VOTE FOR 2,,,,,,VOTE FOR 1,,,,',
  ',2 of 2 Precincts Reporting,,,,,,2 of 2 Precincts Reporting,,,,',
  ',Ann,Bob,Write-in Totals,Write-In:  Fred   Ferguson ,Write-in: Bob,Write-in: Not Assigned,REP Gail,Write-in Totals,Write-in: Hal,Write-in,Write-in: ',
  'P1,30,20,9,7,1,1,35,2,0,2,0',
  'Totals,30,20,9,7,1,1,35,2,0,2,0',
  ',Commission,,,,,,Governor,,,,',
  ',VOTE FOR 2,,,,,,VOTE FOR 1,,,,',
  ',2 of 2 Precincts Reporting,,,,,,2 of 2 Precincts Reporting,,,,',
  ',Ann,Bob,Write-in Totals,Write-In:  Fred   Ferguson ,Write-in: Bob,Write-in: Not Assigned,REP Gail,Write-in Totals,Write-in: Hal,Write-in,Write-in: ',
  'P2,25,15,4,4,0,0,45,0,0,0,0',
  'Totals,55,35,13,11,1,1,80,2,0,2,0',
].join('\n');

const rows = () => readCsv(CERT);

test('d6: named write-ins are read; totals, not assigned and unnamed write-ins are not', () => {
  const p = parseRows(rows(), { isEd: true });
  const com = p.contestsRaw.get('Commission');
  assert.deepEqual([...com.candidates.keys()], ['Ann', 'Bob', 'Fred Ferguson', 'Bob (Certified Write-in)']);
  const fred = com.candidates.get('Fred Ferguson');
  assert.equal(fred.writeIn, true);
  assert.equal(fred.party, '');
  assert.equal(fred.votes, 11);
  assert.deepEqual([...fred.precinctVotes], [['P1', 7], ['P2', 4]]);
  assert.equal(com.candidates.get('Ann').writeIn, undefined);
  assert.equal(com.candidates.get('Bob (Certified Write-in)').writeIn, true); // a ballot name clash stays separate
  const gov = p.contestsRaw.get('Governor');
  assert.deepEqual([...gov.candidates.keys()], ['Gail', 'Hal']);
  assert.equal(gov.candidates.get('Gail').party, 'REP');
  assert.equal(gov.candidates.get('Hal').party, ''); // not IND: a write-in, not an independent
});

test('d6 off (LEGACY): every write-in column is skipped, as convert_data.py', () => {
  const p = parseRows(rows(), { isEd: true, fixes: LEGACY });
  assert.deepEqual([...p.contestsRaw.get('Commission').candidates.keys()], ['Ann', 'Bob']);
  assert.deepEqual([...p.contestsRaw.get('Governor').candidates.keys()], ['Gail']);
});

test('d6: write-in header spellings', () => {
  const cols = (cells) => resultColumns(cells, 0, cells.length).map((x) => [x.writeIn, x.writeIn ? x.name : x.raw]);
  assert.deepEqual(cols(['Write-in: A', 'WRITE-IN:B', 'Write in: C', 'Write-In : D', 'write-in totals', 'Write-in: not  assigned', 'Write-in', 'Write-in:', 'E']),
    [[true, 'A'], [true, 'B'], [true, 'C'], [true, 'D'], [false, 'E']]);
  // A write-in named like a ballot candidate with a party prefix still clashes.
  assert.deepEqual(cols(['REP Ann', 'Write-in: Ann']), [[false, 'REP Ann'], [true, 'Ann (Certified Write-in)']]);
  assert.deepEqual(candidateColumns(['REP Ann', 'Write-in: Ann', 'Write-in Totals'], 0, 3), [[0, 'Ann'], [1, 'Ann (Certified Write-in)']]);
});

test('d6: merge keeps write-ins (0-vote ones too), with percentages and leading from all votes', () => {
  assert.equal(HIDE_ZERO_VOTE_WRITE_INS, false); // Nate, 2026-11-20: show write-ins with 0 votes
  const { data } = mergeParsedData(null, parseRows(rows(), { isEd: true }), { precinctCap: 2 });
  const com = data.contests.find((c) => c.title === 'Commission');
  assert.equal(com.totalVotes, 55 + 35 + 11 + 1);
  assert.deepEqual(com.candidates.map((c) => [c.name, c.votes, c.isLeading, c.writeIn ?? false]),
    [['Ann', 55, true, false], ['Bob', 35, true, false], ['Fred Ferguson', 11, false, true], ['Bob (Certified Write-in)', 1, false, true]]);
  const gov = data.contests.find((c) => c.title === 'Governor');
  assert.deepEqual(gov.candidates.map((c) => [c.name, c.party, c.votes, c.percentage]), [['Gail', 'REP', 80, 100], ['Hal', '', 0, 0]]);
});

test('d6: a write-in gets no early numbers in the early / Election Day split', () => {
  const ed = parseRows(rows(), { isEd: true });
  const early = parseRows(rows(), { isEd: false });
  // The same file in both slots: every ballot candidate's early = all; the write-ins stay empty.
  const { data } = mergeParsedData(early, ed, { precinctCap: 2 });
  const split = splitEarly(early, ed, data.contests);
  const com = data.contests.findIndex((c) => c.title === 'Commission');
  assert.deepEqual(split.contests[com], [{ P1: 30, P2: 25 }, { P1: 20, P2: 15 }, {}, {}]);
});

test('d6: write-ins say nothing about which precincts reported', () => {
  const ed = parseRows(readCsv(CERT.replaceAll('2 of 2 Precincts', '1 of 2 Precincts').replace('P2,25,15,4,4,0,0,45,0,0,0,0', 'P2,0,0,4,4,0,0,0,0,0,0,0')), { isEd: true });
  const { data, diagnostics } = mergeParsedData(null, ed, { precinctCap: 2 });
  const com = data.contests.find((c) => c.title === 'Commission');
  assert.deepEqual(com.precinctsStatus, [{ name: 'P1', reported: true }, { name: 'P2', reported: false }]);
  assert.deepEqual(diagnostics.reportingMismatches, []);
});

test('d6: the whole pipeline verifies, validates and flags bad write-in cells', () => {
  const res = buildResults({ early: null, ed: CERT }, { precinctCap: 2, lastUpdated: 'x' });
  assert.deepEqual(res.verify.filter((c) => !c.pass), []);
  for (const [name, text] of Object.entries(res.outputs.files)) {
    if (name.endsWith('.json')) assert.deepEqual(Validate.validateFile(name, JSON.parse(text)).errors, [], name);
  }
  assert.ok(res.verify.some((c) => c.detail === "Candidate 'Fred Ferguson' vote sum (11 == 11) in 'Commission'"));
  // A tampered write-in total fails verification.
  const merged = structuredClone(res.merged);
  merged.contests[0].candidates[2].votes = 12;
  const checks = verify({ earlyRows: null, edRows: rows(), latest: merged, files: res.outputs.files }, { precinctCap: 2 });
  assert.ok(checks.some((c) => !c.pass && /Fred Ferguson/.test(c.detail)));
  // A non-numeric cell in a named write-in column is a bad number; in a Not Assigned column it is not looked at.
  const bad = readCsv(CERT.replace('P1,30,20,9,7,1,1,', 'P1,30,20,9,x,1,y,'));
  assert.deepEqual(badNumberCells(bad).map((b) => b.value), ['x']);
});

test('d6: validate accepts writeIn: true only', () => {
  const res = buildResults({ early: null, ed: CERT }, { precinctCap: 2, lastUpdated: 'x' });
  const summary = JSON.parse(res.outputs.files['summary.json']);
  summary.latest.contests[0].candidates[2].writeIn = 'yes';
  assert.ok(Validate.validateFile('summary.json', summary).errors.some((e) => /writeIn/.test(e)));
});

test('d6: the review screen marks write-ins', () => {
  const res = buildResults({ early: null, ed: CERT }, { precinctCap: 2, lastUpdated: 'x' });
  const lines = [];
  const src = readCsv(CERT, lines);
  const { review } = buildReview({
    result: res, current: null, source: { rows: src, lines },
    meta: { draftId: 'a'.repeat(32), baseVersion: 'v1', kind: 'ed', filename: 'c.csv', size: 1, sha256: 's', uploadedAt: 'now', uploadedBy: 'me' },
    election: { name: '2026 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 2 },
  });
  const com = review.contests.find((c) => c.title === 'Commission');
  assert.deepEqual(com.candidates.filter((x) => x.writeIn).map((x) => x.name), ['Fred Ferguson', 'Bob (Certified Write-in)']);
});

test('d7: STATISTICS columns by header name: "Ballots Cast - Blank" is not Republican ballots', () => {
  const p = parseRows(rows(), { isEd: true });
  assert.deepEqual([p.totalVoters, p.totalBallots, p.ballotsRep, p.ballotsDem, p.ballotsGen], [300, 90, 0, 0, 0]);
  assert.deepEqual([...p.precinctStats.values()].map((s) => [s.name, s.voters, s.ballots, s.rep, s.dem, s.gen]),
    [['P1', 100, 40, 0, 0, 0], ['P2', 200, 50, 0, 0, 0]]);
  const legacy = parseRows(rows(), { isEd: true, fixes: { ...FIXES, d7: false } });
  assert.equal(legacy.ballotsRep, 3); // the old misread
  assert.equal(legacy.precinctStats.get('P1').rep, 2);
});

test('d7: a primary export still reads Republican / Democratic / General ballots', () => {
  const primary = readCsv([
    'Custom Table Report,,,,,,,UNOFFICIAL RESULTS',
    '2026 August,,,,,,,',
    '"August 6, 2026",,,,,,,Hamilton',
    ',,STATISTICS,,,,,',
    ',,Registered Voters - Total,Ballots Cast - Total,Ballots Cast - Republican,Ballots Cast - Democratic,Ballots Cast - General,',
    ',P1,100,40,20,15,5,',
    ',STATISTICS,,,,,',
    ',Registered Voters - Total,Ballots Cast - Total,Ballots Cast - Republican,Ballots Cast - Democratic,Ballots Cast - General',
    'P2,200,50,25,20,5',
    'Totals,300,90,45,35,10',
    ',REP Mayor,',
    ',VOTE FOR 1,',
    ',1 of 2 Precincts Reporting,',
    ',REP Ann,',
    'P1,20',
    'Totals,20',
  ].join('\n'));
  const fixed = parseRows(primary, { isEd: true });
  const legacy = parseRows(primary, { isEd: true, fixes: { ...FIXES, d7: false } });
  assert.deepEqual([fixed.ballotsRep, fixed.ballotsDem, fixed.ballotsGen], [45, 35, 10]);
  assert.deepEqual([fixed.ballotsRep, fixed.ballotsDem, fixed.ballotsGen], [legacy.ballotsRep, legacy.ballotsDem, legacy.ballotsGen]);
  assert.deepEqual([...fixed.precinctStats.values()], [...legacy.precinctStats.values()]);
  assert.deepEqual([fixed.precinctStats.get('P2').rep, fixed.precinctStats.get('P2').gen], [25, 5]);
});

test('the certified 2026-11-03 general file: write-ins in, nothing else changes', () => {
  const file = fs.readFileSync(path.join(__dirname, 'data', '2026-11-03-general-certified.csv'));
  const res = buildResults({ early: null, ed: file }, { precinctCap: 94, config: { enablePrecinctResults: true, precinctCap: 94 }, lastUpdated: 'x' });
  assert.deepEqual(res.verify.filter((c) => !c.pass), []);
  const m = res.merged;
  assert.deepEqual([m.totalVoters, m.totalBallots, m.ballotsRep, m.statusLabel, m.contests.length, m.masterPrecincts.length],
    [224989, 126032, 0, 'OFFICIAL RESULTS', 25, 94]);
  const wi = m.contests.flatMap((c) => c.candidates.filter((x) => x.writeIn).map((x) => [c.title, x.name, x.votes]));
  assert.deepEqual(wi, [
    ['Governor', 'Stephen C. Maxwell', 0], ['Governor', 'Jason Michael Smith', 0], ['Governor', 'Carlton "CB" Boleyjack', 0],
    ['Red Bank Commission Red Bank', 'Fred Ferguson', 766],
  ]);
  const legacy = buildResults({ early: null, ed: file }, { precinctCap: 94, fixes: { ...FIXES, d6: false }, lastUpdated: 'x' });
  // Every ballot candidate's votes are the same as without write-ins.
  m.contests.forEach((c, ci) => c.candidates.filter((x) => !x.writeIn).forEach((x, k) => {
    assert.equal(x.votes, legacy.merged.contests[ci].candidates[k].votes);
    assert.equal(x.name, legacy.merged.contests[ci].candidates[k].name);
  }));
});
