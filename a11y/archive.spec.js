// Official archive and "no current election" (docs/ARCHIVE.md), in every browser and on the phones:
//   - ?election=<id> shows that election's archive: Official label and banner with the certification
//     date, no live updates, links between the pages keep ?election=, nothing read from current/
//   - archive.html lists every archive with links to its pages
//   - between elections (current/manifest.json says noElection) every page says there is no current
//     election and links to past results; the next election's first publish shows itself.
const { test, expect, routeArchive, routeNoElection, routeProdBucket, ARCHIVE_ID } = require('./fixtures');

const Q = `?election=${ARCHIVE_ID}`;

test.describe('official archive pages', () => {
  test('summary page: official label, banner with the certification date, no live updates', async ({ page }) => {
    const log = [];
    const built = await routeArchive(page, { log });
    await page.goto(`index.html${Q}`);
    await page.locator('#contests-container article').first().waitFor();
    await expect(page.locator('#official-banner')).toContainText('Official results');
    await expect(page.locator('#official-banner')).toContainText('certified August 20, 2026');
    await expect(page.locator('#status-text')).toHaveText('OFFICIAL RESULTS');
    await expect(page.locator('#live-status')).toHaveText('Official results, certified August 20, 2026.');
    await expect(page.locator('#live-toggle')).toBeHidden();
    await expect(page).toHaveTitle(/^Official Results \| /);
    await expect(page.locator('footer p').first()).toContainText('Official Election Results');
    await expect(page.locator('footer')).not.toContainText('Unofficial');
    await expect(page.locator('.disclaimer-banner-group')).toBeHidden();
    // Same numbers as the published version.
    const ballots = built.entry.totalBallots.toLocaleString('en-US');
    await expect(page.locator('#stat-ballots')).toContainText(ballots);
    // Read from the archive only, never from the live current/.
    expect(log.some((p) => p.includes(`/archive/${ARCHIVE_ID}/summary.json`))).toBe(true);
    expect(log.filter((p) => p.includes('/current/'))).toEqual([]);
    // Every link to another results page stays in the archive.
    // (Past Elections goes to the list of every archive, not this one.)
    for (const href of await page.locator('nav a.nav-btn').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
      if (href === 'archive.html') continue;
      expect(href).toContain(`election=${ARCHIVE_ID}`);
    }
    await expect(page.locator('nav a.nav-btn', { hasText: 'Past Elections' })).toHaveAttribute('href', 'archive.html');
    await expect(page.locator('#official-banner a')).toHaveAttribute('href', 'archive.html');
  });

  test('the nav links open the same archive: reporting and precinct pages', async ({ page }) => {
    await routeArchive(page);
    await page.goto(`index.html${Q}`);
    await page.locator('#contests-container article').first().waitFor();
    await page.locator('nav a.nav-btn', { hasText: 'Reporting Status' }).click();
    await expect(page).toHaveURL(new RegExp(`reporting\\.html\\?election=${ARCHIVE_ID}(&|$)`));
    await page.locator('#reporting-table-body tr').first().waitFor();
    await expect(page.locator('#official-banner')).toContainText('certified August 20, 2026');
    await page.locator('nav a.nav-btn', { hasText: 'Precinct Results' }).click();
    // The precinct page then adds its own view to the address (precinct, mode...), after election=.
    await expect(page).toHaveURL(new RegExp(`precincts\\.html\\?election=${ARCHIVE_ID}(&|$)`));
    await page.locator('#precinct-results-container > *').first().waitFor();
    await expect(page.locator('#status-text')).toHaveText('OFFICIAL RESULTS');
    await expect(page.locator('#hero-date')).not.toContainText('Unofficial');
  });

  test('a "Past Elections" button on every results page, live and archived, opens the list of archives', async ({ page }) => {
    await routeArchive(page);
    for (const file of ['index.html', 'reporting.html', 'precincts.html', 'scrolling.html']) {
      for (const q of ['', Q]) {
        await page.goto(`${file}${q}`);
        const btn = page.locator('nav a.nav-btn', { hasText: 'Past Elections' });
        await expect(btn, `${file}${q}`).toBeVisible();
        await expect(btn, `${file}${q}`).toHaveAttribute('href', 'archive.html');
      }
    }
    await page.goto(`reporting.html${Q}`);
    await page.locator('nav a.nav-btn', { hasText: 'Past Elections' }).click();
    await expect(page).toHaveURL(/\/archive\.html$/);
    await expect(page.locator('nav a.nav-btn.active')).toHaveText('Past Elections');
  });

  test('an archive that does not exist says so instead of showing live results', async ({ page }) => {
    await routeArchive(page);
    await page.goto('index.html?election=1999-01-01-nothing');
    await expect(page.locator('#live-status')).toHaveText(/These archived results could not be loaded/, { timeout: 20000 });
    await expect(page.locator('#contests-container article')).toHaveCount(0);
  });
});

test.describe('past elections page', () => {
  test('lists every archive, newest first, with links to its own pages', async ({ page }) => {
    const built = await routeArchive(page, {
      index: {
        elections: [
          { id: ARCHIVE_ID, name: '2026-08-06 General', date: '2026-08-06', certifiedDate: '2026-08-20', totalBallots: 51234, turnoutPercent: 21.5, precinctPage: true },
          { id: '2024-11-05-general', name: '2024-11-05 General <b>Election</b>', date: '2024-11-05', certifiedDate: '2024-11-25', totalBallots: 160000, turnoutPercent: 62.1, precinctPage: false },
          { id: 'Bad Id', name: 'never shown' },
        ],
      },
    });
    expect(built).toBeTruthy();
    await page.goto('archive.html');
    const items = page.locator('#archive-list > li');
    await expect(items).toHaveCount(2);
    await expect(page.locator('#archive-status')).toHaveText('2 past elections, newest first.');
    await expect(items.nth(0).locator('h2')).toHaveText('2026-08-06 General');
    await expect(items.nth(0)).toContainText('Results certified August 20, 2026.');
    await expect(items.nth(0)).toContainText('51,234 ballots cast (21.50% turnout).');
    await expect(items.nth(0).locator('a', { hasText: 'Summary results' })).toHaveAttribute('href', `index.html?election=${ARCHIVE_ID}`);
    await expect(items.nth(0).locator('a', { hasText: 'Precinct results' })).toHaveAttribute('href', `precincts.html?election=${ARCHIVE_ID}`);
    // Names are text, never HTML; an archive without the precinct page has no link to it.
    await expect(items.nth(1).locator('h2')).toHaveText('2024-11-05 General <b>Election</b>');
    await expect(items.nth(1).locator('a', { hasText: 'Precinct results' })).toHaveCount(0);
    await items.nth(0).locator('a', { hasText: 'Summary results' }).click();
    await page.locator('#contests-container article').first().waitFor();
    await expect(page.locator('#official-banner')).toBeVisible();
  });

  test('nothing archived yet, and a failed load', async ({ page }) => {
    await routeArchive(page, { index: 404 });
    await page.goto('archive.html');
    await expect(page.locator('#archive-status')).toHaveText('No past elections have been archived yet.');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routeArchive(page, { index: 500 });
    await page.reload();
    await expect(page.locator('#archive-status')).toHaveText(/could not be loaded/);
  });
});

test.describe('no current election', () => {
  for (const file of ['index.html', 'reporting.html', 'precincts.html', 'scrolling.html']) {
    test(`${file} says there is no current election and links to past results`, async ({ page }) => {
      await routeNoElection(page);
      await page.goto(file);
      const note = page.locator('#no-election-note');
      await expect(note.locator('h1')).toHaveText('There is no current election');
      await expect(note).toContainText('Please come back at a later time');
      await expect(note.locator('a')).toHaveAttribute('href', 'archive.html');
      await expect(page.locator('#live-status')).toBeHidden();
      // Only the message is on the page: nothing of the results layout.
      const visible = await page.locator('#main-content > *').evaluateAll((els) => els.filter((e) => !e.hidden).map((e) => e.id));
      expect(visible).toEqual(['no-election-note']);
    });
  }

  test('the next election\'s first publish shows itself without a reload', async ({ page }) => {
    await page.clock.install();
    await routeNoElection(page);
    await page.goto('index.html');
    await expect(page.locator('#no-election-note')).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await routeProdBucket(page);
    await page.clock.runFor(61000);
    await page.locator('#contests-container article').first().waitFor();
    await expect(page.locator('#no-election-note')).toHaveCount(0);
    await expect(page.locator('#live-status')).toHaveText(/^Results updated /);
  });

  test('results cleared while a page is open: the message replaces them', async ({ page }) => {
    await page.clock.install();
    await page.goto('index.html');
    await page.locator('#contests-container article').first().waitFor();
    await routeNoElection(page);
    await page.clock.runFor(61000);
    await expect(page.locator('#no-election-note')).toBeVisible();
    await expect(page.locator('#contests-container')).toBeHidden();
  });
});
