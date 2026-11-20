// Certified write-in candidates (2026-11-20): the certified file adds "Write-in: <name>" columns.
// Nate's choices: every named write-in is shown (0 votes too), "(Certified Write-in)" follows the
// name everywhere (pages, slides, pop-ups, downloads). A write-in the Early/ABS file lists (Nate's
// certified early-only export) is in all three ballots views like any candidate; one it doesn't
// list (the election-night Early/ABS file) is under All Ballots only, with a note, since its early /
// Election Day split is not known. "Write-in Totals" and "Write-in: Not Assigned" never appear.
// The data is built here by the real pipeline from the certified files. Runs on the phone projects
// too (BEHAVIOUR in playwright.config.js), with the phone layout checks.
const { test, expect, routeArchive, ARCHIVE_ID } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');
const { buildResults } = require('../functions/src/pipeline');
const { layoutProblems } = require('./layout-check');

const DATA = path.join(__dirname, '..', 'functions', 'test', 'data');
const CERTIFIED = path.join(DATA, '2026-11-03-general-certified.csv');
const CERTIFIED_EARLY = path.join(DATA, '2026-11-03-general-certified-early.csv');
const DRAFT_ID = 'abcdef0123456789abcdef0123456789';
const LABEL = ' (Certified Write-in)';
const WRITE_INS = ['Stephen C. Maxwell', 'Jason Michael Smith', 'Carlton "CB" Boleyjack', 'Fred Ferguson'];
const WIDTHS = [320, 375, 414];

// SPLIT: Nate's flow (certified early-only file as Early/ABS + certified file): every write-in split.
// UNSPLIT: an Early/ABS file without named write-ins (the election-night one): write-ins not split.
const FILES = {};
function files(kind = 'SPLIT') {
  if (!FILES[kind]) {
    let early = fs.readFileSync(CERTIFIED_EARLY, 'utf8');
    if (kind === 'UNSPLIT') early = early.replaceAll('Write-in: ', 'Write-in Totals ');
    const res = buildResults({ early, ed: fs.readFileSync(CERTIFIED) }, { precinctCap: 94, config: { enablePrecinctResults: true, precinctCap: 94 }, lastUpdated: 'November 20, 2026 at 10:00 AM' });
    FILES[kind] = res.outputs.files;
  }
  return FILES[kind];
}
const json = (name, kind) => JSON.parse(files(kind)[name]);

async function routeDraft(page, kind) {
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const body = files(kind)[name];
    if (body === undefined) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: name.endsWith('.js') ? 'text/javascript' : 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
  });
}
async function open(page, file, ready, kind) {
  await routeDraft(page, kind);
  await page.goto(`${file}${file.includes('?') ? '&' : '?'}emulator&draft=${DRAFT_ID}`);
  await page.locator(ready).first().waitFor();
}
const SUMMARY = ['index.html', '#contests-container article'];
const PRECINCTS = ['precincts.html', '#precinct-results-container > *'];

async function download(page, click) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  return fs.readFileSync(await dl.path(), 'utf8');
}
/** Minimal CSV reader (quoted cells, doubled quotes). */
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const NEVER = /Write-in Totals|Not Assigned/i;
const NOTE = 'Some certified write-in candidates are shown under All Ballots only: their early and Election Day votes are not known.';

test('the data: four named write-ins with writeIn: true, none of the totals or not-assigned columns', () => {
  const s = json('summary.json').latest;
  const wi = s.contests.flatMap((c) => c.candidates.filter((x) => x.writeIn).map((x) => x.name));
  expect(wi).toEqual(WRITE_INS);
  expect(files()['summary.json']).not.toMatch(NEVER);
  expect(s.earlyTotals).toBeTruthy();
  expect(s.contests.flatMap((c) => c.candidates.filter((x) => x.noEarlySplit))).toEqual([]);
  const u = json('summary.json', 'UNSPLIT').latest;
  expect(u.contests.flatMap((c) => c.candidates.filter((x) => x.noEarlySplit).map((x) => x.name))).toEqual(WRITE_INS);
});

const fredRow = (page) => page.locator('#contests-container .candidate-row', { hasText: 'Fred Ferguson' + LABEL });

test('summary page: write-ins labelled, 0-vote ones too; with the certified early file, in every ballots view', async ({ page }) => {
  await open(page, ...SUMMARY);
  const names = await page.locator('#contests-container .cand-name-cell > span:first-child').allTextContents();
  for (const n of WRITE_INS) expect(names).toContain(n + LABEL);
  expect(names.join('\n')).not.toMatch(NEVER);
  await expect(fredRow(page).locator('.vote-count')).toHaveText('766');
  await expect(fredRow(page).locator('.party-pill')).toHaveCount(0); // no "IND" pill
  const gov = page.locator('#contests-container .candidate-row', { hasText: 'Stephen C. Maxwell' + LABEL });
  await expect(gov.locator('.vote-count')).toHaveText('0');
  for (const [scope, votes] of [['EARLY', '348'], ['ED', '418']]) {
    await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
    await expect(fredRow(page).locator('.vote-count')).toHaveText(votes);
    await expect(gov.locator('.vote-count')).toHaveText('0');
    await expect(page.locator('#ballot-scope-note')).not.toContainText('write-in');
  }
});

test('summary page: with an early file that lacks the write-ins, they are under All Ballots only, with a note', async ({ page }) => {
  await open(page, ...SUMMARY, 'UNSPLIT');
  await expect(fredRow(page)).toHaveCount(1);
  await expect(page.locator('#ballot-scope-note')).toBeHidden();
  for (const scope of ['EARLY', 'ED']) {
    await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
    await expect(page.locator('#ballot-scope-note')).toContainText(NOTE);
    const shown = await page.locator('#contests-container .cand-name-cell > span:first-child').allTextContents();
    expect(shown.filter((n) => n.includes('Write-in')), scope).toEqual([]);
    // Red Bank's total in the view is its ballot candidates' votes only.
    const card = page.locator('#contests-container article', { hasText: 'Red Bank Commission' });
    const l = json('summary.json', 'UNSPLIT').latest;
    const ci = l.contests.findIndex((c) => /Red Bank Commission/.test(c.title));
    const early = l.contests[ci].candidates.reduce((n, x, k) => n + (x.writeIn ? 0 : l.earlyTotals.contests[ci][k]), 0);
    const all = l.contests[ci].candidates.reduce((n, x) => n + (x.writeIn ? 0 : x.votes), 0);
    await expect(card.locator('.contest-meta')).toContainText((scope === 'EARLY' ? early : all - early).toLocaleString('en-US'));
  }
  await page.click('#ballot-scope-tabs [data-scope="ALL"]');
  await expect(fredRow(page)).toHaveCount(1);
});

for (const [kind, fredSplit] of [['SPLIT', ['348', '418']], ['UNSPLIT', ['', '']]]) {
  test(`summary download (${kind}): label, blank party, write-in early / Election Day cells ${kind === 'SPLIT' ? 'filled' : 'empty'}`, async ({ page }) => {
    await open(page, ...SUMMARY, kind);
    const text = await download(page, () => page.getByRole('button', { name: /Export CSV/ }).first().click());
    expect(text).not.toMatch(NEVER);
    const rows = parseCsv(text);
    const head = rows[0];
    const col = (n) => head.indexOf(n);
    const fred = rows.find((r) => r[col('Candidate')] === 'Fred Ferguson' + LABEL);
    expect(fred[col('Party')]).toBe('');
    expect(fred[col('Votes')]).toBe('766');
    expect([fred[col('Early & Absentee Votes')], fred[col('Election Day Votes')]]).toEqual(fredSplit);
    const cb = rows.find((r) => r[col('Candidate')] === 'Carlton "CB" Boleyjack' + LABEL); // quotes survive
    expect(cb[col('Votes')]).toBe('0');
    const ballot = rows.find((r) => r[col('Candidate')] === 'Bill Hagerty');
    expect(ballot[col('Early & Absentee Votes')]).not.toBe('');
  });
}

const precinctFred = (page) => page.locator('#precinct-results-container .candidate-row', { hasText: 'Fred Ferguson' + LABEL });

test('precinct page, certified early file: write-ins split like any candidate in every view', async ({ page }) => {
  await open(page, `precincts.html?precinct=${encodeURIComponent('RED BANK B')}`, PRECINCTS[1]);
  const p = json('precincts.json');
  const ci = p.contests.findIndex((c) => /Red Bank Commission/.test(c.title));
  const k = p.contests[ci].candidates.findIndex((x) => x.name === 'Fred Ferguson');
  const early = p.earlyByPrecinct.contests[ci][k]['RED BANK B'] || 0;
  await expect(precinctFred(page).locator('.vote-count')).toHaveText('321 votes');
  await expect(precinctFred(page).locator('.vote-split')).toHaveText(`Early & absentee ${early} • Election Day ${321 - early}`);
  await expect(precinctFred(page).locator('.party-pill')).toHaveCount(0);
  for (const [scope, v] of [['EARLY', early], ['ED', 321 - early]]) {
    await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
    await expect(precinctFred(page).locator('.vote-count')).toHaveText(`${v} votes`);
    await expect(page.locator('#precinct-scope-note')).toBeHidden();
  }
  await page.click('#view-mode-contest-btn');
  const rbValue = await page.locator('#contest-precinct-select option', { hasText: 'Red Bank Commission' }).first().getAttribute('value');
  await page.selectOption('#contest-precinct-select', rbValue);
  await expect(page.locator('#precinct-results-container thead')).toContainText('Fred Ferguson' + LABEL);
  await expect(page.locator('#precinct-results-container tfoot')).toContainText('418'); // Election Day still selected
});

test('precinct page, early file without the write-ins: write-ins under All ballots only, no early / Election Day line, a note', async ({ page }) => {
  await open(page, `precincts.html?precinct=${encodeURIComponent('RED BANK B')}`, PRECINCTS[1], 'UNSPLIT');
  await expect(precinctFred(page)).toHaveCount(1);
  await expect(precinctFred(page).locator('.vote-count')).toHaveText('321 votes');
  await expect(precinctFred(page).locator('.vote-split')).toHaveCount(0);
  await expect(page.locator('#precinct-scope-note')).toBeHidden();
  for (const scope of ['EARLY', 'ED']) {
    await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
    await expect(page.locator('#precinct-scope-note')).toHaveText(NOTE);
    await expect(page.locator('#precinct-results-container')).not.toContainText('Write-in');
  }
  await page.click('#ballot-scope-tabs [data-scope="ALL"]');
  await page.click('#view-mode-contest-btn');
  const rbValue = await page.locator('#contest-precinct-select option', { hasText: 'Red Bank Commission' }).first().getAttribute('value');
  await page.selectOption('#contest-precinct-select', rbValue);
  await expect(page.locator('#precinct-results-container thead')).toContainText('Fred Ferguson' + LABEL);
  await expect(page.locator('#precinct-results-container tfoot')).toContainText('766');
  await page.click('#ballot-scope-tabs [data-scope="ED"]');
  await expect(page.locator('#precinct-results-container thead')).not.toContainText('Write-in');
});

for (const kind of ['SPLIT', 'UNSPLIT']) {
  test(`precinct downloads (${kind}): label, blank party, real precinct and county votes`, async ({ page }) => {
    await open(page, ...PRECINCTS, kind);
    const text = await download(page, () => page.locator('button[onclick*="exportPrecinctCSV(\'ALL\')"]').click());
    expect(text).not.toMatch(NEVER);
    const rows = parseCsv(text);
    const head = rows[0];
    const col = (n) => head.indexOf(n);
    const fred = rows.find((r) => r[col('Precinct')] === 'RED BANK B' && r[col('Candidate')] === 'Fred Ferguson' + LABEL);
    const p = json('precincts.json', kind);
    const ci = p.contests.findIndex((c) => /Red Bank Commission/.test(c.title));
    const k = p.contests[ci].candidates.findIndex((x) => x.name === 'Fred Ferguson');
    const early = p.earlyByPrecinct.contests[ci][k]['RED BANK B'] || 0;
    const split = kind === 'SPLIT' ? [String(early), String(321 - early)] : ['', ''];
    expect([fred[col('Party')], fred[col('Precinct Votes')], fred[col('Early & Absentee Votes')], fred[col('Election Day Votes')], fred[col('County Total Votes')]])
      .toEqual(['', '321', ...split, '766']);
    expect(rows.some((r) => r[col('Candidate')] === 'Carlton "CB" Boleyjack' + LABEL)).toBe(true);
  });
}

test('slides and the reporting page show the label; nothing shows the totals columns', async ({ page }) => {
  await open(page, 'scrolling.html', '#slide-viewport > *');
  const labels = await page.evaluate(() => {
    const out = [];
    const data = window.ELECTION_DATA.latest || window.ELECTION_DATA;
    data.contests.forEach((c) => c.candidates.forEach((x) => { if (x.writeIn) out.push(x.name); }));
    return out;
  });
  expect(labels).toEqual(WRITE_INS.map((n) => n + LABEL));
  // Step to the Governor slide and look at it.
  // The Governor's write-ins are on its last slide (the candidates run over several).
  const gov = await page.locator('#slide-jump-menu option', { hasText: 'Governor' }).last().getAttribute('value');
  await page.selectOption('#slide-jump-menu', gov);
  await expect(page.locator('#slide-viewport')).toContainText('Stephen C. Maxwell' + LABEL);
  await expect(page.locator('body')).not.toContainText(NEVER);
});

test('the official archive shows the write-ins the same way', async ({ page }) => {
  const dir = path.join(test.info().outputDir, 'archive-data');
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, body] of Object.entries(files())) fs.writeFileSync(path.join(dir, n), body);
  await routeArchive(page, { dir });
  await page.goto(`index.html?election=${ARCHIVE_ID}`);
  await page.locator('#contests-container article').first().waitFor();
  await expect(page.locator('#contests-container')).toContainText('Fred Ferguson' + LABEL);
  await expect(page.locator('#contests-container')).not.toContainText(NEVER);
});

// Phone layout with the long labelled names (Carlton "CB" Boleyjack (Certified Write-in)).
test('phone layout: write-ins on the summary, precinct and slides pages', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const widths = testInfo.project.name === 'chromium' ? WIDTHS : [null];
  for (const w of widths) {
    if (w) await page.setViewportSize({ width: w, height: 800 });
    const at = w || testInfo.project.name;
    for (const [file, ready] of [SUMMARY, ['scrolling.html', '#slide-viewport > *'], ['reporting.html', '#reporting-table-body tr'],
      [`precincts.html?precinct=${encodeURIComponent('RED BANK B')}`, PRECINCTS[1]]]) {
      await open(page, file, ready);
      await page.waitForTimeout(150);
      const problems = await page.evaluate(layoutProblems);
      expect(problems, `${file} @ ${at}:\n  ${problems.slice(0, 15).join('\n  ')}`).toEqual([]);
    }
    await page.click('#view-mode-contest-btn');
    await page.selectOption('#contest-precinct-select', 'Governor');
    await page.waitForTimeout(150);
    const problems = await page.evaluate(layoutProblems);
    expect(problems, `precincts By Contest Governor @ ${at}:\n  ${problems.slice(0, 15).join('\n  ')}`).toEqual([]);
    // The All-Ballots-only note, on both pages.
    for (const [file, ready] of [SUMMARY, PRECINCTS]) {
      await page.unrouteAll();
      await open(page, file, ready, 'UNSPLIT');
      await page.click('#ballot-scope-tabs [data-scope="ED"]');
      await page.waitForTimeout(150);
      const p2 = await page.evaluate(layoutProblems);
      expect(p2, `${file} Election Day with the note @ ${at}:\n  ${p2.slice(0, 15).join('\n  ')}`).toEqual([]);
    }
  }
});
