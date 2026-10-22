// Layer 8, DOM oracle (plan: Test strategy): every number a public page shows is the number in
// the file it read. The pages are opened as a draft view on the Storage emulator's URLs, answered
// from a golden output, so no emulator is needed and nothing polls.
const { test, expect } = require('./fixtures'); // fixtures: the production bucket is never fetched
const fs = require('node:fs');
const path = require('node:path');

const CASE = 'samples-92-05-end-ed';
const DIR = path.join(__dirname, '..', 'functions', 'test', 'golden', CASE);
const json = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const DRAFT_ID = '0123456789abcdef0123456789abcdef';
const fmt = (n) => n.toLocaleString('en-US');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

async function open(page, file) {
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const object = decodeURIComponent(new URL(route.request().url()).pathname.split('/o/')[1]);
    const name = path.basename(object);
    if (!object.startsWith(`drafts/${DRAFT_ID}/`) || !fs.existsSync(path.join(DIR, name))) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(path.join(DIR, name)) });
  });
  await page.goto(`${file}?emulator&draft=${DRAFT_ID}`);
}

test('summary page: every contest, candidate, vote count and percentage', async ({ page }) => {
  const s = json('summary.json').latest;
  await open(page, 'index.html');
  await expect(page.locator('#contests-container > article')).toHaveCount(s.contests.length);
  await expect(page.locator('#stat-voters')).toHaveText(fmt(s.totalVoters));
  await expect(page.locator('#stat-ballots')).toHaveText(fmt(s.totalBallots));
  await expect(page.locator('#stat-turnout')).toHaveText(`${s.turnoutPercent.toFixed(2)}%`);
  await expect(page.locator('#stat-reporting')).toHaveText(`${s.overallPrecinctsReporting} of ${s.overallPrecinctsTotal} Precincts`);

  const shown = await page.locator('#contests-container > article').evaluateAll((cards) => cards.map((card) => ({
    title: card.querySelector('.contest-title').textContent,
    meta: card.querySelector('.contest-meta').textContent,
    reporting: card.querySelector('.reporting-btn').textContent,
    rows: Array.from(card.querySelectorAll('.candidate-row')).map((r) => ({
      name: r.querySelector('.cand-name-cell span').textContent,
      votes: r.querySelector('.vote-count').textContent,
      pct: r.querySelector('.vote-percent').textContent,
    })),
  })));
  s.contests.forEach((c, i) => {
    const card = shown[i];
    expect(card.title).toBe(c.title);
    expect(norm(card.meta)).toContain(`Total Votes: ${fmt(c.totalVotes)}`);
    expect(norm(card.reporting)).toContain(`${c.precinctsReporting} of ${c.precinctsTotal} Election Day Precincts Reporting`);
    expect(card.rows).toEqual(c.candidates.map((x) => ({ name: x.name, votes: fmt(x.votes), pct: `(${x.percentage.toFixed(1)}%)` })));
  });
});

test('reporting page: every contest row and the exact reported precincts of each', async ({ page }) => {
  const s = json('summary.json').latest;
  const r = json('reporting.json');
  await open(page, 'reporting.html');
  const rows = page.locator('#reporting-table-body tr');
  await expect(rows).toHaveCount(s.contests.length);
  const shown = await rows.evaluateAll((trs) => trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
  s.contests.forEach((c, i) => {
    expect(shown[i][0]).toBe(c.title);
    expect(shown[i][2]).toContain(`${c.precinctsReporting} of ${c.precinctsTotal}`);
    expect(shown[i][4]).toBe(fmt(c.totalVotes));
  });

  // Open three contests' dialogs and compare the Reported list with reporting.json's flags.
  for (const i of [0, Math.floor(s.contests.length / 2), s.contests.length - 1]) {
    const flags = r.latest.contests[i].precinctsStatusIndexed;
    const reported = flags.filter(([, f]) => f === 1).map(([k]) => r.masterPrecincts[k]).sort();
    const pending = flags.filter(([, f]) => f !== 1).map(([k]) => r.masterPrecincts[k]).sort();
    await rows.nth(i).locator('.reporting-btn').click();
    await page.locator('.modal-filter-btn[data-mfilter="REPORTED"]').click();
    const chipNames = () => page.locator('#modal-precinct-grid .precinct-chip span:first-child').allTextContents();
    expect((await chipNames()).sort()).toEqual(reported);
    await page.locator('.modal-filter-btn[data-mfilter="PENDING"]').click();
    expect((await chipNames()).sort()).toEqual(pending);
    await page.keyboard.press('Escape');
  }
});

test('precinct page: by-contest table matches precincts.json for every precinct and candidate', async ({ page }) => {
  const p = json('precincts.json');
  await open(page, 'precincts.html');
  await page.locator('#precinct-results-container article').first().waitFor();
  await page.click('#view-mode-contest-btn');
  for (const c of [p.contests[0], p.contests[p.contests.length - 1]]) {
    await page.selectOption('#contest-precinct-select', c.title);
    const table = page.locator('#precinct-results-container table');
    await table.waitFor();
    const head = await table.locator('thead th').allTextContents();
    expect(head.slice(3).map(norm)).toEqual(c.candidates.map((x) => x.name));
    const body = await table.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    const names = c.precinctsStatusIndexed.map(([k]) => p.masterPrecincts[k]);
    expect(body.map((row) => row[0])).toEqual(names);
    body.forEach((row, j) => {
      const name = names[j];
      const flag = c.precinctsStatusIndexed[j][1] === 1;
      expect(row[1]).toBe(flag ? 'REPORTED' : 'PENDING');
      const votes = c.candidates.map((x) => x.precinctVotes[name] || 0);
      expect(row[2]).toBe(fmt(votes.reduce((a, b) => a + b, 0)));
      expect(row.slice(3).map((v) => v.replace(' ✔', ''))).toEqual(votes.map(fmt));
    });
  }
});

test('precinct page: by-precinct cards match precincts.json', async ({ page }) => {
  const p = json('precincts.json');
  await open(page, 'precincts.html');
  await page.locator('#precinct-results-container article').first().waitFor();
  const name = p.masterPrecincts[Math.floor(p.masterPrecincts.length / 2)];
  await page.selectOption('#precinct-select', name);
  // The sample exports carry no per-precinct statistics block, so the page shows zeros.
  const stats = p.precinctStats[name] || { voters: 0, ballots: 0 };
  await expect(page.locator('#precinct-stat-voters')).toHaveText(fmt(stats.voters));
  await expect(page.locator('#precinct-stat-ballots')).toHaveText(fmt(stats.ballots));
  const index = p.masterPrecincts.indexOf(name);
  const inPrecinct = p.contests.filter((c) => c.precinctsStatusIndexed.some(([k]) => k === index));
  const cards = page.locator('#precinct-results-container article');
  await expect(cards).toHaveCount(inPrecinct.length);
  const shown = await cards.evaluateAll((arts) => arts.map((a) => ({
    title: a.querySelector('.contest-title').textContent,
    votes: Array.from(a.querySelectorAll('.candidate-row .vote-count')).map((v) => v.textContent),
  })));
  inPrecinct.forEach((c, i) => {
    expect(shown[i].title).toBe(c.title);
    expect(shown[i].votes).toEqual(c.candidates.map((x) => `${fmt(x.precinctVotes[name] || 0)} votes`));
  });
});
