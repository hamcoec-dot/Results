// Layer 8 (plan: Test strategy): hostile names in the data render as plain text on every public
// page, with no script run, no dialog, no injected element and no console error. The golden 03
// files are served with one candidate and one contest renamed, in every file at once.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'functions', 'test', 'golden', 'samples-92-03-5-reporting');
const FILES = ['summary.json', 'reporting.json', 'precincts.json'];
const original = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]));

const CANDIDATE = `<img src=x onerror="window.__xss=1"> Bob "O'Neil" & <b>Co</b>`;
const CONTEST = `Gov<script>window.__xss=2</script>ernor <svg onload="window.__xss=3">`;
const summary = JSON.parse(original['summary.json']);
const contest = summary.latest.contests[0];
const candidate = contest.candidates[0].name;
// JSON text of a string, without its quotes: what to swap inside each file's raw text.
const inner = (s) => JSON.stringify(s).slice(1, -1);
const swap = (text) => text.split(`"${inner(candidate)}"`).join(`"${inner(CANDIDATE)}"`)
  .split(`"${inner(contest.title)}"`).join(`"${inner(CONTEST)}"`);
const files = Object.fromEntries(FILES.map((f) => [f, swap(original[f])]));

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => { throw new Error(`dialog opened: ${d.message()}`); });
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname).split('/').pop();
    const body = file === 'manifest.json'
      ? JSON.stringify({ dataVersion: summary.metadata.dataVersion, updatedAt: '2026-11-03T21:42:00-05:00',
        files: Object.fromEntries(FILES.map((f) => [f, crypto.createHash('sha256').update(files[f]).digest('hex')])) })
      : files[file];
    if (body === undefined) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  });
});

test('the hostile names are really in the served data', () => {
  // reporting.json has no candidate names; every file has the contest titles.
  for (const f of ['summary.json', 'precincts.json']) expect(files[f]).toContain(inner(CANDIDATE));
  for (const f of FILES) expect(files[f]).toContain(inner(CONTEST));
});

async function assertInert(page) {
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  // No element from the names made it into the page.
  expect(await page.locator('img[src="x"], svg[onload], b:text("Co")').count()).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll('script')].filter((s) => s.textContent.includes('__xss')).length)).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => a.value.includes('__xss') && a.name.startsWith('on'))))).toBe(false);
}

for (const [file, shows] of [
  ['index.html', async (page) => {
    await expect(page.locator('#contests-container')).toContainText(CANDIDATE, { timeout: 15000 });
    await expect(page.locator('#contests-container')).toContainText(CONTEST);
    await page.locator('#contests-container .reporting-btn').first().click(); // the precinct dialog
    await expect(page.locator('[role="dialog"]').first()).toBeVisible();
  }],
  ['reporting.html', async (page) => {
    await expect(page.locator('body')).toContainText(CONTEST, { timeout: 15000 });
  }],
  ['precincts.html', async (page) => {
    await expect(page.locator('body')).toContainText(CANDIDATE, { timeout: 15000 });
  }],
  ['scrolling.html', async (page) => {
    await expect(page.locator('body')).toContainText(/Gov<script>|Bob "O'Neil"/, { timeout: 15000 });
  }],
]) {
  test(`${file}: hostile names show as text and run nothing`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${file}?emulator`);
    await shows(page);
    await page.waitForTimeout(300);
    await assertInert(page);
    expect(errors).toEqual([]);
  });
}

test('summary search with the hostile name finds it and stays inert', async ({ page }) => {
  await page.goto('index.html?emulator');
  await expect(page.locator('#contests-container')).toContainText(CANDIDATE, { timeout: 15000 });
  await page.fill('#contest-search', 'gov<script>');
  await expect(page.locator('#contests-container')).toContainText(CONTEST);
  await assertInert(page);
});

test('summary export: names that look like spreadsheet formulas are exported as text', async ({ page }) => {
  const FORMULA = '=HYPERLINK("http://example.test","click")';
  const AT = '@SUM(1+1)';
  const served = Object.fromEntries(FILES.map((f) => [f, original[f]
    .split(`"${inner(candidate)}"`).join(`"${inner(FORMULA)}"`)
    .split(`"${inner(contest.title)}"`).join(`"${inner(AT)}"`)]));
  await page.unroute('http://127.0.0.1:9199/**');
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname).split('/').pop();
    const body = file === 'manifest.json'
      ? JSON.stringify({ dataVersion: summary.metadata.dataVersion, updatedAt: '2026-11-03T21:42:00-05:00', files: {} })
      : served[file];
    return body === undefined ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  });
  await page.goto('index.html?emulator');
  await expect(page.locator('#contests-container')).toContainText(FORMULA, { timeout: 15000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export CSV/ }).click()]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  // Quoted, with a leading apostrophe so a spreadsheet shows the text instead of running it.
  expect(text).toContain(`"'=HYPERLINK(""http://example.test"",""click"")"`);
  expect(text).toContain(`"'@SUM(1+1)"`);
  expect(text).not.toMatch(/(^|,)"[=+@]/m);
});
