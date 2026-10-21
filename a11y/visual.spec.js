// Layer 9, visual regression: screenshots of the public pages compared with committed baselines.
// Font rendering differs by platform, so the baselines are per OS (Playwright's -win32 / -linux
// suffix) and the suite runs only on request:
//   VISUAL=1 npx playwright test --config a11y/playwright.config.js visual
//   VISUAL=1 npx playwright test --config a11y/playwright.config.js visual --update-snapshots   (after an intended change)
// The pages read the committed root data (deterministic); animations are off and the slideshow is paused.
const { test, expect } = require('@playwright/test');

test.describe('visual regression', () => {
  test.skip(!process.env.VISUAL, 'screenshot comparison: run with VISUAL=1');
  test.use({ reducedMotion: 'reduce' });

  const shots = [
    ['index', 'index.html', '#contests-container article'],
    ['reporting', 'reporting.html', '#reporting-table-body tr'],
    ['precincts', 'precincts.html', '#precinct-results-container article'],
    ['scrolling', 'scrolling.html', '#slide-viewport .slide-card'],
  ];
  for (const [name, file, ready] of shots) {
    for (const [w, h] of [[375, 812], [1280, 800]]) {
      test(`${name} @ ${w}px`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(file);
        await page.locator(ready).first().waitFor();
        if (file === 'scrolling.html') await page.click('#btn-playpause');
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${name}-${w}.png`, { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
      });
    }
  }

  test('index dark mode @ 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('index.html');
    await page.locator('#contests-container article').first().waitFor();
    await page.click('#dark-mode-toggle');
    await expect(page).toHaveScreenshot('index-dark-375.png', { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
  });

  test('precinct dialog @ 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('index.html');
    await page.locator('#contests-container .reporting-btn').first().click();
    await page.locator('#modal-precinct-grid .precinct-chip').first().waitFor();
    await expect(page).toHaveScreenshot('dialog-375.png', { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002 });
  });
});
