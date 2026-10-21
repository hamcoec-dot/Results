'use strict';
/**
 * Pure publish rules (plan: Cloud Functions › publishDraft / extendDraft, Test strategy › publishLock).
 * The callables in index.js do the I/O; every decision lives here so it is unit-tested.
 *
 *   publishRefusals(...)  why a draft may not be published ([] = it may)
 *   copyPlan(...)         the exact copy steps, in the order the pages need
 *   buildManifest(...)    manifest.json (written at publish): dataVersion, publish time, sha256 of every file
 *   acquireLock / releaseLock   the 60 s publish lease held in elections/{eid}.publishLock
 *   extendRefusals / expiryFrom draft lifetime (WCAG 2.2.1: the reviewer can extend it)
 */
const crypto = require('node:crypto');

const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60 * 1000;
const DRAFT_ID_RE = /^[0-9a-f]{32}$/;
const ELECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Files a draft publishes, in copy order: these three in parallel, then summary, then manifest. */
const PAGE_FILES = ['precincts.json', 'reporting.json', 'data.js'];
const SUMMARY_FILE = 'summary.json';
const MANIFEST_FILE = 'manifest.json';
const REVIEW_FILES = ['review.json', 'trace.json'];

const newDraftId = () => crypto.randomBytes(16).toString('hex');
const isDraftId = (s) => typeof s === 'string' && DRAFT_ID_RE.test(s);
const isElectionId = (s) => typeof s === 'string' && ELECTION_ID_RE.test(s);
const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const expiryFrom = (nowMs) => nowMs + DRAFT_TTL_MS;

/**
 * @param {object} a
 * @param {object} a.draft         Firestore draft doc: {status, checks, baseVersion, expiresAt (ms), outputSha256, confirmCount}
 * @param {object} a.election      {currentVersion}
 * @param {string[]} a.acknowledged  keys of the warn checks the reviewer ticked
 * @param {number} a.confirmCount  precincts-reporting number the reviewer typed
 * @param {number} a.now           ms
 * @param {object|null} a.rehashed {file: sha256} of the draft objects as stored now, or null if not yet read
 * @returns {{code: string, detail: string}[]}
 */
function publishRefusals({ draft, election, acknowledged = [], confirmCount, now, rehashed = null }) {
  const out = [];
  const no = (code, detail) => out.push({ code, detail });
  if (!draft) return [{ code: 'not-found', detail: 'No such draft.' }];
  if (draft.status !== 'ready') no('not-ready', `Draft is ${draft.status}.`);
  const blocks = draft.checks.filter((c) => c.severity === 'block');
  if (blocks.length) no('blocked', `${blocks.length} blocking check(s): ${blocks.map((c) => c.title).join('; ')}.`);
  const ack = new Set(acknowledged);
  const missing = draft.checks.filter((c) => c.severity === 'warn' && !ack.has(c.key));
  if (missing.length) no('unacknowledged', `${missing.length} warning(s) not acknowledged: ${missing.map((c) => c.key).join(', ')}.`);
  if ((draft.baseVersion ?? null) !== (election.currentVersion ?? null)) {
    no('stale', `Someone published ${election.currentVersion} after this draft was made from ${draft.baseVersion ?? 'nothing'}. Create a new draft.`);
  }
  if (now >= draft.expiresAt) no('expired', 'Draft expired. Extend it or upload again.');
  if (confirmCount !== draft.confirmCount) {
    no('confirm-mismatch', `Typed ${confirmCount}, but the draft has ${draft.confirmCount} precincts reporting.`);
  }
  if (rehashed) {
    const bad = Object.entries(draft.outputSha256).filter(([f, h]) => rehashed[f] !== h).map(([f]) => f);
    if (bad.length) no('tampered', `Stored draft files changed since review: ${bad.join(', ')}.`);
  }
  return out;
}

const EXTEND_CODES = new Set(['not-found', 'not-ready', 'stale', 'tampered']);

/**
 * extendDraft: only the integrity rules apply (exists, ready, not stale, files untouched). An
 * expired draft can be extended too — its files are re-hashed first, and the bucket lifecycle
 * deletes drafts after 2 days regardless.
 */
function extendRefusals({ draft, election, now, rehashed }) {
  return publishRefusals({ draft, election, now, rehashed }).filter((r) => EXTEND_CODES.has(r.code));
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
const LIVE = 'public, max-age=15';

/**
 * Copy steps: draft -> versioned archive, then the live current/ files in the order the pages
 * need (data files, then summary). manifest.json is not copied: publishDraft writes it last, fresh,
 * with the publish time — pages poll the manifest and trust the files once it changes.
 * @returns {{from: string, to: string, cacheControl: string}[][]} stages; copies in a stage may run in parallel
 */
function copyPlan({ electionId, draftId, dataVersion }) {
  if (!isElectionId(electionId) || !isDraftId(draftId) || !/^[0-9a-f]{12}$/.test(dataVersion)) {
    throw new TypeError('bad ids for copyPlan');
  }
  const src = (f) => `drafts/${draftId}/${f}`;
  const ver = (f) => versionPath(electionId, dataVersion, f);
  const live = (f) => `current/${f}`;
  return [
    [...PAGE_FILES, SUMMARY_FILE].map((f) => ({ from: src(f), to: ver(f), cacheControl: IMMUTABLE })),
    PAGE_FILES.map((f) => ({ from: ver(f), to: live(f), cacheControl: LIVE })),
    [{ from: ver(SUMMARY_FILE), to: live(SUMMARY_FILE), cacheControl: LIVE }],
  ];
}

const versionPath = (electionId, dataVersion, file) => `elections/${electionId}/v/${dataVersion}/${file}`;

/** current/manifest.json for a set of output files ({name: text}). */
function buildManifest(files, { dataVersion, updatedAt }) {
  const names = [...PAGE_FILES, SUMMARY_FILE].filter((f) => f in files);
  return { dataVersion, updatedAt, files: Object.fromEntries(names.map((f) => [f, sha256Hex(files[f])])) };
}

/**
 * Publish lease: returns the lock to write, or throws {code: 'busy'} while another holder's lease runs.
 * Call inside the same Firestore transaction that reads election.currentVersion.
 */
function acquireLock(current, { holder, now }) {
  if (current && current.holder !== holder && now < current.until) {
    const e = new Error(`Another publish is in progress (until ${new Date(current.until).toISOString()}).`);
    e.code = 'busy';
    throw e;
  }
  return { holder, until: now + LOCK_TTL_MS };
}

/** The lock value after `holder` finishes: cleared only if it is still theirs. */
function releaseLock(current, { holder }) {
  return current && current.holder === holder ? null : current;
}

module.exports = {
  publishRefusals, extendRefusals, copyPlan, buildManifest, acquireLock, releaseLock, newDraftId, isDraftId, isElectionId,
  sha256Hex, expiryFrom, versionPath, DRAFT_TTL_MS, LOCK_TTL_MS, PAGE_FILES, SUMMARY_FILE, MANIFEST_FILE, REVIEW_FILES, IMMUTABLE, LIVE,
};
