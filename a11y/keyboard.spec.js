// Keyboard only on the public pages (WCAG 2.1.1, 2.1.2, 2.4.3; manual checklist, automated in
// Chromium): filters, search, the precinct dialog, exports, the precinct picker and views, and every
// slideshow control. Each control must be reachable with Tab and work with Enter, Space or the arrow
// keys; the dialog takes focus and gives it back. Also: Fullscreen is hidden where the browser has no
// fullscreen API (iPhone Safari) instead of throwing when pressed.
const { test, expect } = require('@playwright/test');

/**
 * Tab forward until `selector` has focus, then Shift+Tab backward if it was not ahead. Firefox's Tab
 * leaves the page for the browser's toolbar at the end instead of wrapping to the top as Chromium does.
 */
async function tabTo(page, selector, max = 300) {
  const here = () => page.evaluate((s) => document.activeElement && document.activeElement.matches(s), selector);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < max; i++) {
      if (await here()) return;
      await page.keyboard.press(key);
    }
  }
  throw new Error(`${selector} is not reachable with Tab or Shift+Tab`);
}

function noErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test('summary page by keyboard: party filter, search, precinct dialog in and out, export', async ({ page }) => {
  const errors = noErrors(page);
  await page.goto('index.html');
  const cards = page.locator('#contests-container > article');
  await expect(cards.first()).toBeVisible();
  const all = await cards.count();

  await tabTo(page, '.tab-btn[data-party="REP"]');
  await page.keyboard.press('Enter');
  await expect(page.locator('.tab-btn[data-party="REP"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => cards.count()).toBeLessThan(all);
  await page.keyboard.press('Shift+Tab'); // back to "All Contests"
  await page.keyboard.press('Space');
  await expect(page.locator('.tab-btn[data-party="ALL"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => cards.count()).toBe(all);

  await tabTo(page, '#contest-search');
  await page.keyboard.type('governor');
  await expect.poll(() => cards.count()).toBeLessThan(all);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await expect.poll(() => cards.count()).toBe(all);

  await tabTo(page, '#contests-container .reporting-btn');
  await page.keyboard.press('Enter');
  await expect(page.locator('#precinct-modal')).toBeVisible();
  expect(await page.evaluate(() => document.getElementById('precinct-modal').contains(document.activeElement)), 'focus moves into the dialog').toBe(true);
  for (let i = 0; i < 25; i++) { // Tab stays inside the open dialog
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.getElementById('precinct-modal').contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#precinct-modal')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement.classList.contains('reporting-btn')), 'focus returns to the button').toBe(true);

  await page.getByRole('button', { name: /Export CSV/ }).evaluate((b) => b.setAttribute('data-kb', '1'));
  await tabTo(page, 'button[data-kb]', 400);
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  expect(errors).toEqual([]);
});

test('precinct page by keyboard: pick a precinct with the arrow keys, switch views', async ({ page }) => {
  const errors = noErrors(page);
  await page.goto('precincts.html');
  await expect(page.locator('#precinct-select option').nth(1)).toBeAttached();
  await tabTo(page, '#precinct-select');
  const before = await page.inputValue('#precinct-select');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.inputValue('#precinct-select')).not.toBe(before);
  await expect(page).toHaveURL(/precinct=/);
  await tabTo(page, '#view-mode-contest-btn');
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-mode-contest-btn')).toHaveAttribute('aria-pressed', 'true');
  await tabTo(page, '#contest-precinct-select');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await tabTo(page, '#view-mode-precinct-btn');
  await page.keyboard.press('Space');
  await expect(page.locator('#view-mode-precinct-btn')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('slideshow by keyboard: pause/play, next/prev, speed, jump menu, fullscreen', async ({ page }) => {
  const errors = noErrors(page);
  await page.goto('scrolling.html');
  await expect(page.locator('#slide-viewport .slide-card').first()).toBeVisible();
  const slide = () => page.inputValue('#slide-jump-menu');

  await tabTo(page, '#btn-playpause');
  await page.keyboard.press('Enter');
  await expect(page.locator('#btn-playpause')).toContainText('Play slideshow'); // paused
  await expect(page.locator('#slide-viewport')).toHaveAttribute('aria-live', 'polite');

  await tabTo(page, '#btn-next');
  const s0 = await slide();
  await page.keyboard.press('Enter');
  await expect.poll(slide).not.toBe(s0);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab'); // #btn-prev, before play/pause
  expect(await page.evaluate(() => document.activeElement.id)).toBe('btn-prev');
  await page.keyboard.press('Space');
  await expect.poll(slide).toBe(s0);

  await tabTo(page, '#speed-select');
  const speed = await page.inputValue('#speed-select');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => page.inputValue('#speed-select')).not.toBe(speed);

  await tabTo(page, '#slide-jump-menu');
  await page.keyboard.press('ArrowDown');
  await expect.poll(slide).not.toBe(s0);
  await expect(page.locator('#slide-viewport .slide-card').first()).toBeVisible();

  // Where the browser has no fullscreen (iPhone), the button is hidden instead.
  if (await page.evaluate(() => !document.fullscreenEnabled)) {
    await expect(page.locator('#btn-fullscreen')).toBeHidden();
  } else {
    await tabTo(page, '#btn-fullscreen');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.keyboard.press('Enter'); // focus stays on the button: press again to leave
    await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  }
  expect(errors).toEqual([]);
});

test('no fullscreen API (iPhone Safari): the Fullscreen button is hidden and nothing throws', async ({ page }) => {
  await page.addInitScript(() => {
    delete Element.prototype.requestFullscreen;
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
  });
  const errors = noErrors(page);
  await page.goto('scrolling.html');
  await expect(page.locator('#slide-viewport .slide-card').first()).toBeVisible();
  await expect(page.locator('#btn-fullscreen')).toBeHidden();
  await page.evaluate(() => window.ElectionApp.toggleFullscreen()); // a stale bookmark or old copy calling it
  expect(errors).toEqual([]);
});
