// Accessibility checks for the public pages (plan: Mobile & accessibility requirements).
// Each page is loaded in its default mode (./ data), checked with axe for WCAG 2.1 A + AA,
// and checked for horizontal page scroll (1.4.10) and for text clipped under text-spacing overrides (1.4.12).
const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('node:fs');
const path = require('node:path');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const WIDTHS = [320, 375, 1280];
const PAGES = {
  'index.html': '#contests-container article',
  'reporting.html': '#reporting-table-body tr',
  'precincts.html': '#precinct-results-container article',
  'scrolling.html': '#slide-viewport .slide-card, #slide-viewport > *',
};
const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden', 'samples-92-03-5-reporting');
const DRAFT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

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

/** Serve a draft's files from a golden output (the shape createDraft writes). */
async function routeDraft(page) {
  await page.route(`**/drafts/${DRAFT_ID}/*`, (route) => {
    const file = path.join(GOLDEN, path.basename(new URL(route.request().url()).pathname));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(file) });
  });
}

for (const [file, ready] of Object.entries(PAGES)) {
  for (const width of WIDTHS) {
    test(`${file} @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(file);
      await page.locator(ready).first().waitFor();
      await audit(page);
      await noHorizontalScroll(page);
    });
  }

  test(`${file} draft view`, async ({ page }) => {
    await routeDraft(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${file}?draft=${DRAFT_ID}`);
    await page.locator(ready).first().waitFor();
    await expect(page.locator('.draft-banner')).toBeVisible();
    await expect(page).toHaveTitle(/^\[DRAFT\] /);
    await audit(page);
  });
}

// ?staging shows test numbers on the official domain, so it is always marked as test data.
test('index.html staging view is marked as test data', async ({ page }) => {
  await routeDraft(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`index.html?staging&draft=${DRAFT_ID}`);
  await page.locator(PAGES['index.html']).first().waitFor();
  await expect(page.locator('.draft-banner')).toHaveText(/^STAGING — TEST DATA, NOT REAL RESULTS/);
  await expect(page).toHaveTitle(/^\[TEST\] /);
  expect(page.url()).toContain('staging');
  await audit(page);
});

for (const mode of ['dark-mode-toggle', 'contrast-toggle']) {
  test(`index.html with #${mode}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // colours at rest, not mid-transition
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('index.html');
    await page.locator(PAGES['index.html']).first().waitFor();
    await page.click(`#${mode}`);
    await audit(page);
  });
}

test('precinct reporting dialog', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('index.html');
  await page.locator('#contests-container .reporting-btn').first().click();
  await expect(page.locator('#precinct-modal')).toBeVisible();
  await audit(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#precinct-modal')).toBeHidden();
});

test('precincts.html by contest', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('precincts.html');
  await page.locator(PAGES['precincts.html']).first().waitFor();
  await page.click('#view-mode-contest-btn');
  await page.locator('#precinct-results-container table').waitFor();
  await audit(page);
  await noHorizontalScroll(page);
});

// 1.4.12: with the WCAG text-spacing overrides applied, no text container clips its content.
const TEXT_SPACING = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';

for (const [file, ready] of Object.entries(PAGES)) {
  for (const width of [320, 1280]) {
    test(`${file} text spacing @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(file);
      await page.locator(ready).first().waitFor();
      await page.addStyleTag({ content: TEXT_SPACING });
      const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || !el.textContent.trim()) return false;
        // Screen-reader-only text and decorative parts are clipped by design (on phones that
        // includes the reporting tables' column headers: each cell shows its own label).
        if (el.closest('.sr-only, .skip-link, [aria-hidden="true"]')) return false;
        if (innerWidth <= 640 && el.closest('.stack-on-phone thead')) return false;
        const hidX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
        const hidY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
        return (hidX && el.scrollWidth > el.clientWidth + 1) || (hidY && el.scrollHeight > el.clientHeight + 1);
      }).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`));
      expect(clipped, 'text clipped under text-spacing overrides').toEqual([]);
      await noHorizontalScroll(page);
    });
  }
}

// Project standard (plan: Layout): touch targets at least 44 x 44 px on phones.
for (const [file, ready] of Object.entries(PAGES)) {
  test(`${file} touch targets @ 375px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(file);
    await page.locator(ready).first().waitFor();
    const small = await page.evaluate(() => Array.from(document.querySelectorAll('button, a[href], select, input:not([type=hidden])'))
      .filter((el) => {
        if (el.closest('.sr-only, .skip-link, [aria-hidden="true"]') || getComputedStyle(el).visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
      })
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
    expect(small, 'controls under 44 x 44 px').toEqual([]);
  });
}

// Dark mode and high contrast on every page (contest slides and the precinct table included).
for (const theme of ['dark-mode-toggle', 'contrast-toggle']) {
  for (const [file, ready] of Object.entries(PAGES)) {
    test(`${file} with #${theme} @ 375px`, async ({ page }) => {
      // Colours are checked at rest: with reduced motion the theme and filter transitions finish at once.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(file);
      await page.locator(ready).first().waitFor();
      await page.click(`#${theme}`);
      await audit(page);
      if (file === 'scrolling.html') {
        await page.click('#btn-playpause');
        for (const slide of ['1', '20']) {
          await page.selectOption('#slide-jump-menu', slide);
          await audit(page);
        }
      }
      if (file === 'precincts.html') {
        await page.click('#view-mode-contest-btn');
        await page.locator('#precinct-results-container table').waitFor();
        await audit(page);
      }
    });
  }
}

// 2.4.1 / 2.4.7: the first Tab shows "Skip to main content"; following it moves focus into <main>.
for (const [file, ready] of Object.entries(PAGES)) {
  test(`${file} skip link`, async ({ page }) => {
    await page.goto(file);
    await page.locator(ready).first().waitFor();
    await page.keyboard.press('Tab');
    const skip = page.locator('a.skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('#main-content'))).toBe(true);
  });
}
