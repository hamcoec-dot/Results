// A page left open through many publishes keeps its memory flat (plan: Verification › manual
// performance checklist, "memory is stable"). 30 publishes alternate between two samples in which
// every contest changes, so each one swaps every card. After a garbage collection, the DOM node
// count must equal the first refresh's and the JS heap must not grow by more than a tenth.
// Chromium only (CDP heap counters).
const { test, expect } = require('./fixtures'); // fixtures: the production bucket is never fetched
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
const A = 'samples-92-02-ev'; // every contest 0 of 92
const B = 'samples-92-05-end-ed'; // every contest 92 of 92
const SHOWN = {
  'index.html': '#contests-container .reporting-btn',
  'reporting.html': '#reporting-table-body .reporting-btn',
  'precincts.html': '#precinct-results-container .status-pill',
};
const PUBLISHES = 30;

test.describe('memory through many publishes', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'CDP heap counters');

  for (const [file, selector] of Object.entries(SHOWN)) {
    test(file, async ({ page }) => {
      test.setTimeout(120000);
      const state = { dir: A };
      await page.route('http://127.0.0.1:9199/**', (route) => {
        const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname.split('/o/')[1]));
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: name === 'manifest.json' ? manifest(state.dir) : read(state.dir, name) });
      });
      await page.goto(`${file}?emulator`);
      const first = page.locator(selector).first();
      const shows = (dir) => (file === 'precincts.html' ? (dir === A ? 'PENDING' : 'REPORTED') : (dir === A ? '0 of 92' : '92 of 92'));
      await expect(first).toContainText(shows(A));

      const cdp = await page.context().newCDPSession(page);
      const measure = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        const { usedSize } = await cdp.send('Runtime.getHeapUsage');
        const { nodes } = await page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length }));
        return { heap: usedSize, nodes };
      };
      const publish = async () => {
        state.dir = state.dir === A ? B : A;
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // checks the manifest now
        await expect(first).toContainText(shows(state.dir), { timeout: 15000 });
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0); // batched swaps finished
      };

      for (let i = 0; i < 2; i++) await publish(); // warm up: both versions rendered once
      const start = await measure();
      for (let i = 2; i < PUBLISHES; i++) await publish();
      const end = await measure();
      console.log(`${file}: after ${PUBLISHES} publishes: nodes ${start.nodes} → ${end.nodes}, heap ${(start.heap / 1e6).toFixed(1)} → ${(end.heap / 1e6).toFixed(1)} MB`);
      expect(end.nodes, 'DOM nodes').toBe(start.nodes);
      expect(end.heap, 'JS heap after GC').toBeLessThan(start.heap * 1.1);
    });
  }
});
