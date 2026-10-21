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
  }

  /** On the review screen: tick every warning, open every draft page, publish with the typed count. */
  async function publishFromReview(page) {
    for (const box of await page.locator('#checks input[type="checkbox"]').all()) await box.check();
    for (const link of await page.locator('#previews a').all()) {
      const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await tab.close();
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
    await rollbackButtons.last().click();
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
  }
  const tickAll = async (page) => { for (const box of await page.locator('#checks input[type="checkbox"]').all()) await box.check(); };
  const openAll = async (page) => {
    for (const link of await page.locator('#previews a').all()) {
      const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await tab.close();
    }
  };
  async function publish(page) {
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
    await upload(page, 'ed', SAMPLE('06-End of Provisional'));
    await tickAll(page);
    await openAll(page);
    await publish(page);
    await expect(page.locator('#publish-result')).toContainText('Published', { timeout: 60000 });

    await page.goto(draftA);
    await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
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
