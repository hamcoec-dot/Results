// The summary page's ballots switch (2026-11-16): All Ballots / Early & Absentee / Election Day, like
// the precinct page's. summary.json's latest.earlyTotals (fix d5) carries each candidate's countywide
// early & absentee votes and the early ballots; Election Day = all - early. The switch is shown only
// when the file carries the split, is kept in the URL (?ballots=EARLY|ED), changes the ballots,
// turnout and every contest card, and hides LEADING outside All Ballots. Runs on the phone projects
// too (BEHAVIOUR in playwright.config.js). Opened as a draft on the emulator URLs.
const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const CASE = 'samples-92-05-end-ed';
const DRAFT_ID = 'abcdef0123456789abcdef0123456789';
const fmt = (n) => n.toLocaleString('en-US');
const golden = (f) => JSON.parse(fs.readFileSync(path.join(GOLDEN, CASE, f), 'utf8'));

/** The golden summary with synthetic early totals: a third of every number (rounded down) early. */
function withSplit() {
  const s = golden('summary.json');
  const third = (n) => Math.floor((n || 0) / 3);
  const l = s.latest;
  l.earlyTotals = {
    ballots: third(l.totalBallots), ballotsRep: third(l.ballotsRep), ballotsDem: third(l.ballotsDem), ballotsGen: third(l.ballotsGen),
    contests: l.contests.map((c) => c.candidates.map((x) => third(x.votes))),
  };
  return s;
}

async function open(page, summary, query = '') {
  const body = JSON.stringify(summary);
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const cors = { 'access-control-allow-origin': '*' };
    if (name === 'summary.json') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body });
    const f = path.join(GOLDEN, CASE, name);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: fs.readFileSync(f) });
  });
  await page.goto(`index.html?emulator&draft=${DRAFT_ID}${query}`);
  await page.locator('#contests-container article').first().waitFor();
}

/** Each card's [title, meta line, [[name, votes, percent]]] as shown. */
const cards = (page) => page.locator('#contests-container article').evaluateAll((arts) => arts.map((a) => ({
  title: a.querySelector('.contest-title').textContent.trim(),
  meta: a.querySelector('.contest-meta').textContent.replace(/\s+/g, ' ').trim(),
  leading: a.querySelectorAll('.leading-tag').length,
  rows: Array.from(a.querySelectorAll('.candidate-row')).map((tr) => [
    tr.querySelector('.cand-name-cell span').textContent.trim(),
    tr.querySelector('.vote-count').textContent.trim(),
    tr.querySelector('.vote-percent').textContent.trim(),
  ]),
})));

test('no split in the file: no switch, the page is unchanged', async ({ page }) => {
  await open(page, golden('summary.json'));
  await expect(page.locator('#ballot-scope-tabs')).toBeHidden();
  await expect(page.locator('#ballot-scope-note')).toBeHidden();
  await expect(page.locator('#stat-ballots-label')).toHaveText('Total Ballots Cast');
});

test('each ballots choice shows its own ballots, turnout and votes; Election Day = all - early', async ({ page }) => {
  const s = withSplit();
  const l = s.latest;
  await open(page, s);
  await expect(page.locator('#ballot-scope-tabs')).toBeVisible();
  await expect(page.locator('#ballot-scope-tabs [data-scope="ALL"]')).toHaveAttribute('aria-pressed', 'true');
  const all = await cards(page);
  expect(all.some((c) => c.leading > 0), 'LEADING shown with All Ballots').toBe(true);

  for (const scope of ['EARLY', 'ED']) {
    await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
    await expect(page.locator(`#ballot-scope-tabs [data-scope="${scope}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ballot-scope-tabs [data-scope="ALL"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page).toHaveURL(new RegExp(`[?&]ballots=${scope}(&|#|$)`));
    const pick = (allN, earlyN) => (scope === 'EARLY' ? earlyN : allN - earlyN);
    const ballots = pick(l.totalBallots, l.earlyTotals.ballots);
    await expect(page.locator('#stat-ballots')).toHaveText(fmt(ballots));
    await expect(page.locator('#stat-ballots-label')).toHaveText(scope === 'EARLY' ? 'Early & Absentee Ballots' : 'Election Day Ballots');
    await expect(page.locator('#stat-turnout')).toHaveText(`${((ballots / l.totalVoters) * 100).toFixed(2)}%`);
    await expect(page.locator('#ballot-scope-note')).toBeVisible();
    // The precincts reporting card is the same for every choice.
    await expect(page.locator('#stat-reporting')).toHaveText(`${l.overallPrecinctsReporting} of ${l.overallPrecinctsTotal} Precincts`);

    const shown = await cards(page);
    expect(shown.length).toBe(l.contests.length);
    l.contests.forEach((c, ci) => {
      const votes = c.candidates.map((x, k) => pick(x.votes, l.earlyTotals.contests[ci][k]));
      const total = votes.reduce((a, b) => a + b, 0);
      const card = shown[ci];
      expect(card.leading, `${c.title}: no LEADING outside All Ballots`).toBe(0);
      expect(card.meta).toContain(`${scope === 'EARLY' ? 'Early & Absentee Votes' : 'Election Day Votes'}: ${fmt(total)}`);
      card.rows.forEach((row, k) => {
        expect(row[1], `${c.title} ${row[0]}`).toBe(fmt(votes[k]));
        expect(row[2], `${c.title} ${row[0]}`).toBe(`(${(total > 0 ? (votes[k] / total) * 100 : 0).toFixed(1)}%)`);
      });
    });
  }

  await page.click('#ballot-scope-tabs [data-scope="ALL"]');
  await expect(page.locator('#stat-ballots')).toHaveText(fmt(l.totalBallots));
  await expect(page.locator('#ballot-scope-note')).toBeHidden();
  expect(await cards(page)).toEqual(all);
  expect(new URL(page.url()).searchParams.has('ballots')).toBe(false);
});

test('the choice is kept in the URL, and the party filter leaves it alone', async ({ page }) => {
  await open(page, withSplit(), '&ballots=ED');
  await expect(page.locator('#ballot-scope-tabs [data-scope="ED"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#stat-ballots-label')).toHaveText('Election Day Ballots');
  await page.click('.tab-btn[data-party="IND"]');
  await expect(page.locator('#ballot-scope-tabs [data-scope="ED"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ballot-scope-tabs [data-scope="ED"]')).toHaveClass(/active/);
});

test('Export CSV adds early & absentee and Election Day columns when the split is published', async ({ page }) => {
  const s = withSplit();
  await open(page, s, '&ballots=EARLY');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.ElectionApp.exportCSV())]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const lines = text.trim().split('\n');
  expect(lines[0]).toContain('Votes,Percentage,Early & Absentee Votes,Election Day Votes');
  const c0 = s.latest.contests[0];
  const x0 = c0.candidates[0];
  const e0 = s.latest.earlyTotals.contests[0][0];
  expect(lines[1].endsWith(`,${x0.votes},${x0.percentage.toFixed(2)}%,${e0},${x0.votes - e0}`), lines[1]).toBe(true);
});
