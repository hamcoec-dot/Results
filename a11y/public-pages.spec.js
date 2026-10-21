// Accessibility checks for the public pages (plan: Mobile & accessibility requirements).
// Each page is loaded in its default mode (./ data), checked with axe for WCAG 2.1 A + AA,
// and checked for horizontal page scroll (1.4.10).
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
      if (file !== 'scrolling.html') await noHorizontalScroll(page);
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

for (const mode of ['dark-mode-toggle', 'contrast-toggle']) {
  test(`index.html with #${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('index.html');
    await page.locator(PAGES['index.html']).first().waitFor();
    await page.click(`#${mode}`);
    await audit(page);
  });
}

test('precinct reporting dialog', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('index.html');
  await page.locator('#contests-container .reporting-btn').first().click();
  await expect(page.locator('#precinct-modal')).toBeVisible();
  await audit(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#precinct-modal')).toBeHidden();
});

test('precincts.html by contest', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('precincts.html');
  await page.locator(PAGES['precincts.html']).first().waitFor();
  await page.click('#view-mode-contest-btn');
  await page.locator('#precinct-results-container table').waitFor();
  await audit(page);
  await noHorizontalScroll(page);
});
