'use strict';
// fast-check arbitraries for synthetic elections (plan "Test strategy", layer 3).
const { fc } = require('./fc-config');
const { generateElection } = require(require('./fixtures').GEN_FIXTURE);

const electionOptsArb = fc.record({
  seed: fc.integer({ min: 0, max: 0x7fffffff }),
  kind: fc.constantFrom('zero', 'early', 'ed'),
  layout: fc.constantFrom('narrow', 'wide'),
  names: fc.constantFrom('tame', 'wild'),
  precincts: fc.integer({ min: 1, max: 150 }),
  contests: fc.integer({ min: 1, max: 60 }),
  maxCandidates: fc.integer({ min: 1, max: 12 }),
  maxVoteFor: fc.integer({ min: 1, max: 5 }),
});

const csvOptsArb = fc.record({
  eol: fc.constantFrom('\r\n', '\n'),
  bom: fc.boolean(),
  pageRows: fc.integer({ min: 5, max: 40 }),
  maxBlockCols: fc.integer({ min: 3, max: 16 }),
});

const electionArb = electionOptsArb.map((o) => ({ opts: o, model: generateElection(o) }));

module.exports = { electionOptsArb, csvOptsArb, electionArb };
