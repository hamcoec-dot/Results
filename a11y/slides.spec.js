// The lobby slideshow and the reporting table say the right thing in the cases the review of
// 2026-10-30 found wrong: ties, multi-seat races, a general election (no primary ballots), and
// contests before any precinct reports. Opened as a draft on the emulator URLs (no polling).
const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const DRAFT_ID = 'fedcba9876543210fedcba9876543210';
const norm = (s) => s.replace(/\s+/g, ' ').trim();

async function open(page, file, dir) {
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const f = path.join(GOLDEN, dir, name);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) });
  });
  await page.goto(`${file}?emulator&draft=${DRAFT_ID}`);
}

async function slideFor(page, title) {
  await page.locator('#slide-viewport .slide-card').first().waitFor();
  const options = (await page.locator('#slide-jump-menu option').allTextContents()).map(norm);
  const at = options.findIndex((t) => t.includes(`: ${title}`));
  expect(at, `a slide for ${title}`).toBeGreaterThanOrEqual(0);
  await page.selectOption('#slide-jump-menu', { index: at });
  return norm(await page.locator('#slide-viewport').textContent());
}

test('summary slide: a general election shows ballots by voting method, not empty primary rows', async ({ page }) => {
  const s = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'samples-92-05-end-ed', 'summary.json'))).latest;
  await open(page, 'scrolling.html', 'samples-92-05-end-ed');
  await page.locator('#slide-viewport .slide-card').first().waitFor();
  const text = norm(await page.locator('#slide-viewport').textContent());
  expect(text).not.toContain('Primary');
  const early = s.earlyBallotsCast.toLocaleString('en-US');
  const ed = (s.totalBallots - s.earlyBallotsCast).toLocaleString('en-US');
  expect(text).toContain(`Early Voting & Absentee ${early}`);
  expect(text).toContain(`Election Day & Provisional ${ed}`);
});

test('contest slides: a tie says Tied, a multi-seat race shows the closest seat', async ({ page }) => {
  await open(page, 'scrolling.html', 'samples-92-05-end-ed');
  // Governor: seven candidates share the top count.
  const governor = await slideFor(page, 'Governor');
  expect(governor).toContain('Lead Margin Tied');
  expect(governor).toContain('7 candidates are tied at');
  expect(governor).not.toContain('+ 0 votes');
  // Collegedale, vote for 2: 14, 14, 7, 7, 7.
  const collegedale = await slideFor(page, 'Collegedale Commissioner');
  expect(collegedale).toContain('Closest Seat (2 to elect) + 7 votes');
  // Signal Mountain, vote for 4: five candidates at 18.
  const signal = await slideFor(page, 'Signal Mountain Town Council');
  expect(signal).toContain('5 candidates are tied for the last seat');
  // Unopposed: no margin card.
  const unopposed = await slideFor(page, 'Walden Alderman');
  expect(unopposed).not.toContain('Lead Margin');
});

test('reporting page: contests with no precincts in say NOT YET REPORTING', async ({ page }) => {
  await open(page, 'reporting.html', 'samples-92-00-zero');
  const rows = page.locator('#reporting-table-body tr');
  await expect(rows.first()).toContainText('NOT YET REPORTING');
  const statuses = await rows.evaluateAll((trs) => trs.map((tr) => tr.cells[3].textContent.trim()));
  statuses.forEach((t) => expect(t).toContain('NOT YET REPORTING'));
  await expect(page.locator('#early-reporting-table-body')).toContainText('PENDING');
});

test('reporting page on a phone: rows stack, nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await open(page, 'reporting.html', 'samples-92-04-10-reporting');
  await page.locator('#reporting-table-body tr').first().waitFor();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(over).toBeLessThanOrEqual(0);
  const region = await page.locator('#reporting-table-body').evaluate((el) => {
    const r = el.closest('.table-responsive');
    return r.scrollWidth - r.clientWidth;
  });
  expect(region, 'the table fits without sideways scrolling').toBeLessThanOrEqual(1);
});

for (const enabled of [true, false]) {
  test(`the "precinct results in 1 to 2 business days" notice shows only while the precinct page is off (${enabled ? 'on' : 'off'})`, async ({ page }) => {
    const dir = path.join(GOLDEN, 'samples-92-05-end-ed');
    await page.route('http://127.0.0.1:9199/**', (route) => {
      const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
      if (!fs.existsSync(path.join(dir, name))) return route.fulfill({ status: 404, body: '' });
      const body = JSON.parse(fs.readFileSync(path.join(dir, name)));
      if (body.config) body.config.enablePrecinctResults = enabled;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
    await page.goto(`index.html?emulator&draft=${DRAFT_ID}`);
    await page.locator('#contests-container > article').first().waitFor();
    await expect(page.locator('.precinct-delay-notice')).toBeVisible({ visible: !enabled });
    await page.goto(`scrolling.html?emulator&draft=${DRAFT_ID}`);
    await page.locator('#slide-viewport .slide-card').first().waitFor();
    await expect(page.locator('#slide-viewport')).toContainText('Reporting Notice');
    await expect(page.locator('#slide-viewport .precinct-delay-notice')).toHaveCount(enabled ? 0 : 1);
  });
}

test('precinct page: the party tabs work in a general election, and By Contest hides them', async ({ page }) => {
  const p = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'samples-92-05-end-ed', 'precincts.json')));
  const name = p.masterPrecincts[p.contests[0].precinctsStatusIndexed[0][0]];
  await open(page, `precincts.html`, 'samples-92-05-end-ed');
  await page.locator('#precinct-results-container article').first().waitFor();
  await page.selectOption('#precinct-select', name);
  const withRep = p.contests.filter((c) => c.precinctsStatusIndexed.some(([k]) => p.masterPrecincts[k] === name) && c.candidates.some((x) => x.party === 'REP'));
  expect(withRep.length).toBeGreaterThan(0);
  await page.click('.tab-btn[data-precinct-party="REP"]');
  await expect(page.locator('#precinct-results-container article')).toHaveCount(withRep.length);
  // A general election has no REP / DEM / GEN ballot counts: the three zero pills are hidden.
  await expect(page.locator('.ballot-breakdown-pills')).toBeHidden();
  await page.click('#view-mode-contest-btn');
  await expect(page.locator('.tab-btn[data-precinct-party="REP"]')).toBeHidden();
  await expect(page.locator('#precinct-search')).toHaveAttribute('aria-label', 'Search precinct name');
});
