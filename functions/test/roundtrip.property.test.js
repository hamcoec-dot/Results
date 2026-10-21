'use strict';
// Layer 3 — model -> CSV -> parse + merge must reproduce the generator's election exactly
// (oracle 3), with every fix on. ED elections are paired with the Early file they followed, so
// the reported-precinct inference (d1) is exercised against known ground truth.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fc, fcParams } = require('./helpers/fc-config');
const { electionArb, csvOptsArb } = require('./helpers/arbitraries');
const { deriveEarly, visibleReported, toCsv } = require(require('./helpers/fixtures').GEN_FIXTURE);
const { buildResults } = require('../src/pipeline');
const { pyRound2 } = require('../src/pycompat');

const CAP = 999;

function check({ model }, co) {
  const early = model.kind === 'ed' ? deriveEarly(model) : null;
  const input = model.kind === 'ed'
    ? { early: toCsv(early, co), ed: toCsv(model, co) }
    : { early: toCsv(model, co), ed: null };
  const r = buildResults(input, { precinctCap: CAP, lastUpdated: 'x' });
  const m = r.merged;

  assert.equal(m.electionTitle, model.title);
  assert.equal(m.electionDate, model.date);
  assert.equal(m.county, model.county);
  assert.equal(m.statusLabel, model.status);
  assert.equal(m.totalVoters, model.totals.voters);
  assert.equal(m.totalBallots, model.totals.ballots);
  assert.deepEqual([m.ballotsRep, m.ballotsDem, m.ballotsGen], [model.totals.rep, model.totals.dem, model.totals.gen]);
  assert.equal(m.turnoutPercent, pyRound2((model.totals.ballots / model.totals.voters) * 100));

  assert.deepEqual([...m.precinctStats.keys()], model.precincts.map((p) => p.name));
  for (const p of model.precincts) {
    const s = m.precinctStats.get(p.name);
    assert.deepEqual([s.voters, s.ballots, s.rep, s.dem, s.gen], [p.voters, p.ballots, p.rep, p.dem, p.gen], p.name);
    assert.equal(s.turnoutPercent, pyRound2((p.ballots / p.voters) * 100));
  }
  assert.deepEqual(m.masterPrecincts.slice().sort(), model.precincts.map((p) => p.name).sort());

  const visible = model.kind === 'ed' ? visibleReported(model) : null;
  const mismatches = [];
  assert.deepEqual(m.contests.map((c) => c.title), model.contests.map((c) => c.title));
  model.contests.forEach((mc, k) => {
    const c = m.contests[k];
    assert.equal(c.voteFor, mc.voteFor);
    assert.equal(c.precinctsTotal, mc.precinctsTotal);
    assert.equal(c.precinctsReporting, mc.precinctsReporting, `${mc.title} reporting`);
    const partisan = mc.candidates.some((x) => x.party === 'REP' || x.party === 'DEM');
    assert.deepEqual(c.candidates.map((x) => [x.name, x.party, x.votes]),
      mc.candidates.map((x) => [x.name, x.party || (partisan ? 'IND' : ''), x.votes]));
    for (const [i, x] of mc.candidates.entries()) {
      assert.deepEqual(Object.fromEntries(c.candidates[i].precinctVotes), x.precinctVotes);
    }
    const total = mc.candidates.reduce((s, x) => s + x.votes, 0);
    assert.equal(c.totalVotes, total);
    if (total > 0) assert.ok(Math.abs(c.candidates.reduce((s, x) => s + x.percentage, 0) - 100) <= 0.1, 'percentages total 100');

    const sorted = mc.candidates.map((x) => x.votes).filter((v) => v > 0).sort((a, b) => b - a);
    const cutoff = sorted[Math.min(mc.voteForNum, sorted.length) - 1];
    assert.deepEqual(c.candidates.map((x) => x.isLeading), mc.candidates.map((x) => x.votes > 0 && x.votes >= cutoff));

    assert.deepEqual(c.precinctsStatus.map((p) => p.name), mc.precincts);
    const flagged = c.precinctsStatus.filter((p) => p.reported).map((p) => p.name);
    const expected = visible ? visible.get(mc.title) : [];
    assert.deepEqual(flagged, expected, `${mc.title} reported precincts`);
    if (expected.length !== mc.precinctsReporting) mismatches.push(mc.title);
  });
  assert.deepEqual(r.diagnostics.reportingMismatches.map((x) => x.contest), mismatches);
  assert.deepEqual(r.verify.filter((x) => !x.pass), [], 'verify passes');
  assert.equal(buildResults(input, { precinctCap: CAP, lastUpdated: 'y' }).merged.dataVersion, m.dataVersion);
}

test('round trip: generated election -> CSV -> parse + merge reproduces the model', () => {
  fc.assert(fc.property(electionArb, csvOptsArb, check), fcParams());
});
