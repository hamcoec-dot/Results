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

const test = base.test.extend({
  prodBucket: [async ({ context }, use) => {
    await routeProdBucket(context);
    await use();
  }, { auto: true }],
});

module.exports = { test, expect: base.expect, routeProdBucket, fixtureData, PROD_BUCKET, FIXTURE_DIR, UPDATED_AT };
