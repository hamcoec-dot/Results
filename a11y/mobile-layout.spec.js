// Phone layout (2026-11-04, after the precinct cards' candidate rows overlapped on phones): every
// public page and every precinct view, at phone widths in Chromium and on the emulated Pixel 7 and
// iPhone 14 (npm run e2e:browsers), must have
//   - no text drawn over other text (each text line's boxes, compared within its card, row or group)
//   - no text past the right edge of the screen, except inside a sideways-scrolling table region
//   - no horizontal page scroll.
// The precinct page is checked with an early / Election Day split, so the extra lines are on screen.
const { test, expect } = require('./fixtures');
const fs = require('node:fs');
const path = require('node:path');

const GOLDEN = path.join(__dirname, '..', 'functions', 'test', 'golden');
const DRAFT_ID = 'abcdef0123456789abcdef0123456789';
const WIDTHS = [320, 375, 414];

/** samples-92-05-end-ed with a synthetic early split (half of every number early). */
function withSplit() {
  const p = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'samples-92-05-end-ed', 'precincts.json'), 'utf8'));
  const half = (n) => Math.floor(n / 2);
  p.earlyByPrecinct = {
    ballots: Object.fromEntries(Object.entries(p.precinctStats).map(([n, s]) => [n, half(s.ballots)])),
    contests: p.contests.map((c) => c.candidates.map((x) => Object.fromEntries(Object.entries(x.precinctVotes).map(([n, v]) => [n, half(v)])))),
  };
  return p;
}

async function openPrecincts(page) {
  const precincts = JSON.stringify(withSplit());
  await page.route('http://127.0.0.1:9199/**', (route) => {
    const name = path.basename(decodeURIComponent(new URL(route.request().url()).pathname));
    const cors = { 'access-control-allow-origin': '*' };
    if (name === 'precincts.json') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: precincts });
    const f = path.join(GOLDEN, 'samples-92-05-end-ed', name);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: fs.readFileSync(f) });
  });
  await page.goto(`precincts.html?emulator&draft=${DRAFT_ID}`);
  await page.locator('#precinct-results-container > *').first().waitFor();
}

/** Problems with the text on screen: overlaps within a group, text past the right edge, page scroll. */
function layoutProblems() {
  const GROUP = '.candidate-row, tr, .filter-tabs, .stat-card, [class*="stat-box"], .precinct-map-info, .map-legend, .contest-header, header, nav, .slide-card, article, section';
  const vw = document.documentElement.clientWidth;
  const problems = [];
  if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${window.innerWidth}px)`);
  const memo = new Map();
  const hidden = (el) => {
    if (memo.has(el)) return memo.get(el);
    const v = hiddenUncached(el);
    memo.set(el, v);
    return v;
  };
  const hiddenUncached = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true') return true;
      if (s.position === 'absolute' && (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)')) return true; // .sr-only
      if (s.position === 'fixed' || s.position === 'sticky') return true; // floating buttons, sticky columns
    }
    return false;
  };
  const scroller = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const o = getComputedStyle(e).overflowX;
      if ((o === 'auto' || o === 'scroll') && e.scrollWidth > e.clientWidth) return e;
    }
    return null;
  };
  const items = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue.trim() || hidden(n.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) continue;
    const el = n.parentElement;
    const label = n.nodeValue.trim().slice(0, 40);
    const inScroller = scroller(el);
    if (!inScroller) for (const r of rects) if (r.right > vw + 1) { problems.push(`"${label}" runs off the right edge (${Math.round(r.right)}px > ${vw}px)`); break; }
    items.push({ el, group: el.closest(GROUP), rects, label });
  }
  const byGroup = new Map();
  for (const it of items) { if (!it.group) continue; if (!byGroup.has(it.group)) byGroup.set(it.group, []); byGroup.get(it.group).push(it); }
  for (const list of byGroup.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      for (const r of a.rects) for (const s of b.rects) {
        const w = Math.min(r.right, s.right) - Math.max(r.left, s.left);
        const h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
        if (w > 3 && h > 3) { problems.push(`"${a.label}" overlaps "${b.label}"`); i = j = list.length; break; }
      }
    }
    if (problems.length > 30) break;
  }
  return problems;
}

async function check(page, what) {
  await page.waitForTimeout(150);
  const problems = await page.evaluate(layoutProblems);
  expect(problems, `${what}:\n  ${problems.slice(0, 15).join('\n  ')}`).toEqual([]);
}

/** Chromium runs each width; the phone projects (Pixel 7, iPhone 14) keep their own screen. */
function widthsFor(testInfo) {
  return testInfo.project.name === 'chromium' ? WIDTHS : [null];
}

for (const [file, ready] of [['index.html', '#contests-container article'], ['reporting.html', '#reporting-table-body tr'], ['scrolling.html', '#slide-viewport > *']]) {
  test(`phone layout: ${file}`, async ({ page }, testInfo) => {
    for (const w of widthsFor(testInfo)) {
      if (w) await page.setViewportSize({ width: w, height: 800 });
      await page.goto(file);
      await page.locator(ready).first().waitFor();
      await check(page, `${file} @ ${w || testInfo.project.name}`);
    }
  });
}

test('phone layout: precinct page, every view and every ballots choice', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  for (const w of widthsFor(testInfo)) {
    if (w) await page.setViewportSize({ width: w, height: 800 });
    await openPrecincts(page);
    const at = w || testInfo.project.name;
    for (const [view, btn] of [['By Precinct', '#view-mode-precinct-btn'], ['By Contest', '#view-mode-contest-btn'], ['Turnout', '#view-mode-turnout-btn'], ['Map', '#view-mode-map-btn']]) {
      await page.click(btn);
      if (view === 'Map') await page.locator('.precinct-map-svg path').first().waitFor();
      for (const scope of ['ALL', 'EARLY', 'ED']) {
        await page.click(`#ballot-scope-tabs [data-scope="${scope}"]`);
        await check(page, `precincts.html ${view} / ${scope} @ ${at}`);
      }
    }
    // The map's pop-up panel after picking a precinct.
    await page.locator('.precinct-map-svg path[data-map-precinct]').first().click({ force: true });
    await check(page, `precincts.html Map with a precinct picked @ ${at}`);
  }
});
