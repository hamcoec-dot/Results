// Shared Playwright fixtures for every spec: `require('./fixtures')` instead of '@playwright/test'.
//
// The public pages read the production bucket by default (results-config.js PUBLIC_BASE). No test
// may fetch the real bucket, so every browser context answers https://storage.googleapis.com/** here:
// the production bucket's current/ is served from a golden output (FIXTURE_DIR) with a manifest.json
// built the way publishDraft writes it; anything else on storage.googleapis.com is a 404.
// A spec's own page.route (drafts, failures) wins over this context route.
const base = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROD_BUCKET = 'https://storage.googleapis.com/hcec-election-results-results/';
/** What the default-mode tests see in the bucket's current/: the August 2026 test files, early vote (63 contests, valid). */
const FIXTURE_DIR = path.join(__dirname, '..', 'functions', 'test', 'golden', 'testfiles-ev');
const UPDATED_AT = '2026-08-06T19:58:00-04:00';
const DATA_FILES = ['summary.json', 'reporting.json', 'precincts.json', 'data.js'];

const fixtureData = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));

function manifestFor(dir) {
  const read = (f) => fs.readFileSync(path.join(dir, f));
  return JSON.stringify({
    dataVersion: JSON.parse(read('summary.json')).metadata.dataVersion,
    updatedAt: UPDATED_AT,
    files: Object.fromEntries(['summary.json', 'reporting.json', 'precincts.json']
      .map((f) => [f, crypto.createHash('sha256').update(read(f)).digest('hex')])),
  });
}

/** Answer the production bucket for a page or browser context; `log` (optional) collects the object paths asked for. */
async function routeProdBucket(target, { dir = FIXTURE_DIR, log } = {}) {
  await target.route('https://storage.googleapis.com/**', (route) => {
    const url = new URL(route.request().url());
    const cors = { 'access-control-allow-origin': '*' };
    const prefix = new URL(PROD_BUCKET).pathname + 'current/';
    const file = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
    if (log) log.push(url.pathname);
    let body;
    if (file === 'manifest.json') body = manifestFor(dir);
    else if (DATA_FILES.includes(file) && fs.existsSync(path.join(dir, file))) body = fs.readFileSync(path.join(dir, file));
    if (body === undefined) return route.fulfill({ status: 404, headers: cors, body: '' });
    const contentType = file.endsWith('.js') ? 'text/javascript' : 'application/json';
    return route.fulfill({ status: 200, contentType, headers: cors, body });
  });
}

const ARCHIVE_ID = '2026-08-06-general';
const CERTIFIED = '2026-08-20';

/** An official archive of a golden output, built the way archiveElection builds it (functions/src/archive.js). */
function archiveFor(dir = FIXTURE_DIR, { electionId = ARCHIVE_ID, certifiedDate = CERTIFIED } = {}) {
  const { buildArchive } = require('../functions/src/archive');
  const files = Object.fromEntries(DATA_FILES.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const version = JSON.parse(files['summary.json']).metadata.dataVersion;
  return buildArchive(files, {
    electionId, election: { name: '2026-08-06 General', date: '2026-08-06' }, version, certifiedDate,
    archivedAt: '2026-08-21T14:00:00.000Z', archivedBy: 'admin@example.gov',
  });
}

/**
 * Answer the production bucket's archive/ for a page: archive/<id>/ from a golden output, and
 * archive/index.json listing it (or `index`, a status number or an object). `log` collects the paths asked for.
 */
async function routeArchive(page, { dir = FIXTURE_DIR, electionId = ARCHIVE_ID, index, log } = {}) {
  const built = archiveFor(dir, { electionId });
  const prefix = new URL(PROD_BUCKET).pathname;
  await page.route('https://storage.googleapis.com/**', (route) => {
    const url = new URL(route.request().url());
    if (log) log.push(url.pathname);
    const cors = { 'access-control-allow-origin': '*' };
    const object = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
    if (object === 'archive/index.json') {
      if (typeof index === 'number') return route.fulfill({ status: index, headers: cors, body: '' });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(index || { updatedAt: 't', elections: [built.entry] }) });
    }
    const file = object.startsWith(`archive/${electionId}/`) ? object.slice(`archive/${electionId}/`.length) : null;
    const body = file === 'manifest.json' ? built.manifest : file ? built.files[file] : undefined;
    if (body === undefined) return route.fallback();
    return route.fulfill({ status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : 'application/json', headers: cors, body });
  });
  return built;
}

/** The production bucket's current/ between elections (clearCurrentResults): a "no election" manifest, no data files. */
async function routeNoElection(target, { log } = {}) {
  const { noElectionManifest } = require('../functions/src/archive');
  await target.route('https://storage.googleapis.com/**', (route) => {
    const url = new URL(route.request().url());
    if (log) log.push(url.pathname);
    const cors = { 'access-control-allow-origin': '*' };
    if (url.pathname.endsWith('/current/manifest.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: noElectionManifest('2026-11-20T17:00:00.000Z') });
    }
    if (url.pathname.includes('/current/')) return route.fulfill({ status: 404, headers: cors, body: '' });
    return route.fallback();
  });
}

const test = base.test.extend({
  prodBucket: [async ({ context }, use) => {
    await routeProdBucket(context);
    await use();
  }, { auto: true }],
});

/**
 * The contest name the pages show (app.js displayContestTitle): a title ending with the words it
 * starts with ("East Ridge Mayor East Ridge") loses the trailing copy.
 */
function shownTitle(title) {
  const w = title.trim().split(/\s+/);
  for (let n = Math.floor((w.length - 1) / 2); n >= 1; n--) {
    if (w.slice(0, n).join(' ').toLowerCase() === w.slice(-n).join(' ').toLowerCase()) return w.slice(0, -n).join(' ');
  }
  return title;
}

module.exports = {
  test, expect: base.expect, routeProdBucket, routeArchive, routeNoElection, archiveFor, fixtureData, shownTitle,
  PROD_BUCKET, FIXTURE_DIR, UPDATED_AT, ARCHIVE_ID, CERTIFIED,
};
