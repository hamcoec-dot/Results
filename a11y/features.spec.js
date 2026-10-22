// Behaviour of the public pages' controls: filters, search, the precinct picker in the URL, and the
// CSV exports, whose numbers must equal the data the page shows (a DOM oracle for downloads).
// The pages run in their default mode: the production bucket's current/, answered by ./fixtures.
const { test, expect, fixtureData } = require('./fixtures'); // fixtures: the production bucket is never fetched
const fs = require('node:fs');

const summary = fixtureData('summary.json').latest;
const precincts = fixtureData('precincts.json');

/** A minimal RFC 4180 reader for the exports (quoted fields, doubled quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function download(page, click) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: dl.suggestedFilename(), text: fs.readFileSync(await dl.path(), 'utf8') };
}

test('summary page: party filter buttons and search narrow the contests', async ({ page }) => {
  await page.goto('index.html');
  const cards = page.locator('#contests-container > article');
  await expect(cards).toHaveCount(summary.contests.length);

  await page.click('.tab-btn[data-party="REP"]');
  await expect(page.locator('.tab-btn[data-party="REP"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tab-btn[data-party="ALL"]')).toHaveAttribute('aria-pressed', 'false');
  const repTitles = await cards.locator('.contest-title').allTextContents();
  expect(repTitles.length).toBeGreaterThan(0);
  expect(repTitles.length).toBeLessThan(summary.contests.length);
  for (const t of repTitles) {
    const c = summary.contests.find((x) => x.title === t);
    expect(/\bREP\b/i.test(t) || c.candidates.some((x) => x.party === 'REP'), t).toBe(true);
  }

  await page.click('.tab-btn[data-party="ALL"]');
  const someone = summary.contests[3].candidates[0].name;
  await page.fill('#contest-search', someone.toLowerCase());
  await expect.poll(() => cards.count()).toBeLessThan(summary.contests.length);
  for (const t of await cards.locator('.contest-title').allTextContents()) {
    const c = summary.contests.find((x) => x.title === t);
    expect(t.toLowerCase().includes(someone.toLowerCase()) || c.candidates.some((x) => x.name.toLowerCase().includes(someone.toLowerCase())), t).toBe(true);
  }
  await page.fill('#contest-search', 'zzzz-no-such-contest');
  await expect(page.locator('#contests-container')).toContainText('No matching contests found.');
});

test('summary export CSV: one row per candidate, numbers equal to summary.json', async ({ page }) => {
  await page.goto('index.html');
  await expect(page.locator('#contests-container > article')).toHaveCount(summary.contests.length);
  const { name, text } = await download(page, () => page.getByRole('button', { name: /Export CSV/ }).click());
  expect(name).toBe('Hamilton_Election_Summary_Results.csv');
  const [head, ...rows] = parseCsv(text);
  expect(head).toEqual(['Election', 'County', 'Contest', 'Vote For', 'Election Day Precincts Reporting', 'Total Precincts', 'Candidate', 'Party', 'Votes', 'Percentage']);
  const expected = summary.contests.flatMap((c) => c.candidates.map((x) => [c.title, x.name, String(x.votes), `${x.percentage.toFixed(2)}%`]));
  expect(rows.map((r) => [r[2], r[6], r[8], r[9]])).toEqual(expected);
});

test('precinct page: the picked precinct is kept in the URL and restored on reload', async ({ page }) => {
  await page.goto('precincts.html');
  await page.locator('#precinct-results-container article').first().waitFor();
  const name = precincts.masterPrecincts[5];
  await page.selectOption('#precinct-select', name);
  await expect(page).toHaveURL(new RegExp(`precinct=${encodeURIComponent(name).replace(/%20/g, '\\+')}`));
  await page.click('.tab-btn[data-precinct-party="DEM"]');
  await page.reload();
  await expect(page.locator('#precinct-select')).toHaveValue(name);
  await expect(page.locator('.tab-btn[data-precinct-party="DEM"]')).toHaveAttribute('aria-pressed', 'true');
});

test('precinct exports: filtered (one precinct) and all precincts, numbers equal to precincts.json', async ({ page }) => {
  await page.goto('precincts.html');
  await page.locator('#precinct-results-container article').first().waitFor();
  const name = precincts.masterPrecincts[5];
  await page.selectOption('#precinct-select', name);

  const filtered = await download(page, () => page.getByRole('button', { name: /Export Filtered CSV/ }).click());
  expect(filtered.name).toMatch(/^Hamilton_County_.+_Results_\d+\.csv$/);
  const [head, ...rows] = parseCsv(filtered.text);
  expect(head).toEqual(['Precinct', 'Contest', 'Candidate', 'Party', 'Precinct Votes', 'County Total Votes']);
  const index = precincts.masterPrecincts.indexOf(name);
  const expected = precincts.contests.filter((c) => c.precinctsStatusIndexed.some(([k]) => k === index))
    .flatMap((c) => c.candidates.map((x) => [name, c.title, x.name, String(x.precinctVotes[name] || 0), String(x.votes)]));
  expect(rows.map((r) => [r[0], r[1], r[2], r[4], r[5]])).toEqual(expected);

  const all = await download(page, () => page.getByRole('button', { name: /Export All Precincts CSV/ }).click());
  const allRows = parseCsv(all.text).slice(1);
  const expectedCount = precincts.contests.reduce((n, c) => n + c.precinctsStatusIndexed.length * c.candidates.length, 0);
  expect(allRows.length).toBe(expectedCount);
  for (const r of allRows.slice(0, 200)) {
    const c = precincts.contests.find((x) => x.title === r[1]);
    const cand = c.candidates.find((x) => x.name === r[2]);
    expect(r[4], `${r[0]} / ${r[1]} / ${r[2]}`).toBe(String(cand.precinctVotes[r[0]] || 0));
  }
});

test('precinct dialog: Reported / Pending filters and search', async ({ page }) => {
  await page.goto('index.html');
  await page.locator('#contests-container .reporting-btn').first().click();
  const chips = page.locator('#modal-precinct-grid .precinct-chip');
  await expect(chips.first()).toBeVisible();
  const total = await chips.count();
  await page.click('.modal-filter-btn[data-mfilter="PENDING"]');
  await expect(page.locator('.modal-filter-btn[data-mfilter="PENDING"]')).toHaveAttribute('aria-pressed', 'true');
  const pending = await page.locator('#modal-precinct-grid .precinct-chip.pending').count();
  expect(await chips.count()).toBe(pending);
  await page.click('.modal-filter-btn[data-mfilter="ALL"]');
  await expect(chips).toHaveCount(total);
  await page.fill('#modal-search-input', 'airport');
  for (const t of await page.locator('#modal-precinct-grid .precinct-chip span:first-child').allTextContents()) expect(t.toLowerCase()).toContain('airport');
});
