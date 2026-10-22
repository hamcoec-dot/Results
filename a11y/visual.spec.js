// Layer 9, visual regression: screenshots of the public pages compared with committed baselines.
// Font rendering differs by platform, so the baselines are per OS (Playwright's -win32 / -linux
// suffix) and the suite runs only on request:
//   VISUAL=1 npx playwright test --config a11y/playwright.config.js visual
//   VISUAL=1 npx playwright test --config a11y/playwright.config.js visual --update-snapshots   (after an intended change)
// The pages read the committed root data with ?local (deterministic, and the same data and status line as the
// baselines were taken with, before the default switched to the bucket); animations are off and the slideshow is paused.
const { test, expect } = require('./fixtures'); // fixtures: the production bucket is never fetched

test.describe('visual regression', () => {
  test.skip(!process.env.VISUAL, 'screenshot comparison: run with VISUAL=1');
  test.use({ reducedMotion: 'reduce' });

  // The plan's widths: 320 (smallest phone, reflow), 375 (phone), 768 (tablet), 1280 (desktop).
  const SIZES = [[320, 640], [375, 812], [768, 1024], [1280, 800]];
  const shots = [
    ['index', 'index.html?local', '#contests-container article'],
    ['reporting', 'reporting.html?local', '#reporting-table-body tr'],
    ['precincts', 'precincts.html?local', '#precinct-results-container article'],
    ['scrolling', 'scrolling.html?local', '#slide-viewport .slide-card'],
  ];
  for (const [name, file, ready] of shots) {
    for (const [w, h] of SIZES) {
      test(`${name} @ ${w}px`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(file);
        await page.locator(ready).first().waitFor();
        if (file.startsWith('scrolling.html')) await page.click('#btn-playpause');
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${name}-${w}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
      });
    }
  }

  // admin.html before sign-in (the signed-in screens hold live times and ids; a11y:admin audits them).
  for (const [w, h] of SIZES) {
    test(`admin signed out @ ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('admin.html?emulator');
      await page.locator('#signin').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`admin-signin-${w}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
    });
  }

  test('index dark mode @ 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('index.html?local');
    await page.locator('#contests-container article').first().waitFor();
    await page.click('#dark-mode-toggle');
    await expect(page).toHaveScreenshot('index-dark-375.png', { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
  });

  test('precinct dialog @ 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('index.html?local');
    await page.locator('#contests-container .reporting-btn').first().click();
    await page.locator('#modal-precinct-grid .precinct-chip').first().waitFor();
    await expect(page).toHaveScreenshot('dialog-375.png', { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
  });

  // Forced colors (Windows High Contrast): buttons keep outlines, the selected filter and pressed
  // toggles use Highlight, bars stay visible (styles.css @media (forced-colors: active)).
  for (const [name, file, ready] of [['index', 'index.html?local', '#contests-container article'], ['scrolling', 'scrolling.html?local', '#slide-viewport .slide-card'], ['admin-signin', 'admin.html?emulator', '#signin']]) {
    test(`${name} forced colors @ 375px`, async ({ page }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(file);
      await page.locator(ready).first().waitFor();
      if (file.startsWith('scrolling.html')) await page.click('#btn-playpause');
      if (file.startsWith('index.html')) await page.click('.tab-btn[data-party="REP"]'); // a selected filter
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`${name}-forced-375.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
    });
  }
});
