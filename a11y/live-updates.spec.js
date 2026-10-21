// Live updates on the public pages (plan: Performance › cheap polling; Accessibility › 2.2.2, 4.1.3).
// ?emulator points the pages at the Storage emulator's URLs; page.route answers those from the
// golden outputs, so no emulator needs to run. A poll is triggered with a visibilitychange event
// (the page checks at once when it becomes visible) instead of waiting 60 s.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const read = (dir, file) => fs.readFileSync(path.join(GOLDEN, dir, file));
const V02 = 'samples-92-02-ev'; // Governor 0 of 92
const V03 = 'samples-92-03-5-reporting'; // Governor 92 of 92

const DRAFT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function manifestFor(dir, updatedAt) {
  const summary = read(dir, 'summary.json');
  return JSON.stringify({
    dataVersion: JSON.parse(summary).metadata.dataVersion,
    updatedAt,
    files: Object.fromEntries(['summary.json', 'reporting.json', 'precincts.json']
      .map((f) => [f, crypto.createHash('sha256').update(read(dir, f)).digest('hex')])),
  });
}

/** A fake public bucket: `state.dir` is what current/ holds; every request is logged. */
async function fakeBucket(page, state) {
  const log = [];
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const object = decodeURIComponent(new URL(route.request().url()).pathname.split('/o/')[1]);
    log.push(object);
    const [prefix, ...rest] = object.split('/');
    const file = rest.pop();
    let body;
    if (prefix === 'current' && file === 'manifest.json') body = manifestFor(state.dir, state.updatedAt);
    else if (prefix === 'current' || (prefix === 'drafts' && rest[0] === DRAFT_ID)) body = state.override?.[file] ?? read(state.dir, file);
    if (body === undefined) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  });
  return log;
}

const poll = (page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const status = (page) => page.locator('#live-status');
const firstCard = (page) => page.locator('#contests-container .reporting-btn').first();

test('polls only the manifest until its dataVersion changes, then re-renders in place', async ({ page }) => {
  const state = { dir: V02, updatedAt: '2026-11-03T21:42:00-05:00' };
  const log = await fakeBucket(page, state);
  await page.goto('index.html?emulator');
  await expect(firstCard(page)).toContainText('0 of 92');
  await expect(status(page)).toHaveText(/^Results updated \d{1,2}:\d{2} [AP]M$/);
  expect(log).toEqual(['current/manifest.json', 'current/summary.json']);

  log.length = 0;
  await poll(page);
  await expect.poll(() => log.length).toBe(1);
  expect(log).toEqual(['current/manifest.json']);

  // New version: the page fetches its data once, and keeps focus on the same control.
  await firstCard(page).focus();
  state.dir = V03;
  state.updatedAt = '2026-11-03T21:58:00-05:00';
  log.length = 0;
  await poll(page);
  await expect(firstCard(page)).toContainText('92 of 92');
  expect(log).toEqual(['current/manifest.json', 'current/summary.json']);
  await expect(firstCard(page)).toBeFocused();
});

test('invalid data is not shown: the last good results stay, with a "delayed" status', async ({ page }) => {
  const state = { dir: V02, updatedAt: '2026-11-03T21:42:00-05:00' };
  await fakeBucket(page, state);
  await page.goto('index.html?emulator');
  await expect(firstCard(page)).toContainText('0 of 92');

  state.dir = V03;
  const bad = JSON.parse(read(V03, 'summary.json'));
  bad.latest.contests[0].candidates[0].votes = -1;
  state.override = { 'summary.json': JSON.stringify(bad) };
  await poll(page);
  await expect(status(page)).toContainText('Live updates delayed — retrying');
  await expect(firstCard(page)).toContainText('0 of 92');

  state.override = null;
  await poll(page);
  await expect(firstCard(page)).toContainText('92 of 92');
  await expect(status(page)).toHaveText(/^Results updated /);
});

test('"Pause live updates" stops polling and is remembered for the session', async ({ page }) => {
  const state = { dir: V02, updatedAt: '2026-11-03T21:42:00-05:00' };
  const log = await fakeBucket(page, state);
  await page.goto('index.html?emulator');
  const toggle = page.getByRole('button', { name: 'Pause live updates' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(status(page)).toContainText('Live updates paused');

  log.length = 0;
  await poll(page);
  await page.waitForTimeout(300);
  expect(log).toEqual([]);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Pause live updates' })).toHaveAttribute('aria-pressed', 'true');
  state.dir = V03;
  await page.getByRole('button', { name: 'Pause live updates' }).click();
  await expect(firstCard(page)).toContainText('92 of 92');
});

test('a draft view never polls and exports DRAFT_ files', async ({ page }) => {
  const state = { dir: V02 };
  const log = await fakeBucket(page, state);
  await page.goto(`index.html?emulator&draft=${DRAFT_ID}`);
  await expect(firstCard(page)).toContainText('0 of 92');
  await expect(page.getByRole('button', { name: 'Pause live updates' })).toBeHidden();
  await poll(page);
  await page.waitForTimeout(300);
  expect(log).toEqual([`drafts/${DRAFT_ID}/summary.json`]);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export CSV/ }).click()]);
  expect(download.suggestedFilename()).toBe('DRAFT_Hamilton_Election_Summary_Results.csv');
});

test('the summary page loads reporting.json only when the precinct dialog opens', async ({ page }) => {
  const state = { dir: V03, updatedAt: '2026-11-03T21:42:00-05:00' };
  const log = await fakeBucket(page, state);
  await page.goto('index.html?emulator');
  await firstCard(page).click();
  await expect(page.locator('#modal-precinct-grid .precinct-chip')).toHaveCount(92);
  await expect(page.locator('#modal-precinct-grid .precinct-chip.reported')).toHaveCount(92);
  expect(log).toContain('current/reporting.json');
  await expect(page.locator('#precinct-modal .modal-close-btn')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(firstCard(page)).toBeFocused();
});

test('the reporting page shows exact per-precinct flags from reporting.json', async ({ page }) => {
  await fakeBucket(page, { dir: V03, updatedAt: '2026-11-03T21:42:00-05:00' });
  await page.goto('reporting.html?emulator');
  const reporting = JSON.parse(read(V03, 'reporting.json'));
  const c = reporting.latest.contests[0];
  const expected = c.precinctsStatusIndexed.filter(([, r]) => r === 1).map(([i]) => reporting.masterPrecincts[i]).sort();
  await page.locator('#reporting-table-body .reporting-btn').first().click();
  await page.getByRole('button', { name: /Reported/ }).click();
  const shown = await page.locator('#modal-precinct-grid .precinct-chip span:first-child').allTextContents();
  expect(shown.sort()).toEqual(expected);
});
