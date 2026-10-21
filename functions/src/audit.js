'use strict';
/**
 * auditLive's verifier (plan: Election-night assurance): what the public is being served right now
 * must be exactly what was published. Pure: the function fetches the bytes, this judges them.
 */
const { sha256Hex, PAGE_FILES, SUMMARY_FILE } = require('./publish');
const { validateSet } = require('./validate');

/**
 * @param {object} a
 * @param {string|null} a.manifestText          current/manifest.json as served
 * @param {{[file: string]: string|null}} a.files  current/* as served (null = could not fetch)
 * @param {string|null} a.expectedVersion       election.currentVersion
 * @returns {{ok: boolean, problems: string[]}}
 */
function auditServed({ manifestText, files, expectedVersion }) {
  const problems = [];
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch { /* reported below */ }
  if (!manifest || typeof manifest !== 'object') {
    problems.push('manifest.json could not be fetched or is not JSON');
    return { ok: false, problems };
  }
  if (manifest.dataVersion !== expectedVersion) {
    problems.push(`manifest.json says ${manifest.dataVersion}; the published version is ${expectedVersion}`);
  }
  const parsed = {};
  for (const f of [...PAGE_FILES, SUMMARY_FILE]) {
    const text = files[f];
    if (typeof text !== 'string') { problems.push(`${f} could not be fetched`); continue; }
    if (sha256Hex(text) !== manifest.files?.[f]) problems.push(`${f} differs from the published bytes (sha256)`);
    if (f.endsWith('.json')) {
      try { parsed[f] = JSON.parse(text); } catch { problems.push(`${f} is not JSON`); }
    }
  }
  for (const e of validateSet(manifest, parsed).errors) problems.push(e);
  return { ok: problems.length === 0, problems };
}

module.exports = { auditServed };
