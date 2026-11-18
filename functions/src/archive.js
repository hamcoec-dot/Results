'use strict';
/**
 * Official archive and "no current election" rules (docs/ARCHIVE.md). Pure: service.js does the I/O.
 *
 * After certification the admin page archives the live version of an election: its four page files
 * are copied to the public bucket's archive/<election>/, relabelled OFFICIAL RESULTS with the
 * certification date, and listed in archive/index.json. The public pages show an archive with
 * ?election=<election> (results-config.js) and list every archive on archive.html.
 *
 * Clearing then replaces current/ with a "no election" manifest, so the public pages show a
 * "no current election" message until the next election's first publish.
 */
const { sha256Hex, PAGE_FILES, SUMMARY_FILE } = require('./publish');
const { DATA_JS_HEADER } = require('./outputs');

const OFFICIAL_LABEL = 'OFFICIAL RESULTS';
const ARCHIVE_FILES = [...PAGE_FILES, SUMMARY_FILE];
const ARCHIVE_INDEX = 'archive/index.json';
const ARCHIVE_INDEX_MAX = 500;
/** Archives change only if an admin archives the same election again, so a few minutes of caching is fine. */
const ARCHIVE_CACHE = 'public, max-age=300';
const INDEX_CACHE = 'public, max-age=60';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const archivePath = (electionId, file) => `archive/${electionId}/${file}`;

/** A real calendar date written YYYY-MM-DD, or false. */
function isDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/** Today's date in Hamilton County (America/New_York), YYYY-MM-DD. */
function localDate(ms, timeZone = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * Why an election may not be archived ([] = it may).
 * @param {object} a
 * @param {object} a.election       Firestore election doc
 * @param {string} a.certifiedDate  YYYY-MM-DD, the date the results were certified
 * @param {number} a.now            ms
 */
function archiveRefusals({ election, certifiedDate, now }) {
  const out = [];
  const no = (code, detail) => out.push({ code, detail });
  if (!election.currentVersion) no('nothing-published', 'Nothing has been published for this election, so there is nothing to archive. Publish the certified results first.');
  if (!isDate(certifiedDate)) no('bad-date', 'Certified on: use a date like 2026-11-20.');
  else {
    if (election.date && certifiedDate < election.date) no('bad-date', `Certified on: the date cannot be before the election (${election.date}).`);
    if (certifiedDate > localDate(now)) no('bad-date', 'Certified on: the date cannot be in the future.');
  }
  return out;
}

/** {metadata, latest?} with the official label and the certification block. */
function relabel(obj, official) {
  const out = { ...obj, metadata: { ...obj.metadata, statusLabel: OFFICIAL_LABEL, official } };
  if (obj.latest && typeof obj.latest === 'object') out.latest = { ...obj.latest, statusLabel: OFFICIAL_LABEL };
  return out;
}

const bundleFromDataJs = (text) => JSON.parse(text.replace(/^[^=]*= /, '').replace(/;\s*$/, ''));

/**
 * The archive's files from a published version's files.
 * @param {{[file: string]: string}} files  summary.json, reporting.json, precincts.json, data.js as published
 * @param {object} a
 * @param {string} a.electionId
 * @param {object} a.election     Firestore election doc (name, date)
 * @param {string} a.version      the published dataVersion being archived
 * @param {string} a.certifiedDate
 * @param {string} a.archivedAt   ISO time
 * @param {string} a.archivedBy
 * @returns {{files: {[file: string]: string}, manifest: string, entry: object}}
 */
function buildArchive(files, { electionId, election, version, certifiedDate, archivedAt, archivedBy }) {
  const official = { certifiedDate, archivedAt, sourceVersion: version };
  const out = {};
  for (const f of ['summary.json', 'reporting.json', 'precincts.json']) out[f] = JSON.stringify(relabel(JSON.parse(files[f]), official));
  out['data.js'] = `${DATA_JS_HEADER}${JSON.stringify(relabel(bundleFromDataJs(files['data.js']), official))};\n`;
  const manifest = JSON.stringify({
    dataVersion: version,
    updatedAt: archivedAt,
    official,
    files: Object.fromEntries(ARCHIVE_FILES.map((f) => [f, sha256Hex(out[f])])),
  });
  const summary = JSON.parse(out['summary.json']);
  const latest = summary.latest || {};
  const entry = {
    id: electionId,
    name: election.name || latest.electionTitle || electionId,
    date: election.date || null,
    title: latest.electionTitle || null,
    county: latest.county || election.county || null,
    certifiedDate,
    archivedAt,
    archivedBy,
    version,
    totalBallots: latest.totalBallots ?? null,
    turnoutPercent: latest.turnoutPercent ?? null,
    contests: Array.isArray(latest.contests) ? latest.contests.length : null,
    precinctPage: !(summary.config && summary.config.enablePrecinctResults === false),
  };
  return { files: out, manifest, entry };
}

/** archive/index.json with `entry` added (or replacing the same election's), newest election first. */
function mergeIndex(existingText, entry, updatedAt) {
  let list = [];
  try {
    const parsed = existingText ? JSON.parse(existingText) : null;
    if (parsed && Array.isArray(parsed.elections)) list = parsed.elections.filter((e) => e && typeof e.id === 'string');
  } catch (e) {
    list = []; // an unreadable index is rebuilt from this entry; the archives themselves are untouched
  }
  list = list.filter((e) => e.id !== entry.id);
  list.push(entry);
  list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.id.localeCompare(b.id));
  return JSON.stringify({ updatedAt, elections: list.slice(0, ARCHIVE_INDEX_MAX) });
}

/**
 * Why the public pages may not be cleared ([] = they may). Only the active election's results are on
 * the public pages, and they must be archived first (the archive of the version that is live now).
 */
function clearRefusals({ election }) {
  const out = [];
  const no = (code, detail) => out.push({ code, detail });
  if (!election.active) no('not-active', 'Only the active election is on the public pages. This election is not active, so there is nothing of it to clear.');
  if (election.currentVersion && election.archive?.version !== election.currentVersion) {
    no('not-archived', election.archive
      ? `The archive is of version ${election.archive.version}, but ${election.currentVersion} is live now. Create the official archive again first, so it has the live results.`
      : 'Create the official archive first. Clearing removes these results from the public pages.');
  }
  return out;
}

/**
 * current/manifest.json while there is no election. It still names dataVersion (as null), which the
 * uptime check looks for (tools/setup-monitoring.js), so clearing does not set off an alert.
 */
function noElectionManifest(updatedAt) {
  return JSON.stringify({ noElection: true, dataVersion: null, updatedAt });
}

module.exports = {
  archiveRefusals, buildArchive, mergeIndex, clearRefusals, noElectionManifest, archivePath, localDate, isDate,
  OFFICIAL_LABEL, ARCHIVE_FILES, ARCHIVE_INDEX, ARCHIVE_CACHE, INDEX_CACHE,
};
