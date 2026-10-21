'use strict';
// The synthetic-election generator is itself an oracle (layer 3), so it is tested first:
// deterministic, internally consistent, and its CSV round-trips through an independent reader.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('csv-parse/sync');
const { fc, fcParams } = require('./helpers/fc-config');
const { electionArb, electionOptsArb, csvOptsArb } = require('./helpers/arbitraries');
const { generateElection, toCsv } = require('../../tools/gen-fixture');

// Generator self-tests stay at PR depth even nightly; the 100k-run depth is for the parser round trip.
const selfTestParams = (cap = 1000) => fcParams({ numRuns: Math.min(fcParams().numRuns, cap) });
const num = (s) => (s === '' || s === undefined ? null : Number(String(s).replace(/,/g, '')));
const stripParty = (label) => label.replace(/^(REP|DEM|IND) /, '');

/** Minimal independent reader of the contest blocks (not the parser under test). */
function readContests(rows) {
  const out = new Map();
  for (let i = 0; i < rows.length; i++) {
    const starts = rows[i].map((c, idx) => (/Precincts Reporting$/.test(c) ? idx : -1)).filter((x) => x >= 0);
    if (!starts.length) continue;
    let end = i + 2;
    while (rows[end][0] !== 'Totals') end++;
    starts.forEach((col, k) => {
      const stop = k + 1 < starts.length ? starts[k + 1] : rows[i + 1].length;
      const title = rows[i - 2][col];
      const [, rep, tot] = /^(\d+) of (\d+) Precincts Reporting$/.exec(rows[i][col]);
      const c = out.get(title) ?? { voteFor: rows[i - 1][col], reporting: +rep, total: +tot, cands: new Map() };
      for (let cc = col; cc < stop; cc++) {
        const label = rows[i + 1][cc];
        if (/write-in/i.test(label)) continue;
        const pv = {};
        for (let d = i + 2; d < end; d++) {
          const p = rows[d][0];
          if (p && rows[d][cc] !== '') pv[p] = num(rows[d][cc]);
        }
        c.cands.set(stripParty(label), { votes: num(rows[end][cc]), precinctVotes: pv });
      }
      out.set(title, c);
    });
    i = end;
  }
  return out;
}

test('same seed and options give byte-identical CSV', () => {
  fc.assert(fc.property(electionOptsArb, csvOptsArb, (o, co) => {
    assert.equal(toCsv(generateElection(o), co), toCsv(generateElection(o), co));
  }), selfTestParams(200));
});

test('model invariants hold', () => {
  fc.assert(fc.property(electionArb, ({ opts, model }) => {
    const byName = new Map(model.precincts.map((p) => [p.name, p]));
    assert.equal(byName.size, model.precincts.length, 'duplicate precinct names');
    assert.equal(new Set(model.contests.map((c) => c.title)).size, model.contests.length, 'duplicate contest titles');
    for (const p of model.precincts) {
      assert.ok(p.voters >= 1 && p.ballots <= p.voters);
      if (opts.layout === 'wide') assert.equal(p.rep + p.dem + p.gen, p.ballots);
      if (opts.kind === 'zero') assert.equal(p.ballots, 0);
    }
    for (const c of model.contests) {
      assert.equal(new Set(c.candidates.map((x) => x.name)).size, c.candidates.length, 'duplicate candidates');
      assert.ok(c.precinctsReporting <= c.precinctsTotal);
      if (opts.kind !== 'ed') assert.equal(c.precinctsReporting, 0);
      for (const cand of c.candidates) {
        assert.equal(Object.values(cand.precinctVotes).reduce((a, b) => a + b, 0), cand.votes);
      }
      for (const pn of c.precincts) {
        const sum = c.candidates.reduce((s, x) => s + x.precinctVotes[pn], 0);
        assert.ok(sum <= byName.get(pn).ballots * c.voteForNum, `overvote in ${c.title} @ ${pn}`);
      }
    }
  }), selfTestParams());
});

test('CSV round-trips: every model number is read back from the export', () => {
  fc.assert(fc.property(electionArb, csvOptsArb, ({ model }, co) => {
    const rows = parse(toCsv(model, co), { bom: true, relax_column_count: true });
    const W = model.layout === 'wide' ? 8 : 5;

    assert.equal(rows[0][0], 'Custom Table Report');
    assert.equal(rows[0][W - 1], model.status);
    assert.equal(rows[1][0], model.title);
    assert.equal(rows[2][0], model.date);
    assert.equal(rows[2][W - 1], model.county);

    const totalsRow = rows.find((r) => r[0] === 'Totals');
    assert.equal(num(totalsRow[1]), model.totals.voters);
    assert.equal(num(totalsRow[2]), model.totals.ballots);

    const read = readContests(rows);
    assert.deepEqual([...read.keys()], model.contests.map((c) => c.title));
    for (const c of model.contests) {
      const r = read.get(c.title);
      assert.equal(r.voteFor, c.voteFor);
      assert.equal(r.total, c.precinctsTotal);
      assert.equal(r.reporting, c.precinctsReporting);
      assert.deepEqual([...r.cands.keys()], c.candidates.map((x) => x.name));
      for (const cand of c.candidates) {
        assert.equal(r.cands.get(cand.name).votes, cand.votes, `${c.title} / ${cand.name}`);
        assert.deepEqual(r.cands.get(cand.name).precinctVotes, cand.precinctVotes);
      }
    }
  }), selfTestParams(300) /* csv-parse ~1 s per generated MB */);
});
