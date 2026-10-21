'use strict';
// Layer 1 — deterministic unit tests of each module's edge cases (Python's answers noted inline;
// pycompat.property.test.js checks the same functions against Python on random inputs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCsv, CsvError, FIELD_LIMIT } = require('../src/csv');
const py = require('../src/pycompat');
const { cleanNum, cleanContestName, parseReporting, partyOf, parseRows, ParseError, FIXES, LEGACY } = require('../src/parse');
const { mergeParsedData, voteForNumber } = require('../src/merge');
const { buildOutputs, DATA_JS_HEADER } = require('../src/outputs');

test('csv: excel-dialect quirks, as Python csv.reader', () => {
  assert.deepEqual(readCsv('a,"b,c","d""e"\n'), [['a', 'b,c', 'd"e']]);
  assert.deepEqual(readCsv('"ab"c,d'), [['abc', 'd']]); // text after a closing quote is kept
  assert.deepEqual(readCsv('a"b,c'), [['a"b', 'c']]); // quote inside an unquoted field is literal
  assert.deepEqual(readCsv('a\n\nb'), [['a'], [], ['b']]); // blank line -> []
  assert.deepEqual(readCsv('a\r\nb\rc\n'), [['a'], ['b'], ['c']]); // universal newlines
  assert.deepEqual(readCsv('"x\r\ny",z'), [['x\ny', 'z']]);
  assert.deepEqual(readCsv('a,\n,'), [['a', ''], ['', '']]);
  assert.deepEqual(readCsv('"open'), [['open']]); // unterminated at EOF: kept
  assert.deepEqual(readCsv('a,"open'), [['a', 'open']]);
  assert.deepEqual(readCsv('a,""'), [['a', '']]);
  assert.deepEqual(readCsv('"a"\n'), [['a']]);
  assert.deepEqual(readCsv('"a""'), [['a"']]);
  assert.deepEqual(readCsv(''), []);
  assert.deepEqual(readCsv('﻿a'), [['a']]);
  assert.deepEqual(readCsv('﻿﻿a'), [['﻿a']]);
});

test('csv: bytes decode as utf-8-sig with errors=ignore', () => {
  assert.deepEqual(readCsv(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62])), [['ab']]);
  assert.deepEqual(readCsv(Buffer.from([0xff, 0xef, 0xbb, 0xbf, 0x61])), [['﻿a']]); // BOM only at byte 0
  assert.deepEqual(readCsv(Buffer.from([0x61, 0xef, 0xbf, 0xbd, 0xc3])), [['a�']]); // real U+FFFD kept
  assert.deepEqual(readCsv(new Uint8Array([0x78, 0x2c, 0x79])), [['x', 'y']]);
  assert.deepEqual(readCsv(new Uint8Array([0, 0x7a, 0x2c]).subarray(1)), [['z', '']]);
});

test('csv: a field over the size limit is a CsvError with its line', () => {
  assert.equal(FIELD_LIMIT, 131072);
  const err = assert.throws(() => readCsv(`a\nb\n"${'x'.repeat(FIELD_LIMIT + 1)}"`), CsvError);
  assert.equal(err, undefined);
  try { readCsv(`a\n${'y'.repeat(FIELD_LIMIT + 1)}`); } catch (e) { assert.equal(e.line, 2); assert.match(e.message, /field larger than field limit \(131072\) \(line 2\)/); }
  assert.deepEqual(readCsv('😀'.repeat(FIELD_LIMIT))[0][0].length, FIELD_LIMIT * 2); // limit counts code points
});

test('pycompat: strip, round, repr', () => {
  assert.equal(py.pyStrip('\x85\x1c a 　 '), 'a');
  assert.equal(py.pyStrip('﻿a'), '﻿a'); // not whitespace to Python
  for (const [x, want] of [[0.125, 0.12], [0.375, 0.38], [-0.125, -0.12], [2.675, 2.67], [1.005, 1], [12.5, 12.5],
    [100, 100], [33.333333, 33.33], [0.625, 0.62], [0.875, 0.88], [1e25, 1e25], [5.115, 5.12]]) {
    assert.equal(py.pyRound2(x), want, `round(${x}, 2)`);
  }
  assert.ok(Object.is(py.pyRound2(-0.001), -0));
  for (const [x, want] of [[0, '0.0'], [-0, '-0.0'], [1, '1.0'], [12.5, '12.5'], [1e16, '1e+16'], [1.5e16, '1.5e+16'],
    [9999999999999998, '9999999999999998.0'], [0.0001, '0.0001'], [0.00001, '1e-05'], [1.25e-7, '1.25e-07'], [-33.33, '-33.33'],
    [NaN, 'nan'], [Infinity, 'inf'], [-Infinity, '-inf'], [123456.0, '123456.0'], [1e22, '1e+22']]) {
    assert.equal(py.pyFloatRepr(x), want, `repr(${x})`);
  }
});

test('pycompat: int() and float() of text', () => {
  for (const [s, want] of [['42', 42], ['+5', 5], ['-0', 0], ['007', 7], ['1_000', 1000], [' 9 ', 9], ['٣', 3], ['１２', 12],
    ['𝟗', 9], ['1__0', null], ['_1', null], ['1_', null], ['', null], ['1.5', null], ['--1', null], ['a', null]]) {
    assert.equal(py.pyInt(s), want, `int(${JSON.stringify(s)})`);
  }
  assert.ok(Object.is(py.pyInt('-0'), 0));
  for (const [s, want] of [['1.5', 1.5], ['.5', 0.5], ['5.', 5], ['1_0.5', 10.5], ['1.e3', 1000], ['-2.5E-1', -0.25], ['٣.5', 3.5],
    ['.', null], ['1._5', null], ['1.5_', null], ['1.5e', null], ['1.2.3', null]]) {
    assert.equal(py.pyFloat(s), want, `float(${JSON.stringify(s)})`);
  }
});

test('pycompat: code-point ordering and lowercase', () => {
  const keys = ['￿', '😀', 'b', 'B', '12', '2', ''];
  assert.deepEqual(keys.slice().sort(py.pyCompare), ['', '12', '2', 'B', 'b', '￿', '😀']);
  assert.equal(py.pyCompare('ab', 'ab'), 0);
  assert.ok(py.pyCompare('a', 'ab') < 0 && py.pyCompare('ab', 'a') > 0);
  assert.equal(py.pyLowerChars('ΣΊΣΥΦΟΣ İ ſ K'), 'σίσυφοσ i ſ k');
});

test('pycompat: json.dumps', () => {
  const m = new Map([['b', 1], ['12', 2], ['a', 3]]);
  assert.equal(py.pyDumps(m), '{"b": 1, "12": 2, "a": 3}'); // Map keeps insertion order like a dict
  assert.equal(py.pyDumps({ b: 1, a: [true, null, false] }, { sortKeys: true }), '{"a": [true, null, false], "b": 1}');
  assert.equal(py.pyDumps({ x: 'é😀"\\\n\r\t\b\f\x01\x7f/' }, { itemSep: ',', keySep: ':' }),
    '{"x":"\\u00e9\\ud83d\\ude00\\"\\\\\\n\\r\\t\\b\\f\\u0001\\u007f/"}');
  assert.equal(py.pyDumps({ percentage: 50, turnoutPercent: [12.5, 0], votes: 3, odd: 2.5 }), '{"percentage": 50.0, "turnoutPercent": [12.5, 0.0], "votes": 3, "odd": 2.5}');
  assert.equal(py.pyDumps({ v: undefined, n: -0 }), '{"v": null, "n": 0}');
});

test('parse: clean_num', () => {
  for (const [v, want] of [['', 0], [undefined, 0], ['1,234', 1234], [' 12 ', 12], ['1.5', 1.5], ['1,234.5', 1234.5], ['abc', 0], ['1.2.3', 0], ['-7', -7], ['٣', 3]]) {
    assert.equal(cleanNum(v), want, JSON.stringify(v));
  }
});

test('parse: clean_contest_name', () => {
  for (const [v, want] of [['District 28 District 28', 'District 28'], ['  Mayor  ', 'Mayor'], ['Board  of   Ed', 'Board of Ed'],
    ['City Council City', 'City Council'], ['Walden Referendum Walden', 'Walden Referendum'], ['East Ridge Mayor East Ridge', 'East Ridge Mayor East Ridge'],
    ['the THE', 'the'], ['Σίσυφος ΣΊΣΥΦΟΣ', 'Σίσυφος ΣΊΣΥΦΟΣ'], ['Sheriff', 'Sheriff'], ['', ''], [null, ''], ['a a a', 'a a']]) {
    assert.equal(cleanContestName(v), want, JSON.stringify(v));
  }
  assert.throws(() => cleanContestName('x'.repeat(1001)), ParseError);
  assert.equal(cleanContestName('x'.repeat(1000)), 'x'.repeat(1000));
});

test('parse: reporting text, parties', () => {
  assert.deepEqual(parseReporting('5 of 92 Precincts Reporting'), [5, 92]);
  assert.deepEqual(parseReporting('0 OF 3 election day PRECINCTS reporting'), [0, 3]);
  assert.deepEqual(parseReporting('7  of\t9 Precincts  Reporting'), [7, 9]);
  assert.equal(parseReporting('Precincts Reporting'), null);
  assert.deepEqual(partyOf('Governor', 'REP Marsha Blackburn'), { party: 'REP', name: 'Marsha Blackburn' });
  assert.deepEqual(partyOf('Governor', 'DEM  Jerri Green'), { party: 'DEM', name: 'Jerri Green' });
  assert.deepEqual(partyOf('Governor', 'IND Ray Brown'), { party: 'IND', name: 'Ray Brown' });
  assert.deepEqual(partyOf('Governor', 'Ray Brown'), { party: 'IND', name: 'Ray Brown' });
  assert.deepEqual(partyOf('REP Governor', 'Ray Brown'), { party: 'REP', name: 'Ray Brown' });
  assert.deepEqual(partyOf('Dem Senate', 'Ray Brown'), { party: 'DEM', name: 'Ray Brown' });
  assert.deepEqual(partyOf('REP Sheriff', 'No Candidate Qualified'), { party: 'REP', name: 'No Candidate Qualified' });
  assert.deepEqual(partyOf('DEM Sheriff', 'no candidate'), { party: 'DEM', name: 'No Candidate Qualified' });
  assert.deepEqual(partyOf('Sheriff', 'NO CANDIDATE QUALIFIED'), { party: 'IND', name: 'No Candidate Qualified' });
});

const csvRows = (text) => readCsv(text);
const MINI = [
  'Custom Table Report,,,,UNOFFICIAL RESULTS',
  '2026 General,,,,',
  '"November 3, 2026",,,,Hamilton',
  ',,STATISTICS,,',
  ',,Registered Voters - Total,Ballots Cast - Total,',
  ',P1,100,10,',
  'P2,200,0',
  'P3,0,0',
  'Totals,300,10',
  ',Mayor,,Clerk,',
  ',VOTE FOR 1,,VOTE FOR 2,',
  ',1 of 2 Precincts Reporting,,1 of 1 Precincts Reporting,',
  ',REP Ann,DEM Bob,Cy,Write-in Totals',
  'P1,6,4,3,1',
  'P2,0,0,,',
  'Totals,6,4,3,1',
].join('\n');

test('parse: header, stats and contests of a minimal export', () => {
  const p = parseRows(csvRows(MINI), { isEd: true });
  assert.equal(p.electionTitle, '2026 General');
  assert.equal(p.county, 'Hamilton');
  assert.deepEqual([p.totalVoters, p.totalBallots, p.ballotsRep], [300, 10, 0]);
  assert.deepEqual([...p.precinctStats.keys()], ['P1', 'P2']); // P3 has no voters and no ballots
  assert.equal(p.precinctStats.get('P1').turnoutPercent, 10);
  assert.equal(p.precinctStats.get('P2').turnoutPercent, 0);
  const mayor = p.contestsRaw.get('Mayor');
  assert.deepEqual([mayor.csvPrecinctsReporting, mayor.csvPrecinctsTotal], [1, 2]);
  assert.deepEqual([...mayor.candidates.keys()], ['Ann', 'Bob']);
  assert.deepEqual([...mayor.precinctsStatusMap], [['P1', false], ['P2', false]]); // d1: merge decides
  const clerk = p.contestsRaw.get('Clerk');
  assert.deepEqual([...clerk.candidates.keys()], ['Cy']); // write-ins are not results
  assert.deepEqual([...clerk.precinctsStatusMap.keys()], ['P1']);
  assert.equal(parseRows(csvRows(MINI), { isEd: false }).contestsRaw.get('Mayor').csvPrecinctsReporting, 0);
  assert.deepEqual([...parseRows(csvRows(MINI), { isEd: true, fixes: LEGACY }).contestsRaw.get('Mayor').precinctsStatusMap.values()], [true, true]);
  assert.equal(parseRows(csvRows(MINI), { fixes: LEGACY }).precinctStats.size, 0);
});

test('parse: degenerate files', () => {
  assert.equal(parseRows(csvRows('a\nb\nc\nd')), null);
  assert.equal(parseRows(null), null);
  assert.throws(() => parseRows(csvRows('x\n\ny\nz\nw')), ParseError);
  assert.throws(() => parseRows(csvRows('x\ny\n\nz\nw')), ParseError);
  const bare = parseRows(csvRows(',a\n,b\n,c\nd\ne'));
  assert.deepEqual([bare.electionTitle, bare.electionDate, bare.county, bare.statusLabel], ['General Election', '', 'c', 'a']);
  const legacyBlank = parseRows(csvRows('h,,,, \nt\nd,,,, \nx\ny'), { fixes: LEGACY });
  assert.deepEqual([legacyBlank.county, legacyBlank.statusLabel], ['', '']); // a present-but-blank cell: '' not the default
  const fixedBlank = parseRows(csvRows('h,,,, \nt\nd,,,, \nx\ny'), { fixes: FIXES });
  assert.deepEqual([fixedBlank.county, fixedBlank.statusLabel], ['Hamilton', 'UNOFFICIAL RESULTS']);
  // A contest block with no Totals row: candidates get 0, no precinct entries, parsing goes on.
  const noTotals = parseRows(csvRows(['h', 't', 'd', 'x', ',Mayor', ',VOTE FOR 1', ',0 of 1 Precincts Reporting', ',Ann', 'P1,5'].join('\n')));
  assert.deepEqual(noTotals.contestsRaw.get('Mayor').candidates.get('Ann').votes, 0);
});

test('merge: vote-for, parties, leaders, slots', () => {
  for (const [s, n] of [['VOTE FOR 1', 1], ['Vote for up to 3', 3], ['SELECT 2', 2], ['VOTE 4', 4], ['pick 5 of these', 5], ['VOTE FOR 0', 1], ['', 1], ['٣', 3]]) {
    assert.equal(voteForNumber(s), n, s);
  }
  assert.equal(mergeParsedData(null, null), null);

  const p = parseRows(csvRows(MINI), { isEd: true });
  const { data, diagnostics } = mergeParsedData(null, p);
  const mayor = data.contests[0];
  assert.deepEqual(mayor.candidates.map((c) => [c.party, c.percentage, c.isLeading]), [['REP', 60, true], ['DEM', 40, false]]);
  assert.equal(data.contests[1].candidates[0].party, ''); // IND dropped: no REP/DEM in the contest
  assert.deepEqual(mayor.precinctsStatus, [{ name: 'P1', reported: true }, { name: 'P2', reported: false }]);
  assert.deepEqual(data.contests[1].precinctsStatus, [{ name: 'P1', reported: true }]); // 1 of 1: complete
  assert.deepEqual(diagnostics.reportingMismatches, []);
  assert.equal(data.hasEarlyUpload, false);
  assert.deepEqual(data.masterPrecincts, ['P1', 'P2']);
  assert.deepEqual(mayor.precinctsStatusIndexed, [[0, 1], [1, 0]]);

  const capped = mergeParsedData(null, p, { precinctCap: 1 }).data;
  assert.deepEqual([capped.contests[0].precinctsTotal, capped.overallPrecinctsTotal], [1, 1]);

  const earlyOnly = mergeParsedData(parseRows(csvRows(MINI), { isEd: false }), null).data;
  assert.deepEqual(earlyOnly.contests[0].precinctsStatus.map((x) => x.reported), [false, false]);
  assert.deepEqual([earlyOnly.hasEarlyUpload, earlyOnly.earlyVotingReporting, earlyOnly.earlyBallotsCast], [true, 1, 10]);

  // Early-slot contest absent from the ED file: kept, 0 reporting; candidates only in Early are appended.
  const early = parseRows(csvRows(MINI.replace(',Mayor,,Clerk,', ',Mayor,,Assessor,').replace('Cy,', 'Di,')), { isEd: false });
  const merged = mergeParsedData(early, p).data;
  assert.deepEqual(merged.contests.map((c) => [c.title, c.precinctsReporting]), [['Mayor', 1], ['Assessor', 0], ['Clerk', 1]]);
});

test('merge: leaders with vote-for 2 and ties; zero votes never lead', () => {
  const rows = (votes) => csvRows([
    'h', 't', 'd', 'x', ',Board', ',VOTE FOR 2', ',0 of 1 Precincts Reporting', `,${votes.map((_, i) => `C${i}`).join(',')}`,
    `P1,${votes.join(',')}`, `Totals,${votes.join(',')}`].join('\n'));
  const leads = (votes) => mergeParsedData(parseRows(rows(votes)), null).data.contests[0].candidates.map((c) => c.isLeading);
  assert.deepEqual(leads([5, 9, 5, 1]), [true, true, true, false]); // tie at the cutoff: both lead
  assert.deepEqual(leads([0, 3, 0]), [false, true, false]);
  assert.deepEqual(leads([0, 0]), [false, false]);
  assert.deepEqual(mergeParsedData(parseRows(rows([0, 0])), null).data.contests[0].candidates.map((c) => c.percentage), [0, 0]);
});

test('outputs: data.js wrapper and file shapes', () => {
  const { data } = mergeParsedData(null, parseRows(csvRows(MINI), { isEd: true }));
  const out = buildOutputs(data, { config: { enablePrecinctResults: false }, lastUpdated: 'L' });
  assert.ok(out.files['data.js'].startsWith(DATA_JS_HEADER) && out.files['data.js'].endsWith('};\n'));
  const precincts = JSON.parse(out.files['precincts.json']);
  assert.equal(precincts.contests[0].precinctsStatus, undefined);
  assert.deepEqual(precincts.contests[0].precinctsStatusIndexed, [[0, 1], [1, 0]]);
  const reporting = JSON.parse(out.files['reporting.json']);
  assert.deepEqual(Object.keys(reporting.latest.contests[0]), ['title', 'precinctsReporting', 'precinctsTotal', 'precinctsStatusIndexed']);
  assert.equal(JSON.parse(out.files['summary.json']).metadata.lastUpdated, 'L');
  assert.equal(out.objects.summary.config.enablePrecinctResults, false);
});

test('pyTrueDiv: exact int division, correctly rounded, with Python signs and errors', () => {
  assert.throws(() => py.pyTrueDiv(1n, 0n), RangeError); // ZeroDivisionError
  assert.ok(Object.is(py.pyTrueDiv(0n, 5n), 0));
  assert.ok(Object.is(py.pyTrueDiv(0n, -5n), -0)); // Python: 0 / -5 == -0.0
  assert.equal(py.pyTrueDiv(-7n, 2n), -3.5);
  assert.equal(py.pyTrueDiv(7n, -2n), -3.5);
  assert.equal(py.pyTrueDiv(10n ** 26n + 7n, 1923n), 5.200208008320333e+22);
  assert.equal(py.pyTrueDiv(2n ** 53n + 1n, 1n), 2 ** 53); // the tie rounds to even
  assert.equal(py.pyTrueDiv(2n ** 53n + 3n, 1n), 2 ** 53 + 4);
  assert.equal(py.pyTrueDiv(1n, 3n), 1 / 3);
  assert.equal(py.pyIntBig(' 1_000 '), 1000n);
  assert.equal(py.pyIntBig('1.5'), null);
});
