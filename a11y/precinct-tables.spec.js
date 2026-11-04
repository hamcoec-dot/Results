// The precinct page's tables (2026-11-04): the Turnout view lists every precinct's registered voters,
// ballots and turnout from precincts.json; the By Contest and Turnout tables sort by any column
// (mouse or keyboard); each candidate's share of the precinct's votes is shown under the count;
// a precinct name opens that precinct's own results. Opened as a draft on the emulator URLs.
const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const CASE = 'testfiles-ev-ed'; // has the per-precinct STATISTICS block
const DRAFT_ID = 'abcdef0123456789abcdef0123456789';
const fmt = (n) => n.toLocaleString('en-US');
const json = (f) => JSON.parse(fs.readFileSync(path.join(GOLDEN, CASE, f), 'utf8'));

async function open(page) {
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const f = path.join(GOLDEN, CASE, name);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) });
  });
  await page.goto(`precincts.html?emulator&draft=${DRAFT_ID}`);
  await page.locator('#precinct-results-container article').first().waitFor();
}

const bodyRows = (page) => page.locator('#precinct-results-container tbody tr').evaluateAll((trs) =>
  trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.replace(/\s+/g, ' ').trim())));

test('turnout view: every precinct with registered voters, ballots and turnout, plus an all-precincts total', async ({ page }) => {
  const p = json('precincts.json');
  await open(page);
  await page.click('#view-mode-turnout-btn');
  await expect(page.locator('#view-mode-turnout-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tab-btn[data-precinct-party="REP"]')).toBeHidden();
  const rows = await bodyRows(page);
  const names = Array.from(new Set([...p.masterPrecincts, ...Object.keys(p.precinctStats)]));
  expect(rows.length).toBe(names.length);
  for (const row of rows) {
    const st = p.precinctStats[row[0]] || { voters: 0, ballots: 0 };
    expect(row[1], row[0]).toBe(fmt(st.voters));
    expect(row[2], row[0]).toBe(fmt(st.ballots));
    if (st.voters > 0) expect(row[3], row[0]).toBe(`${Number(st.turnoutPercent).toFixed(2)}%`);
    else expect(row[3], row[0]).toMatch(/^N\/A/);
  }
  const foot = await page.locator('#precinct-results-container tfoot tr').evaluate((tr) => Array.from(tr.cells).map((td) => td.textContent.trim()));
  const totV = Object.values(p.precinctStats).reduce((n, s) => n + s.voters, 0);
  const totB = Object.values(p.precinctStats).reduce((n, s) => n + s.ballots, 0);
  expect(foot).toEqual(['All Precincts', fmt(totV), fmt(totB), `${((totB / totV) * 100).toFixed(2)}%`]);
});

test('turnout view sorts by a column (highest first), reverses on a second click, and works by keyboard', async ({ page }) => {
  await open(page);
  await page.click('#view-mode-turnout-btn');
  const header = page.locator('#precinct-results-container thead th', { hasText: 'Turnout' });
  await header.locator('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  let pct = (await bodyRows(page)).map((r) => r[3]).filter((t) => t.endsWith('%')).map(parseFloat);
  expect(pct).toEqual([...pct].sort((a, b) => b - a));
  // Keyboard: focus stays on the header after the redraw, Enter reverses.
  await expect(header.locator('button')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#precinct-results-container thead th', { hasText: 'Turnout' })).toHaveAttribute('aria-sort', 'ascending');
  pct = (await bodyRows(page)).map((r) => r[3]).filter((t) => t.endsWith('%')).map(parseFloat);
  expect(pct).toEqual([...pct].sort((a, b) => a - b));
});

test('by contest: a candidate column sorts by share of the precinct vote, and shares add up', async ({ page }) => {
  const p = json('precincts.json');
  const c = p.contests.find((x) => x.candidates.length >= 2 && x.precinctsStatusIndexed.length >= 3);
  await open(page);
  await page.click('#view-mode-contest-btn');
  await page.selectOption('#contest-precinct-select', { index: p.contests.indexOf(c) + 1 });
  const cand = c.candidates[0].name;
  await page.locator('#precinct-results-container thead th button', { hasText: cand }).first().click();
  const rows = await bodyRows(page);
  const shares = rows.map((r) => {
    const m = r[3].match(/([\d.]+)%$/);
    return m ? parseFloat(m[1]) : -1;
  });
  expect(shares).toEqual([...shares].sort((a, b) => b - a));
  // The share under each count is that candidate's votes over the precinct's total.
  for (const r of rows) {
    const total = Number(r[2].replace(/,/g, ''));
    if (!total) continue;
    const votes = Number(r[3].split(' ')[0].replace(/,/g, ''));
    expect(r[3]).toContain(`${((votes / total) * 100).toFixed(1)}%`);
  }
});

test('a precinct name in a table opens that precinct in By Precinct', async ({ page }) => {
  await open(page);
  await page.click('#view-mode-turnout-btn');
  const link = page.locator('#precinct-results-container tbody .precinct-link').nth(2);
  const name = (await link.textContent()).trim();
  await link.click();
  await expect(page.locator('#view-mode-precinct-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#precinct-select')).toHaveValue(name);
  await expect(page.locator('#precinct-results-container article').first()).toBeVisible();
});

test('map view: every precinct boundary is drawn; picking one shows its numbers and can open it', async ({ page }) => {
  const shapes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'precinct-shapes.json'), 'utf8'));
  await open(page);
  await page.click('#view-mode-map-btn');
  const paths = page.locator('.precinct-map-svg path[data-map-precinct]');
  await expect(paths).toHaveCount(new Set(shapes.features.map((f) => f.properties.name)).size);
  const first = paths.first();
  const name = await first.getAttribute('data-map-precinct');
  await first.click({ force: true });
  await expect(page.locator('.precinct-map-info h3')).toHaveText(name);
  await page.click('.precinct-map-card .tab-btn:has-text("Turnout")');
  await expect(page.locator('.precinct-map-card .tab-btn:has-text("Turnout")')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.precinct-map-info [data-open-precinct]').click();
  await expect(page.locator('#view-mode-precinct-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#precinct-select')).toHaveValue(name);
});

test('the boundary file names every precinct of the 2026-11-03 General (the ES&S spelling)', async () => {
  const shapes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'precinct-shapes.json'), 'utf8'));
  const names = new Set(shapes.features.map((f) => f.properties.name));
  const p = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'samples-94-05-end-ed', 'precincts.json'), 'utf8'));
  const missing = p.masterPrecincts.filter((n) => !/PROPERTY RIGHTS/.test(n) && !names.has(n));
  expect(missing).toEqual([]);
});

// Early & absentee vs Election Day (precincts.json earlyByPrecinct, pipeline fix d5): a synthetic
// split (half of every number early) on top of a real sample output.
function withSplit() {
  const p = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'samples-92-05-end-ed', 'precincts.json'), 'utf8'));
  p.precinctStats = Object.fromEntries(p.masterPrecincts.map((n, i) => [n, { name: n, voters: 1000 + i, ballots: 400 + i, rep: 0, dem: 0, gen: 0, turnoutPercent: Math.round(((400 + i) / (1000 + i)) * 10000) / 100 }]));
  const half = (n) => Math.floor(n / 2);
  p.earlyByPrecinct = {
    ballots: Object.fromEntries(Object.entries(p.precinctStats).map(([n, s]) => [n, half(s.ballots)])),
    contests: p.contests.map((c) => c.candidates.map((x) => Object.fromEntries(Object.entries(x.precinctVotes).map(([n, v]) => [n, half(v)])))),
  };
  return p;
}

async function openWith(page, precincts) {
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    if (name === 'precincts.json') return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(precincts) });
    const f = path.join(GOLDEN, 'samples-92-05-end-ed', name);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) });
  });
  await page.goto(`precincts.html?emulator&draft=${DRAFT_ID}`);
  await page.locator('#precinct-results-container article').first().waitFor();
}

test('early vs Election Day: precinct header, candidate rows, turnout columns and the map toggle', async ({ page }) => {
  const p = withSplit();
  await openWith(page, p);
  const name = p.masterPrecincts[3];
  await page.selectOption('#precinct-select', name);
  const b = p.precinctStats[name].ballots;
  const e = Math.floor(b / 2);
  await expect(page.locator('#precinct-stat-ballots-split')).toHaveText(`Early & absentee ${fmt(e)} • Election Day ${fmt(b - e)}`);
  const c = p.contests.find((x) => x.precinctsStatusIndexed.some(([k]) => k === 3));
  const v = c.candidates[0].precinctVotes[name] || 0;
  await expect(page.locator('#precinct-results-container article .vote-split').first()).toHaveText(`Early & absentee ${fmt(Math.floor(v / 2))} • Election Day ${fmt(v - Math.floor(v / 2))}`);

  // The ballots switch changes the results themselves: Election Day only, then early only.
  await page.click('#ballot-scope-tabs [data-scope="ED"]');
  await expect(page.locator('#precinct-results-container article .vote-count').first()).toHaveText(`${fmt(v - Math.floor(v / 2))} votes`);
  await expect(page.locator('#precinct-stat-ballots')).toHaveText(fmt(b - e));
  await page.click('#ballot-scope-tabs [data-scope="EARLY"]');
  await expect(page.locator('#precinct-results-container article .vote-count').first()).toHaveText(`${fmt(Math.floor(v / 2))} votes`);
  await page.click('#view-mode-contest-btn');
  await page.selectOption('#contest-precinct-select', { index: p.contests.indexOf(c) + 1 });
  const cRow = (await bodyRows(page)).find((r) => r[0] === name);
  expect(cRow[3].split(' ')[0]).toBe(fmt(Math.floor(v / 2)));
  await page.click('#ballot-scope-tabs [data-scope="ALL"]');

  await page.click('#view-mode-turnout-btn');
  const row = (await bodyRows(page)).find((r) => r[0] === name);
  expect(row[4].split(' ')[0]).toBe(fmt(e));
  expect(row[5].split(' ')[0]).toBe(fmt(b - e));

  await page.click('#view-mode-map-btn');
  await page.locator('.precinct-map-svg path').first().waitFor();
  for (const k of ['EARLY', 'ED', 'ALL']) {
    await page.click(`#ballot-scope-tabs [data-scope="${k}"]`);
    await expect(page.locator(`#ballot-scope-tabs [data-scope="${k}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.click('#ballot-scope-tabs [data-scope="ED"]');
  await page.click('.precinct-map-card .tab-btn:has-text("Turnout")');
  await page.locator(`.precinct-map-svg path[data-map-precinct="${name}"]`).click({ force: true });
  await expect(page.locator('.precinct-map-info')).toContainText(`${fmt(b - e)} Election Day ballots`);
});

test('without a split the ballot toggle and the extra columns are not shown', async ({ page }) => {
  await open(page);
  await page.click('#view-mode-turnout-btn');
  await expect(page.locator('#precinct-results-container thead th')).toHaveCount(4);
  await page.click('#view-mode-map-btn');
  await page.locator('.precinct-map-svg path').first().waitFor();
  await expect(page.locator('#ballot-scope-tabs')).toBeHidden();
  await expect(page.locator('#precinct-stat-ballots-split')).toBeHidden();
});
