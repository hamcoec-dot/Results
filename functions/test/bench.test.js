'use strict';
// Performance budget (plan: "bench.test.js times parse, merge, verify ... on the largest CSV:
// < 1.5 s locally"). Checks, review and validate join this budget in Phase 2.
const test = require('node:test');
const assert = require('node:assert/strict');
const { caseInputs } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { generateElection, toCsv } = require(require('./helpers/fixtures').GEN_FIXTURE);

const time = (fn) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

test('largest real export pair (EV test + ED test): full pipeline < 1.5 s', (t) => {
  const { early, ed } = caseInputs('testfiles-ev-ed');
  buildResults({ early, ed }); // warm-up (JIT)
  const ms = Math.min(...[0, 1, 2].map(() => time(() => buildResults({ early, ed }))));
  t.diagnostic(`testfiles-ev-ed: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});

test('largest generated election (150 precincts x 60 contests x 12 candidates): < 1.5 s', () => {
  const model = generateElection({ seed: 3, kind: 'ed', layout: 'wide', precincts: 150, contests: 60, maxCandidates: 12, maxVoteFor: 5 });
  const csv = toCsv(model);
  buildResults({ early: null, ed: csv }); // warm-up (JIT), as above: a single cold run under c8 was 1.56 s on a busy runner
  const ms = Math.min(...[0, 1, 2].map(() => time(() => buildResults({ early: null, ed: csv }))));
  assert.ok(ms < 1500, `${(csv.length / 1e6).toFixed(2)} MB in ${ms.toFixed(0)} ms`);
});
