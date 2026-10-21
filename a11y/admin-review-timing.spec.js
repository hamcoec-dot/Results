// Review screen responsiveness (plan: Performance › budgets): each filter change, search keystroke
// and warning tick responds in < 100 ms at 4× CPU slowdown. Measured with the Event Timing API (the
// INP measure: input to the next paint) on a real review of the largest sample. Needs the emulators
// (npm run a11y:admin); timing depends on the machine, so it runs only with PERF=1 and reports,
// and STRICT=1 also fails on a miss. Results are recorded in perf/BASELINE.md.
const { test, expect } = require('@playwright/test');
const path = require('node:path');

const ADMIN = { email: 'admin@example.test', password: 'emulator-only-pw' };
const SAMPLE = path.join(__dirname, '..', 'Test_Files', 'Web Results Samples', '05-End of Election Day (92).csv');
const emulators = !!(process.env.EMULATORS || process.env.FIREBASE_EMULATOR_HUB);
const BUDGET_MS = 100;

test.describe('review screen interactions at 4x CPU', () => {
  test.skip(!emulators || !process.env.PERF, 'timing test on the emulators: PERF=1 npm run a11y:admin');
  test.setTimeout(240000);

  test('filters, search keystrokes and warning ticks each respond in < 100 ms', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 823 });
    await page.goto('admin.html?emulator');
    await page.waitForFunction(() => !document.getElementById('signin').hidden || !document.getElementById('app').hidden, null, { timeout: 15000 });
    if (await page.locator('#signin').isVisible()) {
      await page.fill('#email', ADMIN.email);
      await page.fill('#password', ADMIN.password);
      await page.click('#signin-form button[type="submit"]');
    }
    await expect(page.locator('#upload-form')).toBeVisible({ timeout: 15000 });
    await page.check('#k-ed');
    await page.setInputFiles('#u-file', SAMPLE);
    await page.click('#upload-form button[type="submit"]');
    await page.waitForURL(/review\.html\?/, { timeout: 120000 });
    await expect(page.locator('#checks')).not.toBeEmpty({ timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('contests').getAttribute('aria-busy') !== 'true', null, { timeout: 30000 }); // cards rendered: nothing moves now
    await expect(page.locator('#contests')).not.toBeEmpty();
    await page.waitForTimeout(500);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.evaluate(() => {
      window.__events = [];
      new PerformanceObserver((list) => list.getEntries().forEach((e) => {
        if (e.interactionId) window.__events.push({ name: e.name, id: e.interactionId, ms: Math.round(e.duration) });
      })).observe({ type: 'event', durationThreshold: 16, buffered: true });
    });
    const measure = async (label, act) => {
      await page.evaluate(() => { window.__events.length = 0; });
      await act();
      await page.waitForTimeout(400); // entries are reported after the next paint
      const worst = await page.evaluate(() => window.__events.reduce((m, e) => Math.max(m, e.ms), 0));
      return { label, worst };
    };

    const results = [];
    // Real key presses on the closed select (selectOption is not user input, so Event Timing skips it).
    await page.focus('#contest-filter');
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowUp']) {
      const before = await page.inputValue('#contest-filter');
      const r = await measure(`filter ${key}`, () => page.keyboard.press(key));
      r.label += `: ${before} → ${await page.inputValue('#contest-filter')}`;
      results.push(r);
    }
    expect(results.filter((r) => /→ all$/.test(r.label)).length, 'the keys reached "All contests"').toBeGreaterThan(0);
    await page.click('#contest-search');
    for (const ch of 'governor') {
      results.push(await measure(`search keystroke "${ch}"`, () => page.keyboard.type(ch)));
    }
    await page.fill('#contest-search', '');
    const boxes = await page.locator('#checks input[type="checkbox"]').all();
    for (const [i, box] of boxes.slice(0, 15).entries()) {
      results.push(await measure(`warning tick ${i + 1}`, () => box.check()));
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

    const worst = Math.max(...results.map((r) => r.worst));
    const report = results.map((r) => `${r.label}: ${r.worst} ms`).join('\n');
    console.log(`Review interactions at 4x CPU (Event Timing; 0 = under 16 ms):\n${report}\nworst: ${worst} ms`);
    test.info().annotations.push({ type: 'worst interaction (ms)', description: String(worst) });
    expect(results.length).toBeGreaterThan(20);
    if (process.env.STRICT) expect(results.filter((r) => r.worst >= BUDGET_MS)).toEqual([]);
  });
});
