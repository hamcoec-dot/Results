// End-to-end admin flows on the emulators (plan: Verification checklist): publish two versions through
// the UI, roll back to the first through a rollback draft and see the public page revert, and discard a
// draft so its files are gone. Runs with npm run a11y:admin (emulators:exec sets FIREBASE_EMULATOR_HUB).
const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const path = require('node:path');

const ADMIN = { email: 'admin@example.test', password: 'emulator-only-pw' };
const SAMPLE = (n) => path.join(__dirname, '..', 'Test_Files', 'Web Results Samples', `${n} (92).csv`);
const emulators = !!(process.env.EMULATORS || process.env.FIREBASE_EMULATOR_HUB);

test.describe('admin flows (emulators)', () => {
  test.skip(!emulators, 'set EMULATORS=1 with the emulators running and seeded (npm run a11y:admin)');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  /** Open the dashboard, signing in unless the session already is. */
  async function signIn(page) {
    await page.goto('admin.html?emulator');
    const dashboard = page.locator('#upload-form');
    // admin-common.js shows exactly one of #signin, #not-admin, #app once Auth has answered.
    await page.waitForFunction(() => !document.getElementById('signin').hidden || !document.getElementById('app').hidden, null, { timeout: 15000 });
    if (await page.locator('#signin').isVisible()) {
      await page.fill('#email', ADMIN.email);
      await page.fill('#password', ADMIN.password);
      await page.click('#signin-form button[type="submit"]');
    }
    await expect(dashboard).toBeVisible({ timeout: 15000 });
  }

  async function upload(page, kind, sample) {
    await page.check(`#k-${kind}`);
    await page.setInputFiles('#u-file', SAMPLE(sample));
    await page.click('#upload-form button[type="submit"]');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('contests').getAttribute('aria-busy') !== 'true', null, { timeout: 30000 }); // cards rendered: nothing moves now
  }

  /** On the review screen: tick every warning, open every draft page, publish with the typed count. */
  async function publishFromReview(page) {
    await page.waitForFunction(() => document.getElementById('contests').getAttribute('aria-busy') !== 'true', null, { timeout: 30000 });
    for (const box of await page.locator('#checks input[type="checkbox"]').all()) await box.check();
    for (const link of await page.locator('#previews a').all()) {
      const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await tab.close();
      await page.bringToFront(); // Firefox throttles a background tab's timers
    }
    await expect(page.locator('#publish-btn')).toBeEnabled();
    await page.click('#publish-btn');
    const summary = await page.locator('#publish-summary').textContent();
    const count = /(?:→|first publish,) (\d+) of \d+ precincts/.exec(summary);
    expect(count, summary).not.toBeNull();
    await page.fill('#confirm-count', count[1]);
    await page.click('#publish-confirm');
    await expect(page.locator('#publish-result')).toContainText('Published', { timeout: 60000 });
  }

  const governor = async (page) => {
    await page.goto('index.html?emulator');
    const btn = page.locator('#contests-container .reporting-btn').first();
    await expect(btn).toBeVisible({ timeout: 15000 });
    return (await btn.textContent()).replace(/\s+/g, ' ').trim();
  };

  // Layer 8's election night (plan: Test strategy): every sample from Zero to End of Provisional
  // goes through upload, review and publish in the UI. A public page left open picks up each
  // publish by polling. Every contest, candidate, vote and percentage it shows equals the Python
  // reference output (functions/test/golden) for that point in the night. Precincts reporting is
  // checked against the CSV itself: the reference uses the legacy reporting rule (D1/D2, fixed in the
  // cloud pipeline), so after 03 it says 92 of 92 where the file says 5 of 92. Runs first,
  // on the freshly seeded election, so the Early and ED slots hold exactly what the golden cases used.
  test('election night 00 → 06 through the UI: each publish reaches an open public page, equal to the Python reference', async ({ page, browser }) => {
    test.setTimeout(600000);
    const fs = require('node:fs');
    const golden = (id) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'functions', 'test', 'golden', id, 'summary.json'), 'utf8')).latest;
    const fmt = (n) => n.toLocaleString('en-US');
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const night = [
      ['zero', '00-Zero File', 'samples-92-00-zero'],
      ['early', '01-After NH&ABS', 'samples-92-01-nh-abs'],
      ['early', '02-After EV', 'samples-92-02-ev'],
      ['ed', '03-After 5 Reporting', 'samples-92-03-5-reporting'],
      ['ed', '04-After 10 Reporting', 'samples-92-04-10-reporting'],
      ['ed', '05-End of Election Day', 'samples-92-05-end-ed'],
      ['ed', '06-End of Provisional', 'samples-92-06-end-provisional'],
    ];
    const viewer = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
    let opened = false;
    let before = null; // the reference for what is live before this step
    for (const [kind, sample, id] of night) {
      await signIn(page);
      await upload(page, kind, sample);
      const want = golden(id);
      // The review's diff: every candidate's published → draft votes are the previous step's and
      // this step's reference numbers (plan: "compare the review's contest diff with the CSVs").
      await page.selectOption('#contest-filter', 'all');
      const diff = await page.locator('#contests table').evaluateAll((tables) => Object.fromEntries(tables.map((t) => [
        t.querySelector('caption').textContent.replace(/: published → draft$/, ''),
        Array.from(t.querySelectorAll('tbody tr')).map((r) => [r.querySelector('th').textContent, r.cells[2].textContent, r.cells[3].textContent]),
      ])));
      expect(Object.keys(diff).sort(), sample).toEqual(want.contests.map((c) => c.title).sort());
      for (const c of want.contests) {
        const old = before && before.contests.find((x) => x.title === c.title);
        expect(diff[c.title], `${sample} review / ${c.title}`).toEqual(c.candidates.map((x) => {
          const was = old && old.candidates.find((y) => y.name === x.name);
          return [was ? x.name : `${x.name} (added)`, was ? fmt(was.votes) : '—', fmt(x.votes)];
        }));
      }
      await publishFromReview(page);
      before = want;
      if (!opened) {
        await viewer.goto('index.html?emulator');
        opened = true;
      } else {
        await viewer.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // the poll, now
      }
      await expect(viewer.locator('#stat-ballots'), sample).toHaveText(fmt(want.totalBallots), { timeout: 30000 });
      await expect(viewer.locator('#stat-voters')).toHaveText(fmt(want.totalVoters));
      // Every "R of T Precincts Reporting" header in the file; an Early or Zero file reports no ED precincts.
      const csvText = fs.readFileSync(SAMPLE(sample), 'utf8');
      const inFile = new Set([...csvText.matchAll(/(\d+) of (\d+) Precincts Reporting/g)].map((m) => `${m[1]} of ${m[2]}`));
      const rOfT = (text) => /(\d+) of (\d+)/.exec(text).slice(1).map(Number);
      const okReporting = (text, total) => {
        const [r, t] = rOfT(text);
        expect(t, text).toBe(total);
        if (kind === 'ed') expect(inFile.has(`${r} of ${t}`), `${sample}: "${r} of ${t}" is not in the file`).toBe(true);
        else expect(r, text).toBe(0);
      };
      okReporting(await viewer.locator('#stat-reporting').textContent(), want.overallPrecinctsTotal);
      const shown = await viewer.locator('#contests-container > article').evaluateAll((cards) => cards.map((card) => ({
        title: card.querySelector('.contest-title').textContent,
        meta: card.querySelector('.contest-meta').textContent,
        reporting: card.querySelector('.reporting-btn').textContent,
        rows: Array.from(card.querySelectorAll('.candidate-row')).map((r) => ({
          name: r.querySelector('.cand-name-cell span').textContent,
          votes: r.querySelector('.vote-count').textContent,
          pct: r.querySelector('.vote-percent').textContent,
        })),
      })));
      expect(shown.map((c) => c.title), sample).toEqual(want.contests.map((c) => c.title));
      want.contests.forEach((c, i) => {
        expect(norm(shown[i].meta), `${sample} / ${c.title}`).toContain(`Total Votes: ${fmt(c.totalVotes)}`);
        expect(norm(shown[i].reporting), `${sample} / ${c.title}`).toMatch(/\d+ of \d+ Election Day Precincts Reporting/);
        okReporting(shown[i].reporting, c.precinctsTotal);
        expect(shown[i].rows, `${sample} / ${c.title}`).toEqual(c.candidates.map((x) => ({ name: x.name, votes: fmt(x.votes), pct: `(${x.percentage.toFixed(1)}%)` })));
      });
    }
    await viewer.context().close();
  });

  test('publish 02 then 03; roll back to 02 through review; the public page reverts', async ({ page }) => {
    await signIn(page);
    await upload(page, 'early', '02-After EV');
    await publishFromReview(page);
    const first = await governor(page);

    await signIn(page);
    await upload(page, 'ed', '03-After 5 Reporting');
    await publishFromReview(page);
    const second = await governor(page);
    expect(second).not.toBe(first);

    // History: the older version offers "Roll back to this"; the live one says "Live now".
    await signIn(page);
    const history = page.locator('#history');
    await expect(history.getByText('Live now')).toBeVisible({ timeout: 15000 });
    const rollbackButtons = history.getByRole('button', { name: 'Roll back to this' });
    expect(await rollbackButtons.count()).toBeGreaterThanOrEqual(1);
    await rollbackButtons.first().click(); // newest first: the version just before the live one
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    await page.click('#confirm-ok');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    await expect(page.locator('#status-bar')).toContainText('Rollback to', { timeout: 30000 });
    await expect(page.locator('#checks')).toContainText(/Republishing version/);
    await publishFromReview(page);
    expect(await governor(page)).toBe(first);
  });

  test('discard a draft: it leaves the open-drafts list and its files are deleted', async ({ page, request }) => {
    await signIn(page);
    await upload(page, 'ed', '04-After 10 Reporting');
    const draftId = new URL(page.url()).searchParams.get('draft');
    const reviewUrl = `http://127.0.0.1:9199/download/storage/v1/b/demo-hcec-results/o/${encodeURIComponent(`drafts/${draftId}/review.json`)}?alt=media`;
    expect((await request.get(reviewUrl)).status()).toBe(200);

    await signIn(page);
    const row = page.locator('#drafts tr', { has: page.locator(`a[href*="${draftId}"]`) });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.click('#confirm-ok');
    await expect(page.locator(`#drafts a[href*="${draftId}"]`)).toHaveCount(0, { timeout: 15000 });
    await expect.poll(async () => (await request.get(reviewUrl)).status(), { timeout: 15000 }).toBe(404);
  });

  // Plan checklist: "toggle the precinct page off and check that precincts.html shows Currently
  // Disabled". The setting reaches the public files through a settings draft (#4), reviewed and
  // published like any other; this runs once that button exists.
  test('precinct page off and back on, through a settings draft: precincts.html follows', async ({ page, browser }) => {
    await signIn(page);
    test.skip(await page.locator('#settings-draft-btn').count() === 0, 'needs "Create draft with these settings" (#4)');
    const viewer = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
    for (const on of [false, true]) {
      await signIn(page);
      await page.locator('#s-precinct-page').setChecked(on);
      await page.click('#settings-form button[type="submit"]');
      await expect(page.locator('#page-status')).toContainText('Settings saved', { timeout: 15000 });
      await expect(page.locator('#settings-draft-btn')).toBeVisible();
      await page.click('#settings-draft-btn');
      await page.waitForURL(/review\.html\?/, { timeout: 120000 });
      await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
      await publishFromReview(page);
      await viewer.goto('precincts.html?emulator');
      if (on) {
        await expect(viewer.locator('#precinct-select option').nth(1)).toBeAttached({ timeout: 15000 });
        await expect(viewer.locator('body')).not.toContainText('Currently Disabled');
      } else {
        await expect(viewer.locator('body')).toContainText('Precinct Results Currently Disabled', { timeout: 15000 });
        await viewer.goto('index.html?emulator');
        await expect(viewer.locator('#contests-container .reporting-btn').first()).toBeVisible({ timeout: 15000 });
        for (const link of await viewer.locator('a[href^="precincts.html"]').all()) await expect(link).toBeHidden(); // nav links to it are hidden
      }
    }
    await viewer.context().close();
  });
});

test.describe('publish guard rails (emulators)', () => {
  test.skip(!emulators, 'set EMULATORS=1 with the emulators running and seeded (npm run a11y:admin)');
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  async function signIn(page) {
    await page.goto('admin.html?emulator');
    await page.waitForFunction(() => !document.getElementById('signin').hidden || !document.getElementById('app').hidden, null, { timeout: 15000 });
    if (await page.locator('#signin').isVisible()) {
      await page.fill('#email', ADMIN.email);
      await page.fill('#password', ADMIN.password);
      await page.click('#signin-form button[type="submit"]');
    }
    await expect(page.locator('#upload-form')).toBeVisible({ timeout: 15000 });
  }
  async function upload(page, kind, file) {
    await page.check(`#k-${kind}`);
    await page.setInputFiles('#u-file', file);
    await page.click('#upload-form button[type="submit"]');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('contests').getAttribute('aria-busy') !== 'true', null, { timeout: 30000 }); // cards rendered: nothing moves now
  }
  const tickAll = async (page) => { for (const box of await page.locator('#checks input[type="checkbox"]').all()) await box.check(); };
  const openAll = async (page) => {
    for (const link of await page.locator('#previews a').all()) {
      const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await tab.close();
      await page.bringToFront(); // Firefox throttles a background tab's timers
    }
  };
  async function publish(page) {
    await page.waitForFunction(() => document.getElementById('contests').getAttribute('aria-busy') !== 'true', null, { timeout: 30000 });
    await page.click('#publish-btn');
    const count = /(?:→|first publish,) (\d+) of \d+ precincts/.exec(await page.locator('#publish-summary').textContent());
    await page.fill('#confirm-count', count[1]);
    await page.click('#publish-confirm');
  }

  test('Publish needs every warning ticked and every draft page opened; a wrong typed count is refused', async ({ page }) => {
    await signIn(page);
    await upload(page, 'ed', SAMPLE('05-End of Election Day'));
    const btn = page.locator('#publish-btn');
    await expect(btn).toBeDisabled();
    await tickAll(page);
    await expect(btn).toBeDisabled(); // pages not opened yet
    await expect(page.locator('#publish-needs')).toContainText('✗ Pages opened: 0 of');
    await openAll(page);
    await expect(btn).toBeEnabled();
    await btn.click();
    await page.fill('#confirm-count', '999');
    await page.click('#publish-confirm');
    await expect(page.locator('#confirm-error')).toContainText('That does not match');
    await expect(page.locator('#confirm-count')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#publish-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#publish-dialog')).toBeHidden();
  });

  test('stale: draft A, then B published, then publishing A is refused', async ({ page }) => {
    await signIn(page);
    await upload(page, 'ed', SAMPLE('05-End of Election Day'));
    const draftA = page.url();
    await signIn(page);
    // B must differ from what is live (02 + 06 after the rollback above): publishing a draft equal to
    // the live version leaves currentVersion as it is, so A would rightly not be stale.
    await upload(page, 'ed', SAMPLE('04-After 10 Reporting'));
    await tickAll(page);
    await openAll(page);
    await publish(page);
    await expect(page.locator('#publish-result')).toContainText('Published', { timeout: 60000 });

    await page.goto(draftA);
    await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('contests').getAttribute('aria-busy') !== 'true', null, { timeout: 30000 }); // cards rendered: nothing moves now
    await tickAll(page);
    await openAll(page);
    await publish(page);
    await expect(page.locator('#publish-needs')).toContainText('Draft is stale', { timeout: 30000 });
    await expect(page.locator('#publish-btn')).toBeDisabled();
  });

  test('going backwards (an older ED file) is a warning that must be ticked', async ({ page }) => {
    await signIn(page);
    await upload(page, 'ed', SAMPLE('03-After 5 Reporting'));
    // The county total, plus the contests that went down: one warning each, or one grouped warning
    // ("Contests (n) with fewer precincts reporting") once #8 is merged.
    const warnings = page.locator('#checks .check', { hasText: /Precincts reporting went down|with fewer precincts reporting/ });
    expect(await warnings.count()).toBeGreaterThan(1);
    const warning = warnings.first();
    await expect(warning).toBeVisible();
    await openAll(page);
    await tickAll(page);
    await expect(page.locator('#publish-btn')).toBeEnabled();
    await warning.locator('input[type="checkbox"]').uncheck();
    await expect(page.locator('#publish-btn')).toBeDisabled();
  });

  test('an edited export (a contest claiming more precincts reporting than exist) is blocked', async ({ page }) => {
    // A contest's Totals row cannot be checked against its precinct rows: in the real exports the Totals
    // include votes the precinct rows do not (133 of 230 candidate columns differ). An impossible
    // "R of T" header is what the checks catch.
    const fs = require('node:fs');
    const csv = fs.readFileSync(SAMPLE('03-After 5 Reporting'), 'utf8');
    const tampered = csv.replace('5 of 92 Precincts Reporting', '95 of 92 Precincts Reporting');
    expect(tampered).not.toBe(csv);
    const file = test.info().outputPath('tampered.csv');
    fs.writeFileSync(file, tampered);
    await signIn(page);
    await upload(page, 'ed', file);
    await expect(page.locator('#checks')).toContainText('BLOCKED');
    await expect(page.locator('#publish-needs')).toContainText('✗ No blocking checks');
    await expect(page.locator('#publish-btn')).toBeDisabled();
  });

  test('a signed-in user who is not an admin is refused', async ({ browser, request }) => {
    const email = `clerk${Date.now()}@example.test`;
    const signUp = await request.post('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key',
      { data: { email, password: 'emulator-only-pw', returnSecureToken: true } });
    expect(signUp.ok()).toBe(true);
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    const page = await context.newPage();
    await page.goto('admin.html?emulator');
    await page.fill('#email', email);
    await page.fill('#password', 'emulator-only-pw');
    await page.click('#signin-form button[type="submit"]');
    await expect(page.locator('#not-admin')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#app')).toBeHidden();
    await context.close();
  });
});

test.describe('admin lists on a stalled connection (emulators)', () => {
  test.skip(!emulators, 'set EMULATORS=1 with the emulators running and seeded (npm run a11y:admin)');
  test.setTimeout(120000);

  test('a list that never loads says so after 15 s and offers Retry', async ({ page }) => {
    await page.goto('admin.html?emulator');
    await page.waitForFunction(() => !document.getElementById('signin').hidden || !document.getElementById('app').hidden, null, { timeout: 15000 });
    if (await page.locator('#signin').isVisible()) {
      await page.fill('#email', ADMIN.email);
      await page.fill('#password', ADMIN.password);
      await page.click('#signin-form button[type="submit"]');
    }
    await expect(page.locator('#uploads')).toContainText(/None.|Every uploaded file/, { timeout: 15000 }); // loaded once
    // From now on Firestore never answers (requests are held, not refused).
    await page.route('http://127.0.0.1:8181/**', () => {});
    const select = page.locator('#election-select');
    const value = await select.inputValue();
    await select.selectOption('__new__'); // "+ New election…"
    await select.selectOption(value); // back: reloads the three lists
    await expect(page.locator('#drafts')).toContainText('Loading drafts…');
    await expect(page.locator('#drafts')).toContainText('Still loading drafts', { timeout: 20000 });
    await expect(page.locator('#uploads').getByRole('button', { name: 'Retry' })).toBeVisible();
    await page.unroute('http://127.0.0.1:8181/**');
  });
});
