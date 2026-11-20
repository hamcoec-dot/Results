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
const { spawnSync } = require('node:child_process');
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

test('d6: a write-in the Early file lists is split like any candidate', () => {
  const ed = parseRows(rows(), { isEd: true });
  const early = parseRows(rows(), { isEd: false });
  // The same file in both slots: every early number = all, write-ins included.
  const { data } = mergeParsedData(early, ed, { precinctCap: 2 });
  const com = data.contests.findIndex((c) => c.title === 'Commission');
  assert.deepEqual(data.earlyByPrecinct.contests[com], [{ P1: 30, P2: 25 }, { P1: 20, P2: 15 }, { P1: 7, P2: 4 }, { P1: 1 }]);
  assert.ok(data.contests[com].candidates.every((x) => x.noEarlySplit === undefined));
  assert.deepEqual(data.earlyTotals.contests[com], [55, 35, 11, 1]);
});

test('d6: a write-in the Early file does not list has no early numbers and noEarlySplit', () => {
  const ed = parseRows(rows(), { isEd: true });
  // An election-night Early/ABS file: the same columns, but no named write-ins.
  const early = parseRows(readCsv(CERT.replaceAll('Write-In:  Fred', 'Write-in Totals Fred').replaceAll('Write-in: Bob', 'Write-in Totals Bob')), { isEd: false });
  const { data } = mergeParsedData(early, ed, { precinctCap: 2 });
  const com = data.contests.findIndex((c) => c.title === 'Commission');
  const split = splitEarly(early, ed, data.contests);
  assert.deepEqual(split.contests[com], [{ P1: 30, P2: 25 }, { P1: 20, P2: 15 }, {}, {}]);
  assert.deepEqual(data.contests[com].candidates.map((x) => x.noEarlySplit ?? false), [false, false, true, true]);
  // Governor's Hal is listed in the Early file (unchanged), so it is split.
  const gov = data.contests.find((c) => c.title === 'Governor');
  assert.equal(gov.candidates.find((x) => x.name === 'Hal').noEarlySplit, undefined);
  // No Early slot: no split, no flag.
  assert.ok(mergeParsedData(null, ed, { precinctCap: 2 }).data.contests.every((c) => c.candidates.every((x) => x.noEarlySplit === undefined)));
  const res = buildResults({ early: CERT.replaceAll('Write-In:  Fred', 'Write-in Totals Fred').replaceAll('Write-in: Bob', 'Write-in Totals Bob'), ed: CERT }, { precinctCap: 2, lastUpdated: 'x' });
  assert.deepEqual(res.verify.filter((c) => !c.pass), []);
  for (const [name, text] of Object.entries(res.outputs.files)) {
    if (name.endsWith('.json')) assert.deepEqual(Validate.validateFile(name, JSON.parse(text)).errors, [], name);
  }
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

test('d6: validate accepts writeIn: true only, and noEarlySplit: true only on a write-in', () => {
  const res = buildResults({ early: null, ed: CERT }, { precinctCap: 2, lastUpdated: 'x' });
  const bad = (edit, re) => {
    const summary = JSON.parse(res.outputs.files['summary.json']);
    edit(summary.latest.contests[0].candidates);
    assert.ok(Validate.validateFile('summary.json', summary).errors.some((e) => re.test(e)));
  };
  bad((c) => { c[2].writeIn = 'yes'; }, /writeIn/);
  bad((c) => { c[0].noEarlySplit = true; }, /noEarlySplit/);
  bad((c) => { c[2].noEarlySplit = false; }, /noEarlySplit/);
});

test('d6: a party word before a write-in name is not part of the name', () => {
  const cells = ['REP Ann', 'Write-in: DEM Jane Doe', 'Write-in: IND  Bo', 'Write-in: REP Ann'];
  assert.deepEqual(resultColumns(cells, 0, 4).map((x) => [x.name, x.party]),
    [[undefined, undefined], ['Jane Doe', 'DEM'], ['Bo', 'IND'], ['Ann (Certified Write-in)', 'REP']]);
  assert.deepEqual(candidateColumns(cells, 0, 4).map((x) => x[1]), ['Ann', 'Jane Doe', 'Bo', 'Ann (Certified Write-in)']);
  const csv = CERT.replace('Write-in: Hal', 'Write-in: DEM Hal');
  const p = parseRows(readCsv(csv), { isEd: true });
  assert.equal(p.contestsRaw.get('Governor').candidates.get('Hal').party, 'DEM');
  assert.deepEqual(buildResults({ early: null, ed: csv }, { precinctCap: 2, lastUpdated: 'x' }).verify.filter((c) => !c.pass), []);
});

// verify.js reads write-in headers with its own code (writeInName); both readers must agree.
const HEADINGS = [
  'Write-in: Fred Ferguson', 'Write-In:  Fred   Ferguson ', 'WRITE-IN: A', 'write-in:a', 'Write in: B', 'Writein: C', 'Write - in: D',
  'Write-in : E', 'Write-in:', 'Write-in: ', 'Write-in', 'Write-in Totals', 'Write-In Totals', 'Write-in: Not Assigned',
  'Write-in: not  assigned', 'Write-in: NotAssigned', 'Write-in: Write-in', 'Write-in: DEM Jane', 'Write-in: REP  Ann', 'Write-in: IND Bo',
  'Write-in: Carlton "CB" Boleyjack', 'Write-in: O\'Brien, Jr.', 'Write-in: José Núñez', 'Write-in: Ann', 'Write-in: Ann', 'Ann', 'REP Ann',
  'Total Write-in Votes', 'Write-ins: F', 'Write-in:: G', 'Write-in: Dem Lower', 'Write-in: REPublic Party', 'Write-in:\tTab Name',
];
test('d6: parse and verify read every write-in heading the same way', () => {
  for (let i = 0; i < HEADINGS.length; i++) {
    for (const cells of [[HEADINGS[i]], ['Ann', HEADINGS[i]], ['REP Ann', HEADINGS[i], 'Write-in Totals']]) {
      const fromParse = resultColumns(cells, 0, cells.length).map((x) => [x.c, x.writeIn ? x.name : x.raw.replace(/^(REP|DEM|IND) /, '')]);
      assert.deepEqual(candidateColumns(cells, 0, cells.length), fromParse, JSON.stringify(cells));
    }
  }
  assert.deepEqual(candidateColumns(HEADINGS, 0, HEADINGS.length), resultColumns(HEADINGS, 0, HEADINGS.length).map((x) => [x.c, x.writeIn ? x.name : x.raw.replace(/^(REP|DEM|IND) /, '')]));
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

test('the certified pair: early-only certified file + certified file splits Fred Ferguson 348 / 418', () => {
  const dir = path.join(__dirname, 'data');
  const res = buildResults({ early: fs.readFileSync(path.join(dir, '2026-11-03-general-certified-early.csv')), ed: fs.readFileSync(path.join(dir, '2026-11-03-general-certified.csv')) },
    { precinctCap: 94, config: { enablePrecinctResults: true, precinctCap: 94 }, lastUpdated: 'x' });
  assert.deepEqual(res.verify.filter((c) => !c.pass), []);
  const m = res.merged;
  assert.equal(m.earlyTotals.ballots, 70058);
  const ci = m.contests.findIndex((c) => c.title === 'Red Bank Commission Red Bank');
  const k = m.contests[ci].candidates.findIndex((x) => x.name === 'Fred Ferguson');
  assert.equal(m.earlyTotals.contests[ci][k], 348);
  assert.equal(m.contests[ci].candidates[k].votes - m.earlyTotals.contests[ci][k], 418);
  assert.ok(m.contests.every((c) => c.candidates.every((x) => x.noEarlySplit === undefined)));
});

test('convert_data.py with NAMED_WRITE_INS=1 reads the same write-ins (the check-live-pages reference)', (t) => {
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  if (spawnSync(py, ['--version']).status !== 0) return t.skip('no Python');
  const repo = path.join(__dirname, '..', '..');
  const script = [
    'import sys, json, convert_data as c',
    'out = []',
    'for h in json.loads(sys.stdin.read()):',
    '    out.append(list(c.named_write_in(h)))',
    'print(json.dumps(out))',
  ].join('\n');
  const r = spawnSync(py, ['-c', script], { cwd: repo, input: JSON.stringify(HEADINGS.filter((h) => /write[\s-]*in/i.test(h))), env: { ...process.env, NAMED_WRITE_INS: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const fromPy = JSON.parse(r.stdout).map(([n]) => n);
  const fromJs = HEADINGS.filter((h) => /write[\s-]*in/i.test(h)).map((h) => resultColumns([h], 0, 1).map((x) => x.name)[0] ?? '');
  assert.deepEqual(fromPy, fromJs);
  // The whole certified file, merged by Python, has the same write-ins and votes.
  const dir = path.join(__dirname, 'data');
  const merge = [
    'import sys, json, convert_data as c',
    `e = c.parse_election_csv(${JSON.stringify(path.join(dir, '2026-11-03-general-certified-early.csv'))})`,
    `d = c.parse_election_csv(${JSON.stringify(path.join(dir, '2026-11-03-general-certified.csv'))}, is_ed=True)`,
    'm = c.merge_parsed_data(e, d)',
    'print(json.dumps([[ct["title"], x["name"], x["party"], x["votes"]] for ct in m["contests"] for x in ct["candidates"] if x.get("writeIn")]))',
  ].join('\n');
  const r2 = spawnSync(py, ['-c', merge], { cwd: repo, env: { ...process.env, NAMED_WRITE_INS: '1' }, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  const res = buildResults({ early: fs.readFileSync(path.join(dir, '2026-11-03-general-certified-early.csv')), ed: fs.readFileSync(path.join(dir, '2026-11-03-general-certified.csv')) }, { precinctCap: 94, lastUpdated: 'x' });
  assert.deepEqual(JSON.parse(r2.stdout), res.merged.contests.flatMap((c) => c.candidates.filter((x) => x.writeIn).map((x) => [c.title, x.name, x.party, x.votes])));
});
