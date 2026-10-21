// Accessibility of admin.html and review.html, signed in, on the Firebase emulators
// (plan: Mobile & accessibility requirements; Phase 3 follow-up).
//
// Needs the emulators running and seeded, so it is skipped unless EMULATORS=1:
//   npm run a11y:admin   (starts the emulators, seeds them, runs this file)
// Signed-out states are covered here too, and need no emulator.
const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const path = require('node:path');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const WIDTHS = [320, 375, 1280];
// The emulator-only admin from tools/seed-emulator.js.
const ADMIN = { email: 'admin@example.test', password: 'emulator-only-pw' };
const SAMPLE = path.join(__dirname, '..', 'Test_Files', 'Web Results Samples', '02-After EV (92).csv');
// emulators:exec sets FIREBASE_EMULATOR_HUB; EMULATORS=1 is for emulators started by hand.
const emulators = !!(process.env.EMULATORS || process.env.FIREBASE_EMULATOR_HUB);

function describe(violations) {
  return violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n` + v.nodes.slice(0, 5).map((n) => `    ${n.target.join(' ')}\n      ${n.failureSummary.split('\n').join('\n      ')}`).join('\n')).join('\n');
}

async function audit(page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(violations, describe(violations)).toEqual([]);
}

async function noHorizontalScroll(page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, 'page scrolls horizontally').toBeLessThanOrEqual(0);
}

for (const width of WIDTHS) {
  test(`admin.html signed out @ ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('admin.html?emulator');
    await expect(page.locator('#signin')).toBeVisible();
    await audit(page);
    await noHorizontalScroll(page);
  });
}

test.describe('signed in (emulators)', () => {
  test.skip(!emulators, 'set EMULATORS=1 with the emulators running and seeded (npm run a11y:admin)');
  test.describe.configure({ mode: 'serial' });

  let reviewUrl;

  async function signIn(page) {
    await page.goto('admin.html?emulator');
    await page.fill('#email', ADMIN.email);
    await page.fill('#password', ADMIN.password);
    await page.click('#signin-form button[type="submit"]');
    await expect(page.locator('#upload-form')).toBeVisible({ timeout: 15000 });
  }

  test('admin.html: dashboard, and an upload that opens review', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await audit(page);
      await noHorizontalScroll(page);
    }
    // Errors are announced next to the fields (3.3.1): submit with nothing chosen.
    await page.click('#upload-form button[type="submit"]');
    await expect(page.locator('#kind-error')).not.toBeEmpty();
    await audit(page);

    await page.check('#k-early');
    await page.setInputFiles('#u-file', SAMPLE);
    await page.click('#upload-form button[type="submit"]');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    reviewUrl = page.url();
  });

  test('review.html: checks, headline and publish dialog', async ({ page }) => {
    test.skip(!reviewUrl, 'needs the upload from the previous test');
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('admin.html?emulator');
    await page.fill('#email', ADMIN.email);
    await page.fill('#password', ADMIN.password);
    await page.click('#signin-form button[type="submit"]');
    await expect(page.locator('#upload-form')).toBeVisible({ timeout: 15000 });
    await page.goto(reviewUrl);
    await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('contests').getAttribute('aria-busy') !== 'true', null, { timeout: 30000 }); // cards rendered: nothing moves now
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await audit(page);
    }
    await page.setViewportSize({ width: 375, height: 800 });
    await noHorizontalScroll(page);

    // Ready to publish: every warning ticked, every draft page opened (each opens in a new tab).
    for (const box of await page.locator('#checks input[type="checkbox"]').all()) await box.check();
    for (const link of await page.locator('#previews a').all()) {
      const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()]);
      await tab.close();
      await page.bringToFront(); // Firefox throttles a background tab's timers
    }
    await expect(page.locator('#publish-btn')).toBeEnabled();
    await audit(page);

    // The publish dialog, open: native <dialog>, focus inside, typed count required.
    await page.click('#publish-btn');
    await expect(page.locator('#publish-dialog')).toBeVisible();
    await audit(page);
    // "… first publish, 0 of 92 precincts reporting …" or "… 5 → 10 of 92 …": type the draft's count.
    const summary = await page.locator('#publish-summary').textContent();
    const count = /(?:→|first publish,) (\d+) of \d+ precincts/.exec(summary);
    expect(count, summary).not.toBeNull();
    await page.fill('#confirm-count', count[1]);
    await page.click('#publish-confirm');
    await expect(page.locator('#publish-result')).toContainText('Published', { timeout: 60000 });
    await audit(page);

    // Back on the dashboard with a version published: the published-versions history, and any controls
    // that need something published (e.g. a settings rebuild), at every width.
    await page.goto('admin.html?emulator');
    await expect(page.locator('#published-now')).toContainText('Live data version', { timeout: 15000 });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await audit(page);
      await noHorizontalScroll(page);
    }
  });

  test('review.html: a blocked draft (Election Day file uploaded as Zero)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page);
    await page.check('#k-zero');
    await page.setInputFiles('#u-file', path.join(__dirname, '..', 'Test_Files', 'Web Results Samples', '03-After 5 Reporting (92).csv'));
    await page.click('#upload-form button[type="submit"]');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    await expect(page.locator('#checks')).toContainText('BLOCKED', { timeout: 30000 });
    await expect(page.locator('#publish-btn')).toBeDisabled();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await audit(page);
    }
  });
});
