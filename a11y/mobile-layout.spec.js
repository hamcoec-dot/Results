// Phone layout (2026-11-04, after the precinct cards' candidate rows overlapped on phones): every
// public page and every precinct view, at phone widths in Chromium and on the emulated Pixel 7 and
// iPhone 14 (npm run e2e:browsers), must have
//   - no text drawn over other text (each text line's boxes, compared within its card, row or group)
//   - no text past the right edge of the screen, except inside a sideways-scrolling table region
//   - no horizontal page scroll.
// The precinct page is checked with an early / Election Day split, so the extra lines are on screen.
const { test, expect, routeArchive, routeNoElection, ARCHIVE_ID } = require('./fixtures');
const { layoutProblems } = require('./layout-check');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const DRAFT_ID = 'abcdef0123456789abcdef0123456789';
const WIDTHS = [320, 375, 414];

/** samples-92-05-end-ed with a synthetic early split (half of every number early). */
function withSplit() {
  const p = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'samples-92-05-end-ed', 'precincts.json'), 'utf8'));
  const half = (n) => Math.floor(n / 2);
  p.earlyByPrecinct = {
    ballots: Object.fromEntries(Object.entries(p.precinctStats).map(([n, s]) => [n, half(s.ballots)])),
    contests: p.contests.map((c) => c.candidates.map((x) => Object.fromEntries(Object.entries(x.precinctVotes).map(([n, v]) => [n, half(v)])))),
  };
  return p;
}

/** samples-92-05-end-ed's summary.json with synthetic countywide early totals (a third of every number early). */
function summaryWithSplit() {
  const s = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'samples-92-05-end-ed', 'summary.json'), 'utf8'));
  const third = (n) => Math.floor((n || 0) / 3);
  const l = s.latest;
  l.earlyTotals = {
    ballots: third(l.totalBallots), ballotsRep: third(l.ballotsRep), ballotsDem: third(l.ballotsDem), ballotsGen: third(l.ballotsGen),
    contests: l.contests.map((c) => c.candidates.map((x) => third(x.votes))),
  };
  return s;
}

async function openSummary(page) {
  const summary = JSON.stringify(summaryWithSplit());
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const cors = { 'access-control-allow-origin': '*' };
    if (name === 'summary.json') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: summary });
    const f = path.join(GOLDEN, 'samples-92-05-end-ed', name);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: fs.readFileSync(f) });
  });
  await page.goto(`index.html?emulator&draft=${DRAFT_ID}`);
  await page.locator('#contests-container article').first().waitFor();
}

async function openPrecincts(page) {
  const precincts = JSON.stringify(withSplit());
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const cors = { 'access-control-allow-origin': '*' };
    if (name === 'precincts.json') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: precincts });
    const f = path.join(GOLDEN, 'samples-92-05-end-ed', name);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: fs.readFileSync(f) });
  });
  await page.goto(`precincts.html?emulator&draft=${DRAFT_ID}`);
  await page.locator('#precinct-results-container > *').first().waitFor();
}

async function check(page, what) {
  await page.waitForTimeout(150);
  const problems = await page.evaluate(layoutProblems);
  expect(problems, `${what}:\n  ${problems.slice(0, 15).join('\n  ')}`).toEqual([]);
}

/** Chromium runs each width; the phone projects (Pixel 7, iPhone 14) keep their own screen. */
function widthsFor(testInfo) {
  return testInfo.project.name === 'chromium' ? WIDTHS : [null];
}

for (const [file, ready] of [['index.html', '#contests-container article'], ['reporting.html', '#reporting-table-body tr'], ['scrolling.html', '#slide-viewport > *']]) {
  test(`phone layout: ${file}`, async ({ page }, testInfo) => {
    for (const w of widthsFor(testInfo)) {
      if (w) await page.setViewportSize({ width: w, height: 800 });
      await page.goto(file);
      await page.locator(ready).first().waitFor();
      await check(page, `${file} @ ${w || testInfo.project.name}`);
    }
  });
}

test('phone layout: summary page, every ballots choice', async ({ page }, testInfo) => {
  for (const w of widthsFor(testInfo)) {
    if (w) await page.setViewportSize({ width: w, height: 800 });
    await openSummary(page);
    for (const scope of ['ALL', 'EARLY', 'ED']) {
      await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
      await check(page, `index.html ${scope} @ ${w || testInfo.project.name}`);
      // The switch fits on the screen: its three buttons are side by side and none is cut off.
      const boxes = await page.locator('#ballot-scope-tabs .tab-btn').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
      const vw = await page.evaluate(() => document.documentElement.clientWidth);
      for (const b of boxes) expect(b.right, 'ballots button inside the screen').toBeLessThanOrEqual(vw + 1);
    }
  }
});

test('phone layout: precinct page, every view and every ballots choice', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  for (const w of widthsFor(testInfo)) {
    if (w) await page.setViewportSize({ width: w, height: 800 });
    await openPrecincts(page);
    const at = w || testInfo.project.name;
    for (const [view, btn] of [['By Precinct', '#view-mode-precinct-btn'], ['By Contest', '#view-mode-contest-btn'], ['Turnout', '#view-mode-turnout-btn'], ['Map', '#view-mode-map-btn']]) {
      await page.click(btn);
      if (view === 'Map') await page.locator('.precinct-map-svg path').first().waitFor();
      for (const scope of ['ALL', 'EARLY', 'ED']) {
        await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
        await check(page, `precincts.html ${view} / ${scope} @ ${at}`);
      }
    }
    // The map's pop-up panel after picking a precinct.
    await page.locator('.precinct-map-svg path[data-map-precinct]').first().click({ force: true });
    await check(page, `precincts.html Map with a precinct picked @ ${at}`);
  }
});

// The official archive (with its banner), the past elections list and the "no current election" message.
for (const [what, file, ready, route] of [
  ['archived summary page', `index.html?election=${ARCHIVE_ID}`, '#contests-container article', routeArchive],
  ['archived precinct page', `precincts.html?election=${ARCHIVE_ID}`, '#precinct-results-container > *', routeArchive],
  ['past elections list', 'archive.html', '#archive-list > li', routeArchive],
  ['no current election (summary)', 'index.html', '#no-election-note', routeNoElection],
  ['no current election (slides)', 'scrolling.html', '#no-election-note', routeNoElection],
]) {
  test(`phone layout: ${what}`, async ({ page }, testInfo) => {
    await route(page);
    for (const w of widthsFor(testInfo)) {
      if (w) await page.setViewportSize({ width: w, height: 800 });
      await page.goto(file);
      await page.locator(ready).first().waitFor();
      await check(page, `${what} @ ${w || testInfo.project.name}`);
    }
  });
}
