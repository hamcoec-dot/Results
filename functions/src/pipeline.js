'use strict';
/**
 * One pass from CSV exports to publishable files: read each CSV once, then parse, merge, build
 * outputs and verify from the same rows (what createDraft will call in Phase 2).
 */
const crypto = require('node:crypto');
const { readCsv } = require('./csv');
const { pyDumps } = require('./pycompat');
const { parseRows, FIXES } = require('./parse');
const { mergeParsedData } = require('./merge');
const { buildOutputs, formatLastUpdated } = require('./outputs');
const { verify } = require('./verify');

/**
 * @param {object} input
 * @param {string|Buffer|null} input.early   Early-slot CSV (Zero or Early/ABS), or null
 * @param {string|Buffer|null} input.ed      ED-slot CSV, or null
 * @param {object} [opts]
 * @param {number} [opts.precinctCap=92]
 * @param {object} [opts.config]             page config block (precinctCap is added to it)
 * @param {string} [opts.lastUpdated]        defaults to now, America/New_York
 * @param {object} [opts.fixes]
 * @returns {null | {parsed: {early, ed}, merged: object, diagnostics: object, outputs: object, verify: object[]}}
 *   null when neither slot holds a usable file
 */
function buildResults({ early = null, ed = null }, opts = {}) {
  const { precinctCap = 92, fixes = FIXES } = opts;
  const config = opts.config ?? { enablePrecinctResults: true, precinctCap };
  const lastUpdated = opts.lastUpdated ?? formatLastUpdated(new Date());

  const earlyRows = early === null ? null : readCsv(early);
  const edRows = ed === null ? null : readCsv(ed);
  const parsed = {
    early: earlyRows && parseRows(earlyRows, { isEd: false, fixes }),
    ed: edRows && parseRows(edRows, { isEd: true, fixes }),
  };
  const result = mergeParsedData(parsed.early, parsed.ed, { precinctCap, fixes });
  if (!result) return null;
  if (fixes.d4) result.data.dataVersion = versionOf(result.data.contests, config);

  const outputs = buildOutputs(result.data, { config, lastUpdated });
  const checks = verify({
    earlyRows: parsed.early ? earlyRows : null,
    edRows: parsed.ed ? edRows : null,
    latest: result.data,
    files: outputs.files,
  }, { precinctCap, fixes });
  return { parsed, merged: result.data, diagnostics: result.diagnostics, outputs, verify: checks };
}

/**
 * d4: one hash of the contests (as merge.js hashes them) and the page config, so the same results
 * under different settings are different versions. LEGACY keeps merge.js's contests-only hash.
 */
function versionOf(contests, config) {
  return crypto.createHash('md5')
    .update(pyDumps(contests, { sortKeys: true }))
    .update('\n')
    .update(pyDumps(config, { sortKeys: true }))
    .digest('hex').slice(0, 12);
}

module.exports = { buildResults, versionOf };
