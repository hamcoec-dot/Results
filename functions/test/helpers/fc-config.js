'use strict';
// Shared fast-check settings. PR depth by default; nightly sets FC_RUNS=100000.
// Replay a failure with FC_SEED=<seed> (and FC_PATH=<path> to skip straight to the shrunk case).
const fc = require('fast-check');

function fcParams(overrides = {}) {
  const params = { numRuns: Number(process.env.FC_RUNS) || 1000, ...overrides };
  if (process.env.FC_SEED) params.seed = Number(process.env.FC_SEED);
  if (process.env.FC_PATH) params.path = process.env.FC_PATH;
  return params;
}

module.exports = { fc, fcParams };
