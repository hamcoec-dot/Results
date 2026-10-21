// npm run perf: Lighthouse on the public pages with the plan's reference profile (mobile, 4x CPU
// slowdown, Slow 4G: Lighthouse's default mobile settings), checked against the release budgets.
//
//   node perf/lighthouse.mjs [dir] [--runs N] [--json out.json]
//
// dir defaults to the repo root and is served on a free local port; pages read ./ data there, as
// the live site does until Phase 5. Each page is run N times (default 3) and the median is kept.
// Exits 1 when a budget is missed. Needs a Chrome or Chromium (CHROME_PATH, or the installed one).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'reporting.html', 'precincts.html', 'scrolling.html'];
const OWN_JS = ['app.js', 'results-config.js', 'functions/src/validate.js'];
const BUDGET = { lcp: 2500, tbt: 200, cls: 0.1, jsKb: 60 };

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const runs = Number(opt('--runs', 3));
const jsonOut = opt('--json', null);
const dir = path.resolve(args[0] || ROOT) + path.sep;

// A static server that gzips text like GitHub Pages and GCS (gzip transcoding) do, so transfer
// sizes and timings match production rather than an uncompressed local server.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serve(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    let body = fs.readFileSync(file);
    const headers = { 'content-type': type, 'cache-control': 'no-store' };
    if (!type.startsWith('image/png') && /gzip/.test(req.headers['accept-encoding'] || '')) {
      body = zlib.gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, close: () => server.close() })));
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const server = await serve(dir);
const base = `http://127.0.0.1:${server.server.address().port}/`;
const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] });
const results = [];
try {
  for (const page of PAGES) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      const { lhr } = await lighthouse(base + page, { port: chrome.port, onlyCategories: ['performance'], logLevel: 'error' });
      const a = lhr.audits;
      samples.push({
        score: Math.round(lhr.categories.performance.score * 100),
        fcp: a['first-contentful-paint'].numericValue,
        lcp: a['largest-contentful-paint'].numericValue,
        tbt: a['total-blocking-time'].numericValue,
        cls: a['cumulative-layout-shift'].numericValue,
        bytes: a['total-byte-weight'].numericValue,
      });
    }
    const m = (k) => median(samples.map((s) => s[k]));
    results.push({ page, score: m('score'), fcp: m('fcp'), lcp: m('lcp'), tbt: m('tbt'), cls: m('cls'), kb: m('bytes') / 1024 });
  }
} finally {
  await chrome.kill();
  server.close();
}

const ownJs = OWN_JS.filter((f) => fs.existsSync(path.join(dir, f)));
const jsKb = ownJs.reduce((n, f) => n + zlib.gzipSync(fs.readFileSync(path.join(dir, f))).length, 0) / 1024;

console.log(`Lighthouse mobile (4x CPU, Slow 4G), median of ${runs}, ${dir}`);
console.log('| Page | Score | FCP | LCP | TBT | CLS | Transfer |');
console.log('|---|---|---|---|---|---|---|');
const misses = [];
for (const r of results) {
  console.log(`| ${r.page} | ${r.score} | ${(r.fcp / 1000).toFixed(2)} s | ${(r.lcp / 1000).toFixed(2)} s | ${Math.round(r.tbt)} ms | ${r.cls.toFixed(3)} | ${Math.round(r.kb)} KB |`);
  if (r.lcp >= BUDGET.lcp) misses.push(`${r.page}: LCP ${(r.lcp / 1000).toFixed(2)} s >= 2.5 s`);
  if (r.tbt >= BUDGET.tbt) misses.push(`${r.page}: TBT ${Math.round(r.tbt)} ms >= 200 ms`);
  if (r.cls >= BUDGET.cls) misses.push(`${r.page}: CLS ${r.cls.toFixed(3)} >= 0.1`);
}
console.log(`Own JS (gzip): ${jsKb.toFixed(1)} KB (${ownJs.join(', ')})`);
if (jsKb > BUDGET.jsKb) misses.push(`own JS ${jsKb.toFixed(1)} KB > 60 KB`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ dir, runs, results, jsKb }, null, 2));
if (misses.length) {
  console.log(`\nBudget misses:\n  ${misses.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('\nAll budgets met.');
}
