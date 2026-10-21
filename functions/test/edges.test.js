'use strict';
// Edge cases found by mutation testing: each test pins behaviour that a surviving mutant changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readCsv, CsvError, FIELD_LIMIT } = require('../src/csv');
const py = require('../src/pycompat');
const { cleanNum, cleanContestName, parseRows } = require('../src/parse');
const { mergeParsedData, voteForNumber } = require('../src/merge');
const { buildResults } = require('../src/pipeline');

const csvRows = (text) => readCsv(text);

test('errors carry their type name and context', () => {
  assert.throws(() => readCsv(`"${'x'.repeat(FIELD_LIMIT + 1)}"`), (e) => e.name === 'CsvError' && e instanceof CsvError);
  assert.throws(() => parseRows(csvRows('x\n\ny\nz\nw')),
    (e) => e.name === 'ParseError' && e.message === 'Header rows 2-3 are empty: not a Custom Table Report');
  assert.throws(() => cleanContestName('y'.repeat(1001)), (e) => e.message === 'Contest title longer than 1000 characters');
});

test('csv: BOM detection needs all three bytes; later BOMs and real U+FFFD survive', () => {
  assert.deepEqual(readCsv(Buffer.from([0xef, 0x41, 0xbf, 0x42])), [['AB']]); // not a BOM: invalid bytes dropped
  assert.deepEqual(readCsv(Buffer.from([0xef, 0xbb, 0x41])), [['A']]);
  assert.deepEqual(readCsv(Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61])), [['﻿a']]);
  assert.deepEqual(readCsv(Buffer.from([0x61, 0xef, 0xbf, 0xbd, 0x62, 0x63, 0x64])), [['a�bcd']]);
  assert.deepEqual(readCsv(Buffer.from([0xef, 0xbf, 0xbd, 0x2c, 0xef, 0xbf, 0xbd])), [['�', '�']]);
});

test('csv: row line numbers count lines inside quoted cells', () => {
  const lines = [];
  assert.deepEqual(readCsv('a\n"b\nc",d\n\ne\n"x\ny', lines), [['a'], ['b\nc', 'd'], [], ['e'], ['x\ny']]);
  assert.deepEqual(lines, [1, 2, 4, 5, 6]);
});

test('pycompat: exact-tie rounding only applies to real ties; dumps and repr edges', () => {
  for (const [x, want] of [[0.25, 0.25], [0.5, 0.5], [-0.25, -0.25], [0.375, 0.38], [2 ** 49 + 0.5, 2 ** 49 + 0.5]]) {
    assert.equal(py.pyRound2(x), want, `${x}`);
  }
  assert.ok(Object.is(cleanNum('-0'), 0));
  assert.equal(py.pyDumps('~\x7f'), '"~\\u007f"');
  assert.equal(py.pyDumps(5), '5');
  assert.equal(py.pyDumps([1.5, 2]), '[1.5, 2]');
  assert.equal(py.pyFloatRepr(-1e-7), '-1e-07');
  assert.equal(py.pyFloatRepr(-1e16), '-1e+16');
  assert.equal(py.pyInt('๓๒'), 32); // Thai digits
  let longer = 0;
  for (let cp = 0; cp < 0x110000; cp += cp === 0xd7ff ? 0x801 : 1) {
    const c = String.fromCodePoint(cp);
    if (c.toLowerCase().length !== c.length) longer++;
  }
  assert.equal(longer, 1, 'only U+0130 lowercases to a longer string, which pyLowerChars special-cases');
});

const STATS = (rows) => parseRows(csvRows(['Custom Table Report,,,,S', 'T', 'D,,,,C', ...rows, 'Totals,1,1'].join('\n')));
const names = (rows) => [...STATS(rows).precinctStats.keys()];

test('parse: STATISTICS rows — skip lists, page layouts, blank rows', () => {
  assert.deepEqual(names(['P0,9,9', ',,STATISTICS', ',A,5,1', '', 'B,6,2', ',C,7,3,1,1,1']), ['A', 'B', 'C']); // rows before STATISTICS ignored
  for (const label of ['Custom Table Report', 'STATISTICS', 'Precincts Reporting', 'Registered Voters - Total']) {
    assert.deepEqual(names([',,STATISTICS', `${label},5,5`, ',A,1,1']), ['A'], label);
  }
  for (const label of ['STATISTICS', 'Registered Voters - Total', 'Totals']) {
    assert.deepEqual(names([',,STATISTICS', `,${label},5,5`, ',A,1,1']), ['A'], label);
  }
  // Legacy quirk kept: a continuation-page name containing a header word is skipped (real names are upper case).
  for (const word of ['August', 'State', 'Federal', 'County', 'General', 'Primary']) {
    assert.deepEqual(names([',,STATISTICS', `${word} Hill,5,5`, 'STATE LINE,1,1']), ['STATE LINE'], word);
  }
  const s = STATS([',,STATISTICS', ',A,10,4,1,2,1', 'B,8,2']).precinctStats;
  assert.deepEqual([s.get('A').rep, s.get('A').dem, s.get('A').gen, s.get('B').rep], [1, 2, 1, 0]);
  assert.deepEqual(names([',,STATISTICS', ',A,0,0', 'B,0,3']), ['B']); // no voters and no ballots: left out
  assert.equal(STATS([',,STATISTICS', ',A,10,4']).precinctStats.get('A').turnoutPercent, 40);
});

test('parse: contest columns, vote-for text and defaults', () => {
  const p = parseRows(csvRows(['h', 't', 'd', 'x', ',Mayor', ',', ',2 of 3 Precincts Reporting', ',Ann,Bob', 'P1,1,', 'P2,,', 'Totals,1'].join('\n')));
  const m = p.contestsRaw.get('Mayor');
  assert.equal(m.voteFor, 'VOTE FOR 1'); // blank vote-for row
  assert.deepEqual([m.csvPrecinctsReporting, m.csvPrecinctsTotal], [0, 3]); // isEd defaults to false
  assert.deepEqual([...m.candidates.values()].map((c) => [c.name, c.votes]), [['Ann', 1], ['Bob', 0]]);
  assert.deepEqual([...m.precinctsStatusMap.keys()], ['P1']); // P2 has no entries
  // A reporting cell on row 0 or 1: no contest title above it.
  assert.equal(parseRows(csvRows(['1 of 2 Precincts Reporting', 't', 'd', 'x', 'y'].join('\n'))).contestsRaw.size, 0);
  // The same candidate on a repeated block keeps the larger Totals value.
  const twice = parseRows(csvRows(['h', 't', 'd', ',Mayor', ',VOTE FOR 1', ',0 of 1 Precincts Reporting', ',Ann', 'P1,3', 'Totals,3',
    ',Mayor', ',VOTE FOR 1', ',0 of 1 Precincts Reporting', ',Ann', 'P1,3', 'Totals,2'].join('\n')));
  assert.equal(twice.contestsRaw.get('Mayor').candidates.get('Ann').votes, 3);
  assert.equal(parseRows(csvRows('h\nt\nd\nx\ny')).totalVoters, 0); // no Totals row
});

test('merge: reported-precinct inference edge cases', () => {
  const ed = (rows, rep = '1 of 3') => parseRows(csvRows(['h', 't', 'd', 'x', ',Mayor', ',VOTE FOR 1', `,${rep} Precincts Reporting`, ',Ann,Bob', ...rows, 'Totals,9,9'].join('\n')), { isEd: true });
  const early = parseRows(csvRows(['h', 't', 'd', 'x', ',Mayor', ',VOTE FOR 1', ',0 of 3 Precincts Reporting', ',Ann', 'P1,2', 'P2,0', 'P3,1', 'Totals,3'].join('\n')));
  const flags = (e, d) => mergeParsedData(e, d).data.contests[0].precinctsStatus.map((p) => `${p.name}:${p.reported ? 1 : 0}`);
  // P1 grew; P2 is zero with Bob blank (not "non-zero"); P3 unchanged. Bob is not in the Early file.
  assert.deepEqual(flags(early, ed(['P1,5,', 'P2,0,', 'P3,1,'])), ['P1:1', 'P2:0', 'P3:0']);
  assert.deepEqual(flags(early, ed(['P1,2,4', 'P2,0,', 'P3,1,'])), ['P1:1', 'P2:0', 'P3:0']); // Bob's new votes count
  assert.deepEqual(flags(null, ed(['P1,0,0', 'P2,1,', 'P3,,'])), ['P1:0', 'P2:1']); // no Early file: non-zero alone
  // "0 of 0" is not complete: precincts are still inferred.
  const zero = mergeParsedData(early, ed(['P1,2,', 'P2,0,'], '0 of 0'));
  assert.deepEqual(zero.data.contests[0].precinctsStatus.map((p) => p.reported), [false, false]);
  assert.deepEqual(zero.diagnostics.reportingMismatches, []);
});

test('merge: vote-for text, turnout without voters, pipeline with nothing', () => {
  assert.equal(voteForNumber('District 9 VOTE FOR 2'), 2);
  assert.equal(voteForNumber('pick 12'), 12);
  assert.equal(voteForNumber('VOTE FOR　UP TO 4'), 4);
  const noVoters = mergeParsedData(null, parseRows(csvRows('h\nt\nd\nx\nTotals,0,5'))).data;
  assert.equal(noVoters.turnoutPercent, 0);
  assert.equal(noVoters.overallPrecinctsTotal, 92); // no contests: the cap
  assert.equal(buildResults({}), null);
  assert.equal(buildResults({ early: 'a\nb\nc', ed: null }), null);
});
