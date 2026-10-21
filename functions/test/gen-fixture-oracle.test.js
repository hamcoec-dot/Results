'use strict';
// Cross-checks the generator against the Python reference parser (oracle 1), so generated
// elections are proven to be real "Custom Table Report" exports, not just self-consistent.
// Also pins the legacy parser defects D1-D3 that the Node port must fix (see TESTING.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateElection, toCsv } = require(require('./helpers/fixtures').GEN_FIXTURE);
const { pythonAvailable, pyParse } = require('./helpers/fixtures');

const CASES = [];
for (const kind of ['zero', 'early', 'ed']) {
  for (const layout of ['narrow', 'wide']) {
    for (const seed of [1, 2]) {
      CASES.push({ seed: seed * 1000 + CASES.length, kind, layout, precincts: 40 + seed * 20, contests: 12, maxCandidates: 12, maxVoteFor: 3 });
    }
  }
}
CASES.push({ seed: 77, kind: 'ed', layout: 'wide', names: 'wild', precincts: 60, contests: 20, maxCandidates: 8, county: 'Marion', status: 'OFFICIAL RESULTS' });
CASES.push({ seed: 78, kind: 'ed', layout: 'narrow', names: 'wild', precincts: 150, contests: 30, maxCandidates: 12, maxVoteFor: 5 });

test('generator agrees with the Python reference parser', { skip: !pythonAvailable() && 'python not found' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genfix-'));
  try {
    const models = CASES.map((o) => generateElection(o));
    const inputs = models.map((m, i) => {
      const file = path.join(dir, `case${i}.csv`);
      fs.writeFileSync(file, toCsv(m, { bom: i % 2 === 1, eol: i % 3 ? '\r\n' : '\n' }));
      return { file, isEd: m.kind === 'ed' };
    });
    const parsed = pyParse(inputs);

    for (const [i, m] of models.entries()) {
      const p = parsed[i];
      const o = CASES[i];
      await t.test(`seed ${o.seed} ${o.kind}/${o.layout}/${o.names || 'tame'}`, () => {
        assert.equal(p.electionTitle, m.title);
        assert.equal(p.electionDate, m.date);
        assert.equal(p.totalVoters, m.totals.voters);
        assert.equal(p.totalBallots, m.totals.ballots);
        assert.equal(p.ballotsRep, m.totals.rep);
        assert.equal(p.ballotsDem, m.totals.dem);
        assert.equal(p.ballotsGen, m.totals.gen);

        // D2: legacy reads county/status from column 4; the 8-column (wide) export has them in column 7.
        if (m.layout === 'wide') {
          assert.equal(p.county, 'Hamilton', 'D2 legacy default');
          assert.equal(p.statusLabel, 'UNOFFICIAL RESULTS', 'D2 legacy default');
        } else {
          assert.equal(p.county, m.county);
          assert.equal(p.statusLabel, m.status);
        }

        // D3: legacy finds no STATISTICS rows in the 5-column (narrow) export.
        const expectedStats = m.layout === 'wide'
          ? Object.fromEntries(m.precincts.map((x) => [x.name, {
            name: x.name, voters: x.voters, ballots: x.ballots, rep: x.rep, dem: x.dem, gen: x.gen,
            turnoutPercent: Math.round((x.ballots / x.voters) * 10000) / 100,
          }]))
          : {};
        assert.deepEqual(Object.keys(p.precinctStats), Object.keys(expectedStats));
        for (const [k, v] of Object.entries(expectedStats)) {
          const got = p.precinctStats[k];
          assert.deepEqual({ ...got, turnoutPercent: 0 }, { ...v, turnoutPercent: 0 });
          assert.ok(Math.abs(got.turnoutPercent - v.turnoutPercent) < 0.011, `${k} turnout`);
        }

        assert.deepEqual(Object.keys(p.contests_raw), m.contests.map((c) => c.title));
        for (const c of m.contests) {
          const pc = p.contests_raw[c.title];
          assert.equal(pc.voteFor, c.voteFor);
          assert.equal(pc.csvPrecinctsTotal, c.precinctsTotal);
          assert.equal(pc.csvPrecinctsReporting, c.precinctsReporting);
          assert.deepEqual(Object.keys(pc.candidates), c.candidates.map((x) => x.name));
          for (const cand of c.candidates) {
            const pcand = pc.candidates[cand.name];
            assert.equal(pcand.party, cand.party || 'IND');
            assert.equal(pcand.votes, cand.votes, `${c.title} / ${cand.name}`);
            assert.deepEqual(pcand.precinctVotes, cand.precinctVotes);
          }
          // D1: legacy marks every precinct with any cell (including "0") as reported in an ED file,
          // instead of honouring "R of T Precincts Reporting".
          assert.deepEqual(Object.keys(pc.precinctsStatusMap).sort(), [...c.precincts].sort());
          assert.ok(Object.values(pc.precinctsStatusMap).every((v) => v === (m.kind === 'ed')), 'D1 legacy behaviour');
        }
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
