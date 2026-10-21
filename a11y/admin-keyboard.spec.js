// Keyboard only (WCAG 2.1.1, 2.4.3; manual checklist item 1, automated): sign in, upload, review,
// tick every warning, open every draft page, publish, then start a rollback, using only Tab,
// Shift+Tab, Space, Enter, arrow keys and typing. Every control must be reachable in the tab order;
// focus must go into each dialog and come back. The file itself is chosen with setInputFiles, since
// the system file picker is outside the page. Runs in npm run a11y:admin (emulators).
const { test, expect } = require('@playwright/test');
const path = require('node:path');

const ADMIN = { email: 'admin@example.test', password: 'emulator-only-pw' };
const SAMPLE = path.join(__dirname, '..', 'Test_Files', 'Web Results Samples', '04-After 10 Reporting (92).csv');
const emulators = !!(process.env.EMULATORS || process.env.FIREBASE_EMULATOR_HUB);

/** Press Tab until `selector` (or the element `match` picks) has focus; fail if it is not in the tab order. */
async function tabTo(page, selector, { max = 400, back = false } = {}) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((s) => document.activeElement && document.activeElement.matches(s), selector)) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`${selector} is not reachable with ${back ? 'Shift+' : ''}Tab`);
}
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}` : null;
});

test.describe('admin by keyboard only (emulators)', () => {
  test.skip(!emulators, 'set EMULATORS=1 with the emulators running and seeded (npm run a11y:admin)');
  test.setTimeout(300000);

  test('sign in → upload → review → tick → open pages → publish → rollback draft', async ({ page, context }) => {
    await page.goto('admin.html?emulator');
    await page.waitForFunction(() => !document.getElementById('signin').hidden || !document.getElementById('app').hidden, null, { timeout: 15000 });
    if (await page.locator('#signin').isVisible()) {
      await tabTo(page, '#email');
      await page.keyboard.type(ADMIN.email);
      await tabTo(page, '#password');
      await page.keyboard.type(ADMIN.password);
      await page.keyboard.press('Enter'); // submits the form
    }
    await expect(page.locator('#upload-form')).toBeVisible({ timeout: 15000 });

    // Setup, by mouse (not under test): the rollback at the end needs an earlier published version.
    await expect(page.locator('#history')).toContainText(/None\.|Live now/, { timeout: 15000 });
    if (!(await page.locator('#history').textContent()).includes('Live now')) {
      await page.check('#k-early');
      await page.setInputFiles('#u-file', SAMPLE.replace('04-After 10 Reporting', '02-After EV'));
      await page.click('#upload-form button[type="submit"]');
      await page.waitForURL(/review\.html\?/, { timeout: 120000 });
      await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
      for (const box of await page.locator('#checks input[type="checkbox"]').all()) await box.check();
      for (const link of await page.locator('#previews a').all()) {
        const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
        await tab.close();
      }
      await page.click('#publish-btn');
      await page.fill('#confirm-count', /(?:→|first publish,) (\d+) of/.exec(await page.locator('#publish-summary').textContent())[1]);
      await page.click('#publish-confirm');
      await expect(page.locator('#publish-result')).toContainText('Published', { timeout: 60000 });
      await page.goto('admin.html?emulator');
      await expect(page.locator('#upload-form')).toBeVisible({ timeout: 15000 });
    }

    // Upload: the kind is a radio group (arrow keys), the file input is reachable, the button submits.
    await tabTo(page, 'input[name="kind"]');
    for (let i = 0; i < 3 && !(await page.locator('#k-ed').isChecked()); i++) await page.keyboard.press('ArrowDown');
    await expect(page.locator('#k-ed')).toBeChecked();
    await tabTo(page, '#u-file');
    await page.setInputFiles('#u-file', SAMPLE);
    await tabTo(page, '#upload-form button[type="submit"]');
    await page.keyboard.press('Enter');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });

    // Every warning: reached with Tab and ticked with Space.
    const boxes = await page.locator('#checks input[type="checkbox"]').evaluateAll((els) => els.map((e) => e.id));
    expect(boxes.every(Boolean), 'every warning checkbox has an id').toBe(true);
    for (const id of boxes) {
      await tabTo(page, `[id="${id}"]`);
      await page.keyboard.press('Space');
      await expect(page.locator(`[id="${id}"]`)).toBeChecked();
    }

    // Every draft page: Enter on the link opens it in a new tab.
    const links = await page.locator('#previews a').count();
    expect(links).toBeGreaterThan(0);
    for (let i = 0; i < links; i++) {
      await page.locator('#previews a').nth(i).evaluate((a) => a.setAttribute('data-kb', '1'));
      await tabTo(page, '#previews a[data-kb]');
      const [tab] = await Promise.all([context.waitForEvent('page'), page.keyboard.press('Enter')]);
      await tab.close();
      await page.locator('#previews a[data-kb]').evaluate((a) => a.removeAttribute('data-kb'));
    }

    // Publish: Enter opens the dialog with focus in the count; Escape closes it and focus returns.
    await tabTo(page, '#publish-btn');
    await expect(page.locator('#publish-btn')).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect(page.locator('#publish-dialog')).toBeVisible();
    expect(await focused(page)).toBe('input#confirm-count');
    await page.keyboard.press('Escape');
    await expect(page.locator('#publish-dialog')).toBeHidden();
    expect(await focused(page)).toBe('button#publish-btn');
    await page.keyboard.press('Enter');
    const count = /(?:→|first publish,) (\d+) of \d+ precincts/.exec(await page.locator('#publish-summary').textContent())[1];
    await page.keyboard.type(count);
    await page.keyboard.press('Enter');
    await expect(page.locator('#publish-result')).toContainText('Published', { timeout: 60000 });
    expect(await focused(page)).toBe('div#publish-result'); // the result is announced and focused

    // Back to the dashboard by the header link, then a rollback draft from history.
    await tabTo(page, '#back-admin', { back: true, max: 3000 });
    await page.keyboard.press('Enter');
    await expect(page.locator('#history')).toContainText('Live now', { timeout: 15000 });
    await page.locator('#history button', { hasText: 'Roll back to this' }).first().evaluate((b) => b.setAttribute('data-kb', '1'));
    await tabTo(page, '#history button[data-kb]');
    await page.keyboard.press('Enter');
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('confirm-dialog').contains(document.activeElement)), 'focus is inside the dialog').toBe(true);
    await tabTo(page, '#confirm-ok');
    await page.keyboard.press('Enter');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    await expect(page.locator('#status-bar')).toContainText('Rollback to', { timeout: 30000 });
  });
});
