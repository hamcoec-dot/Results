// Long tasks during a live refresh (plan: Performance › budgets: none > 50 ms during an auto-refresh).
// Every one of the 63 contests changes (sample 02 → 05), CPU throttled 4×, at 412 px. Timing depends
// on the machine, so this runs only with PERF=1 (`PERF=1 npm run a11y -- refresh-longtasks`) and reports;
// add STRICT=1 to fail on a long task. Results are recorded in perf/BASELINE.md.
const { test, expect } = require('@playwright/test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const read = (dir, file) => fs.readFileSync(path.join(GOLDEN, dir, file));
const manifest = (dir) => JSON.stringify({
  dataVersion: JSON.parse(read(dir, 'summary.json')).metadata.dataVersion,
  updatedAt: '2026-11-03T22:00:00-05:00',
  files: Object.fromEntries(['summary.json', 'reporting.json', 'precincts.json'].map((f) => [f, crypto.createHash('sha256').update(read(dir, f)).digest('hex')])),
});
const BEFORE = 'samples-92-02-ev'; // every contest 0 of 92
const AFTER = 'samples-92-05-end-ed'; // every contest 92 of 92
const SHOWN = {
  'index.html': '#contests-container .reporting-btn',
  'reporting.html': '#reporting-table-body .reporting-btn',
  'precincts.html': '#precinct-results-container .status-pill',
};

test.describe('long tasks during a live refresh', () => {
  test.skip(!process.env.PERF, 'timing test: run with PERF=1');
  test.describe.configure({ mode: 'serial' });

  for (const [file, selector] of Object.entries(SHOWN)) {
    test(file, async ({ page }) => {
      const state = { dir: BEFORE };
      await page.route('http://127.0.0.1:9199/**', (route) => {
        const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname.split('/o/')[1]));
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: name === 'manifest.json' ? manifest(state.dir) : read(state.dir, name) });
      });
      await page.setViewportSize({ width: 412, height: 823 });
      await page.goto(`${file}?emulator`);
      const first = page.locator(selector).first();
      await expect(first).toContainText(file === 'precincts.html' ? 'PENDING' : '0 of 92');
      await page.waitForTimeout(500);

      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.evaluate(() => {
        window.__longTasks = [];
        new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask' });
      });
      state.dir = AFTER;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await expect(first).toContainText(file === 'precincts.html' ? 'REPORTED' : '92 of 92', { timeout: 15000 });
      await page.waitForTimeout(1500); // let the remaining batches run
      const tasks = await page.evaluate(() => window.__longTasks);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      test.info().annotations.push({ type: 'long tasks (ms)', description: JSON.stringify(tasks) });
      console.log(`${file}: long tasks during the refresh (ms): ${JSON.stringify(tasks)}`);
      if (process.env.STRICT) expect(tasks.filter((d) => d > 50)).toEqual([]);
    });
  }
});
