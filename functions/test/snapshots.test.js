'use strict';
// The exact text and references of every check and every validation error, pinned (see
// helpers/snapshot.js). One scenario per check id, on the real exports, plus every validator path.
const test = require('node:test');
const { caseInputs } = require('./helpers/fixtures');
const { matchSnapshot } = require('./helpers/snapshot');
const { buildResults } = require('../src/pipeline');
const { readCsv, CsvError } = require('../src/csv');
const { runChecks, runRollbackChecks, unreadableCheck } = require('../src/checks');
const { validateFile, validateSet } = require('../src/validate');

const ELECTION = { name: '2026-11-03 General', date: '2026-11-03', precinctCap: 92 };
const S = (id) => caseInputs(`samples-92-${id}`);
const EV = S('02-ev').early;
const ED3 = S('03-5-reporting').ed;
const ED4 = S('04-10-reporting').ed;
const T = caseInputs('testfiles-ev-ed');
const text = (b) => b.toString('utf8');
const merged = (kind, file, early = EV) => buildResults(kind === 'ed' ? { early, ed: file } : { early: file, ed: null }, { lastUpdated: 'x' }).merged;

function run(kind, file, { early = EV, current = null, election = ELECTION, upload = { sha256: 'abcdef0123456789' }, history, tamper } = {}) {
  let result = buildResults(kind === 'ed' ? { early, ed: file } : { early: file, ed: null }, { precinctCap: election.precinctCap, lastUpdated: 'x' });
  if (tamper) result = tamper(result);
  return runChecks({ kind, rows: readCsv(file), result, current, election, upload, history });
}

const at = (v) => text(ED3).replace('COLLEGEDALE B,7,14,', `COLLEGEDALE B,${v},14,`);
const SCENARIOS = {
  clean_ed_update: () => run('ed', ED4, { current: merged('ed', ED3) }),
  going_backwards: () => run('ed', ED3, { current: merged('ed', ED4) }),
  not_ctr_and_short: () => runChecks({ kind: 'ed', rows: readCsv('Summary\na\nb'), result: null, election: ELECTION, upload: { sha256: 'x' } }),
  no_contests_no_stats: () => run('ed', text(ED3).replaceAll('Precincts Reporting', 'Precincts Counted').replaceAll('STATISTICS', 'TURNOUT')),
  verify_failed_many: () => run('ed', ED3, { tamper: (r) => ({ ...r, verify: Array.from({ length: 23 }, (_, i) => ({ pass: false, detail: `f${i}` })) }) }),
  dates: () => [run('ed', ED3, { election: { ...ELECTION, date: '2026-11-04' } }), run('ed', ED3, { election: { ...ELECTION, date: 'soon' } })],
  reporting_headers: () => {
    const pages = text(ED3).split(',5 of 92 Precincts Reporting,');
    return [
      run('ed', ED3, { election: { ...ELECTION, precinctCap: 4 } }),
      run('ed', text(ED3).replace(',5 of 92 Precincts Reporting,', ',95 of 92 Precincts Reporting,'), { election: { ...ELECTION, precinctCap: 999 } }),
      run('ed', `${pages[0]},7 of 92 Precincts Reporting,${pages.slice(1).join(',5 of 92 Precincts Reporting,')}`),
      run('ed', text(ED3).replaceAll(',5 of 92 Precincts Reporting,', ',6 of 92 Precincts Reporting,')),
    ];
  },
  bad_cells: () => [run('ed', at('-7')), run('ed', at('7.5')), run('ed', text(ED3).replace(/\nTotals,65,130,/, '\nTotals,6x5,130,'))],
  zero_with_votes: () => run('zero', EV),
  title_and_count: () => run('ed', ED3, { election: { ...ELECTION, name: 'Other', precinctCap: 94 } }),
  real_8_column: () => {
    const election = { name: '2026-08-06 State Primary & County General', date: '2026-08-06', precinctCap: 93 };
    return [run('ed', T.ed, { early: T.early, election }), run('early', T.early, { election })];
  },
  turnout: () => [
    run('ed', text(ED3).replace(',COLLEGEDALE B,"1,051",161,', ',COLLEGEDALE B,165,161,')),
    run('ed', text(ED3).replace('Totals,"231,431","1,516"', 'Totals,"1,000","1,516"'), { early: null }),
  ],
  wrong_kind: () => [run('ed', EV), run('early', ED3), run('zero', ED3)],
  history: () => [
    run('ed', ED3, { history: { uploadSha256s: ['abcdef0123456789'] } }),
    run('ed', ED3, { upload: { sha256: 'abcdef0123456789', lastModified: Date.UTC(2026, 10, 3, 20) }, history: { lastPublishedFileTime: Date.UTC(2026, 10, 3, 21) } }),
    run('ed', ED3, { current: merged('ed', ED3) }),
  ],
  structure_changes: () => {
    const cur = structuredClone(merged('ed', ED3));
    cur.precinctStats = Object.fromEntries(cur.precinctStats);
    cur.contests.shift();
    cur.contests.push({ ...structuredClone(cur.contests[0]), title: 'Old Contest' });
    cur.contests[0].candidates[0].name = 'Someone Else';
    cur.statusLabel = 'OFFICIAL RESULTS';
    const gov = cur.contests.find((c) => c.title === 'Governor');
    if (gov) for (const c of gov.candidates) c.isLeading = !c.isLeading;
    return run('ed', ED3, { current: cur });
  },
  output_invalid: () => run('ed', ED3, { tamper: (r) => {
    const s = JSON.parse(r.outputs.files['summary.json']);
    s.latest.contests[0].candidates[0].votes += 1;
    return { ...r, outputs: { ...r.outputs, files: { ...r.outputs.files, 'summary.json': JSON.stringify(s) } } };
  } }),
  rollback: () => {
    const r3 = buildResults({ early: EV, ed: ED3 }, { lastUpdated: 'x' });
    const latest = JSON.parse(r3.outputs.files['data.js'].replace(/^[^=]*= /, '').replace(/;\n$/, '')).latest;
    return runRollbackChecks({ latest, files: r3.outputs.files, current: merged('ed', ED4), version: latest.dataVersion, publishedAt: 'Nov 3 9:10 PM' });
  },
  unreadable: () => unreadableCheck(new CsvError('field larger than field limit (131072)', 9)),
};

for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`checks snapshot: ${name}`, () => matchSnapshot(`checks-${name}`, scenario()));
}

test('validation errors snapshot: every corruption, one message each', () => {
  const r = buildResults({ early: EV, ed: ED4 }, { lastUpdated: 'x' });
  const clean = Object.fromEntries(['summary.json', 'reporting.json', 'precincts.json'].map((f) => [f, JSON.parse(r.outputs.files[f])]));
  const cases = {
    'summary.json': [
      (d) => { d.latest.contests[0].candidates[0].votes += 1; },
      (d) => { d.latest.contests[0].candidates[0].votes = -1; },
      (d) => { d.latest.contests[0].candidates[0].percentage = 101; },
      (d) => { d.latest.contests[0].candidates[0].percentage = 'x'; },
      (d) => { d.latest.contests[0].candidates[0].party = 'GRN'; },
      (d) => { d.latest.contests[0].candidates[0].isLeading = 1; },
      (d) => { d.latest.contests[0].candidates[0].name = 4; },
      (d) => { d.latest.contests[0].candidates.push({ ...d.latest.contests[0].candidates[0], votes: 0 }); },
      (d) => { d.latest.contests[0].candidates = {}; },
      (d) => { d.latest.contests[0].candidates[0] = null; },
      (d) => { d.latest.contests.push(d.latest.contests[0]); },
      (d) => { d.latest.contests[0].precinctsReporting = 93; },
      (d) => { d.latest.contests = null; },
      (d) => { d.latest.overallPrecinctsReporting = 99; },
      (d) => { d.latest.turnoutPercent = -1; },
      (d) => { d.latest = []; },
      (d) => { d.metadata.dataVersion = 'zz'; },
      (d) => { d.metadata.county = null; },
      (d) => { delete d.metadata; },
      (d) => { d.config = 1; },
      (d) => { d.latest.contests[0].voteFor = 2; },
      (d) => { d.latest.contests[0].title = null; },
    ],
    'reporting.json': [
      (d) => { d.latest.contests[0].precinctsStatusIndexed[0] = [0, 2]; },
      (d) => { d.latest.contests[0].precinctsStatusIndexed[0] = 'x'; },
      (d) => { d.latest.contests[0].precinctsStatusIndexed[0] = [999, 0]; },
      (d) => { d.latest.contests[0].precinctsStatusIndexed.forEach((p) => { p[1] = 1; }); },
      (d) => { d.latest.contests[0].precinctsStatusIndexed = null; },
      (d) => { d.masterPrecincts = null; },
      (d) => { d.latest = null; },
    ],
    'precincts.json': [
      (d) => { d.precinctStats.TYNER.voters = -5; },
      (d) => { d.precinctStats.TYNER = 7; },
      (d) => { d.precinctStats = []; },
      (d) => { d.contests[0].candidates[0].precinctVotes.TYNER = 2.5; },
      (d) => { d.contests[0].candidates[0].precinctVotes = null; },
      (d) => { d.contests[0].candidates[0] = null; },
    ],
  };
  const out = {};
  for (const [file, list] of Object.entries(cases)) {
    out[file] = list.map((corrupt) => {
      const d = structuredClone(clean[file]);
      corrupt(d);
      return validateFile(file, d).errors;
    });
  }
  const m = { dataVersion: clean['summary.json'].metadata.dataVersion, updatedAt: 'now', files: { 'summary.json': 'a'.repeat(64) } };
  out.sets = [
    validateSet(m, { 'reporting.json': { ...clean['reporting.json'], metadata: { ...clean['reporting.json'].metadata, dataVersion: '0123456789ab' } } }).errors,
    validateSet({ ...m, dataVersion: 1, files: { x: 'y' }, updatedAt: 2 }, { 'summary.json': clean['summary.json'] }).errors,
    validateSet({ ...m, files: null }, {}).errors,
    validateFile('nope.json', {}).errors,
    validateFile('summary.json', 'x').errors,
  ];
  matchSnapshot('validate-errors', out);
});
