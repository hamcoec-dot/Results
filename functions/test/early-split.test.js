'use strict';
// Fix d5: early vs Election Day per precinct (merge.js splitEarly). The ED export is cumulative, so
// the Early/ABS file's per-precinct numbers are the early share and ED = cumulative - early.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildResults } = require('../src/pipeline');
const { splitEarly } = require('../src/merge');
const { validateFile } = require('../src/validate');

const REPO = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(REPO, f));

/** Minimal parseRows()-shaped objects. */
function parsed(ballots, votes) {
  return {
    totalBallots: Object.values(ballots).reduce((a, b) => a + b, 0),
    precinctStats: new Map(Object.entries(ballots).map(([name, b]) => [name, { name, voters: 1000, ballots: b }])),
    contestsRaw: new Map([['Mayor', { candidates: new Map(Object.entries(votes).map(([n, pv]) => [n, { name: n, precinctVotes: new Map(Object.entries(pv)) }])) }]]),
  };
}
const merged = (votes) => [{ title: 'Mayor', candidates: Object.entries(votes).map(([name, pv]) => ({ name, precinctVotes: new Map(Object.entries(pv)) })) }];

test('splitEarly: the Early file\'s per-precinct ballots and votes, aligned with the merged contests', () => {
  const early = parsed({ A: 10, B: 0 }, { Ann: { A: 6, B: 0 }, Bob: { A: 4, B: 0 } });
  const ed = parsed({ A: 25, B: 8 }, { Ann: { A: 15, B: 5 }, Bob: { A: 9, B: 3 } });
  const out = splitEarly(early, ed, merged({ Ann: { A: 15, B: 5 }, Bob: { A: 9, B: 3 } }));
  assert.deepEqual(out, { ballots: { A: 10 }, contests: [[{ A: 6 }, { A: 4 }]] });
});

test('splitEarly: nothing for a Zero report, no Early file, or an early number above the cumulative one', () => {
  const ed = parsed({ A: 25 }, { Ann: { A: 15 } });
  assert.equal(splitEarly(null, ed, merged({ Ann: { A: 15 } })), null);
  assert.equal(splitEarly(parsed({ A: 0 }, { Ann: { A: 0 } }), ed, merged({ Ann: { A: 15 } })), null);
  assert.equal(splitEarly(parsed({ A: 30 }, { Ann: { A: 5 } }), ed, merged({ Ann: { A: 15 } })), null, 'ballots');
  assert.equal(splitEarly(parsed({ A: 10 }, { Ann: { A: 16 } }), ed, merged({ Ann: { A: 15 } })), null, 'votes');
});

test('the test exports (EV test / ED test are not a cumulative pair) publish no split', () => {
  const r = buildResults({ early: read('Test_Files/EV test.csv'), ed: read('Test_Files/ED test.csv') });
  assert.equal(JSON.parse(r.outputs.files['precincts.json']).earlyByPrecinct, undefined);
});

test('an Early-only publish splits everything as early, and the file validates', () => {
  const r = buildResults({ early: read('Test_Files/EV test.csv'), ed: null });
  const p = JSON.parse(r.outputs.files['precincts.json']);
  assert.ok(p.earlyByPrecinct, 'split present');
  assert.equal(p.earlyByPrecinct.contests.length, p.contests.length);
  for (const [name, n] of Object.entries(p.earlyByPrecinct.ballots)) assert.equal(n, p.precinctStats[name].ballots, name);
  p.contests.forEach((c, i) => c.candidates.forEach((cand, k) => {
    for (const [pn, v] of Object.entries(p.earlyByPrecinct.contests[i][k])) assert.equal(v, cand.precinctVotes[pn], `${c.title} ${cand.name} ${pn}`);
  }));
  assert.deepEqual(validateFile('precincts.json', p).errors, []);
  // summary.json and reporting.json are unchanged by the split
  assert.equal(JSON.parse(r.outputs.files['summary.json']).latest.earlyByPrecinct, undefined);
});

test('validate: a malformed split is refused', () => {
  const r = buildResults({ early: read('Test_Files/EV test.csv'), ed: null });
  const p = JSON.parse(r.outputs.files['precincts.json']);
  p.earlyByPrecinct.contests.pop();
  assert.ok(validateFile('precincts.json', p).errors.some((e) => /earlyByPrecinct\.contests/.test(e)));
});
