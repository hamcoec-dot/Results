// Layer 12, resilience (plan: Test strategy): the public page under server errors, missing and
// truncated files, a manifest that disagrees with the files, a stalled or slow connection, a skewed
// clock and a tab hidden for hours. It never shows wrong or partial numbers, keeps the last good
// data with a "delayed" status, and recovers on its own. ?emulator points the page at the Storage
// emulator's URLs; page.route answers them from the golden outputs, so no emulator needs to run.
const { test, expect } = require('./fixtures'); // fixtures: the production bucket is never fetched
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const read = (dir, file) => fs.readFileSync(path.join(GOLDEN, dir, file), 'utf8');
const V02 = 'samples-92-02-ev'; // Governor 0 of 92
const V03 = 'samples-92-03-5-reporting'; // Governor 92 of 92

function manifestFor(dir, updatedAt) {
  return {
    dataVersion: JSON.parse(read(dir, 'summary.json')).metadata.dataVersion,
    updatedAt,
    files: Object.fromEntries(['summary.json', 'reporting.json', 'precincts.json']
      .map((f) => [f, crypto.createHash('sha256').update(read(dir, f)).digest('hex')])),
  };
}

/**
 * A fake public bucket. `state.dir` is what current/ holds. `state.fault[file]` overrides one file:
 * { status } answers with that HTTP status, { body } with that text, { hold: true } never answers
 * until `state.release()` is called. `state.manifest(m)` may edit the manifest before it is sent.
 */
async function fakeBucket(page, state) {
  const log = [];
  const held = [];
  state.release = () => { for (const fn of held.splice(0)) fn(); };
  await page.route('http://127.0.0.1:9199/**', async (route) => {
    const object = decodeURIComponent(new URL(route.request().url()).pathname.split('/o/')[1]);
    const file = object.split('/').pop();
    log.push(file);
    const answer = () => {
      const fault = state.fault?.[file] ?? {};
      if (fault.status) return route.fulfill({ status: fault.status, body: '' }).catch(() => {});
      let body = fault.body;
      if (body === undefined) {
        body = file === 'manifest.json'
          ? JSON.stringify((state.manifest ?? ((m) => m))(manifestFor(state.dir, state.updatedAt)))
          : read(state.dir, file);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body }).catch(() => {});
    };
    if (state.fault?.[file]?.hold) held.push(answer);
    else await answer();
  });
  return log;
}

const poll = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const status = (page) => page.locator('#live-status');
const firstCard = (page) => page.locator('#contests-container .reporting-btn').first();
const DELAYED = 'Live updates delayed — retrying';

async function openAt02(page, state) {
  const log = await fakeBucket(page, state);
  await page.goto('index.html?emulator');
  await expect(firstCard(page)).toContainText('0 of 92');
  await expect(status(page)).toHaveText(/^Results updated /);
  return log;
}

/** The page keeps 02's numbers and says it is delayed; once the fault clears, it shows 03. */
async function keepsThenRecovers(page, state) {
  await expect(status(page)).toContainText(DELAYED);
  await expect(firstCard(page)).toContainText('0 of 92');
  state.fault = null;
  state.manifest = null;
  await poll(page);
  await expect(firstCard(page)).toContainText('92 of 92');
  await expect(status(page)).toHaveText(/^Results updated /);
}

const at = '2026-11-03T21:42:00-05:00';
const later = '2026-11-03T21:58:00-05:00';

for (const [name, fault] of [
  ['manifest.json answers 500', { 'manifest.json': { status: 500 } }],
  ['manifest.json answers 404', { 'manifest.json': { status: 404 } }],
  ['summary.json answers 404 after the manifest moved on', { 'summary.json': { status: 404 } }],
  ['summary.json answers 503', { 'summary.json': { status: 503 } }],
  ['summary.json is cut off half way', { 'summary.json': { body: read(V03, 'summary.json').slice(0, 40000) } }],
  ['summary.json is empty', { 'summary.json': { body: '' } }],
  ['summary.json is an HTML error page', { 'summary.json': { body: '<!doctype html><title>502 Bad Gateway</title>' } }],
  ['manifest.json is not JSON', { 'manifest.json': { body: 'not json' } }],
]) {
  test(`${name}: the last good results stay, then it recovers`, async ({ page }) => {
    const state = { dir: V02, updatedAt: at };
    await openAt02(page, state);
    state.dir = V03;
    state.updatedAt = later;
    state.fault = fault;
    await poll(page);
    await keepsThenRecovers(page, state);
  });
}

test('a manifest whose dataVersion disagrees with the files is refused', async ({ page }) => {
  const state = { dir: V02, updatedAt: at };
  await openAt02(page, state);
  state.dir = V03;
  state.manifest = (m) => ({ ...m, dataVersion: 'f'.repeat(m.dataVersion.length) });
  await poll(page);
  await keepsThenRecovers(page, state);
});

test('a manifest whose file hash alone disagrees: the page shows valid files (auditLive is what checks hashes)', async ({ page }) => {
  const state = { dir: V02, updatedAt: at };
  await openAt02(page, state);
  state.dir = V03;
  state.manifest = (m) => ({ ...m, files: { ...m.files, 'summary.json': '0'.repeat(64) } });
  await poll(page);
  // validate.js checks the dataVersion across the files; the page has no hash to compare with, so
  // a hash-only mismatch is shown as long as the files themselves are valid and agree.
  await expect(firstCard(page)).toContainText(/0 of 92|92 of 92/);
  await expect(page.locator('#contests-container')).not.toContainText('NaN');
});

test('one file from a different version than the manifest is refused (a half-finished publish)', async ({ page }) => {
  const state = { dir: V02, updatedAt: at };
  await openAt02(page, state);
  state.dir = V03;
  state.fault = { 'summary.json': { body: read(V02, 'summary.json') } }; // old summary, new manifest
  await poll(page);
  await keepsThenRecovers(page, state);
});

test('a stalled request fails after 20 s, the status says so, and the next try recovers', async ({ page }) => {
  await page.clock.install();
  const state = { dir: V02, updatedAt: at };
  const log = await openAt02(page, state);
  state.dir = V03;
  state.updatedAt = later;
  state.fault = { 'manifest.json': { hold: true } };
  log.length = 0;
  await poll(page);
  await expect.poll(() => log.length).toBe(1);
  await page.clock.runFor(19000);
  await expect(status(page)).toHaveText(/^Results updated /); // still waiting: nothing wrong shown yet
  await page.clock.runFor(2000);
  await expect(status(page)).toContainText(DELAYED);
  await expect(firstCard(page)).toContainText('0 of 92');
  state.release(); // the stalled answer arriving late is ignored
  state.fault = null;
  await page.clock.runFor(16000); // RETRY_DELAY_MS
  await expect(firstCard(page)).toContainText('92 of 92');
  await expect(status(page)).toHaveText(/^Results updated /);
});

test('a slow answer (10 s) is waited for and shown, with no error in between', async ({ page }) => {
  await page.clock.install();
  const state = { dir: V02, updatedAt: at };
  await openAt02(page, state);
  state.dir = V03;
  state.updatedAt = later;
  state.fault = { 'summary.json': { hold: true } };
  await poll(page);
  await page.clock.runFor(10000);
  await expect(firstCard(page)).toContainText('0 of 92');
  await expect(status(page)).toHaveText(/^Results updated /);
  state.fault = null;
  state.release();
  await expect(firstCard(page)).toContainText('92 of 92');
  await expect(status(page)).toHaveText(/^Results updated 9:58 PM$/);
});

test('a network drop (request aborted) keeps the last good results, then recovers', async ({ page }) => {
  const state = { dir: V02, updatedAt: at };
  await openAt02(page, state);
  state.dir = V03;
  await page.route('http://127.0.0.1:9199/**', (route) => route.abort('internetdisconnected'));
  await poll(page);
  await expect(status(page)).toContainText(DELAYED);
  await expect(firstCard(page)).toContainText('0 of 92');
  await page.unroute('http://127.0.0.1:9199/**');
  await fakeBucket(page, state);
  await poll(page);
  await expect(firstCard(page)).toContainText('92 of 92');
});

for (const [name, now] of [['five years fast', '2031-11-03T12:00:00Z'], ['a day slow', '2026-11-02T12:00:00Z']]) {
  test(`a clock ${name}: the time shown is the publish time, and updates still arrive`, async ({ page }) => {
    await page.clock.install({ time: new Date(now) });
    const state = { dir: V02, updatedAt: at };
    await openAt02(page, state);
    await expect(status(page)).toHaveText(/^Results updated 9:42 PM$/);
    state.dir = V03;
    state.updatedAt = later;
    await page.clock.runFor(61000);
    await expect(firstCard(page)).toContainText('92 of 92');
    await expect(status(page)).toHaveText(/^Results updated 9:58 PM$/);
  });
}

test('a tab hidden for 2 hours makes no requests, then shows the newest results at once', async ({ page }) => {
  await page.clock.install();
  const state = { dir: V02, updatedAt: at };
  const log = await openAt02(page, state);
  const setHidden = (hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  log.length = 0;
  state.dir = V03;
  state.updatedAt = later;
  await page.clock.runFor(2 * 60 * 60000);
  await page.waitForTimeout(200);
  expect(log).toEqual([]);
  await expect(firstCard(page)).toContainText('0 of 92');
  await setHidden(false);
  await expect(firstCard(page)).toContainText('92 of 92');
  expect(log).toEqual(['manifest.json', 'summary.json']);
});

test('a failed first load (and no data.js to fall back on) says so, shows no numbers, and fills in once the data is back', async ({ page }) => {
  const state = { dir: V03, updatedAt: at, fault: { 'summary.json': { body: read(V03, 'summary.json').slice(0, 5000) }, 'data.js': { status: 404 } } };
  await fakeBucket(page, state);
  await page.goto('index.html?emulator');
  await expect(status(page)).toContainText(/delayed|could not/i);
  await expect(page.locator('#contests-container .contest-card')).toHaveCount(0);
  state.fault = null;
  await poll(page);
  await expect(firstCard(page)).toContainText('92 of 92');
});

test('a draft whose files are gone says so (no "Retrying": drafts never poll)', async ({ page }) => {
  await page.route('http://127.0.0.1:9199/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('index.html?emulator&draft=0123456789abcdef0123456789abcdef');
  await expect(status(page)).toHaveText(/^This draft could not be loaded\. It may have been published, discarded or expired/);
  await expect(page.locator('.draft-banner')).toBeVisible();
});

test('a failed first load while paused says how to retry; resuming loads the results', async ({ page }) => {
  const state = { dir: V03, updatedAt: at, fault: { 'summary.json': { status: 503 }, 'data.js': { status: 404 } } };
  await fakeBucket(page, state);
  await page.goto('index.html?emulator');
  await expect(status(page)).toContainText('Retrying');
  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(status(page)).toHaveText('Results could not be loaded. Live updates are paused: resume them to try again.');
  state.fault = null;
  await page.getByRole('button', { name: /Resume live updates|Pause live updates/ }).click();
  await expect(firstCard(page)).toContainText('92 of 92');
  await expect(status(page)).toHaveText(/^Results updated /);
});

test('a draft whose files fail the checks says so, not that it is gone', async ({ page }) => {
  const bad = JSON.parse(read(V03, 'summary.json'));
  bad.latest.contests[0].candidates[0].votes = -1;
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname).split('/').pop();
    if (file === 'summary.json') return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(bad) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('index.html?emulator&draft=0123456789abcdef0123456789abcdef');
  await expect(status(page)).toHaveText(/^This draft could not be loaded \(its files failed a check/);
});
