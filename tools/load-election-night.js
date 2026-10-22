'use strict';
/**
 * Election-night load test (plan: Test strategy, layer 14): many open public pages, each doing what
 * app.js does, for a fixed time while an operator publishes on the admin page.
 *
 *   node tools/load-election-night.js <bucket base URL> [--pages 2000] [--duration 600] [--poll 60]
 *       [--expect-publishes N] [--max-p95 300] [--no-bust]
 *   e.g. node tools/load-election-night.js https://storage.googleapis.com/hcec-election-results-staging-results/ \
 *          --pages 2000 --duration 900 --expect-publishes 10
 *
 * Each simulated page is index (summary.json), reporting (summary.json + reporting.json) or precincts
 * (precincts.json), in a 70/20/10 mix. It polls current/manifest.json every --poll seconds (first poll
 * spread over one interval) and, when the dataVersion changes, fetches its page files and checks each
 * carries the manifest's dataVersion, as validate.js validateSet does before anything is shown. Like
 * the pages, every request carries a ?t= cache-buster; --no-bust measures the edge cache instead.
 *
 * Reports manifest and data-file latency, errors, version mismatches (the page keeps its last data
 * and retries on the next poll), every publish seen, and how long each took to reach all pages.
 * Exits 1 on any HTTP or network error, a p95 over --max-p95 ms, or fewer new versions than
 * --expect-publishes.
 */

const MIX = [['index', 0.7, ['summary.json']], ['reporting', 0.2, ['summary.json', 'reporting.json']], ['precincts', 0.1, ['precincts.json']]];

function parseArgs(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const num = (name, dflt) => {
    const i = args.indexOf(name);
    if (i < 0) return dflt;
    const v = Number(args[i + 1]);
    args.splice(i, 2);
    if (!(v >= 0) || !Number.isFinite(v)) throw new Error(`${name} needs a number`);
    return v;
  };
  const opts = {
    bust: !flag('--no-bust'),
    pages: num('--pages', 2000),
    duration: num('--duration', 600),
    poll: num('--poll', 60),
    expectPublishes: num('--expect-publishes', 0),
    maxP95: num('--max-p95', 300),
  };
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown) throw new Error(`unknown argument ${unknown}`);
  if (args.length !== 1 || !/^https?:\/\/[^\s]+$/.test(args[0])) throw new Error('give the bucket base URL, e.g. https://storage.googleapis.com/<bucket>/');
  if (!(opts.pages >= 1 && opts.duration > 0 && opts.poll > 0)) throw new Error('--pages, --duration and --poll must be positive');
  opts.base = args[0].endsWith('/') ? args[0] : `${args[0]}/`;
  return opts;
}

/** Page kind for the i-th of n pages, so the mix is exact rather than random. */
function pageKind(i, n) {
  let edge = 0;
  for (const [kind, share, files] of MIX) {
    edge += share * n;
    if (i < Math.round(edge)) return { kind, files };
  }
  return { kind: MIX[0][0], files: MIX[0][2] };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN);

function createStats() {
  return { manifest: [], files: [], errors: new Map(), mismatches: 0, versions: new Map() };
}

/** One simulated page: poll, and on a new version fetch and check the page files. */
async function runPage({ base, bust, poll, until, files, stats, fetchImpl = fetch, now = Date.now, sleep, firstDelay = 0 }) {
  const url = (f) => `${base}current/${f}${bust ? `?t=${now()}${Math.random().toString(36).slice(2, 6)}` : ''}`;
  const timed = async (f, into) => {
    const t = performance.now();
    const res = await fetchImpl(url(f), { headers: bust ? { 'cache-control': 'no-cache' } : {} });
    const body = await res.text();
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    into.push(performance.now() - t);
    return JSON.parse(body);
  };
  let active = null;
  await sleep(firstDelay);
  while (now() < until) {
    try {
      const manifest = await timed('manifest.json', stats.manifest);
      const v = manifest.dataVersion;
      if (v && v !== active) {
        const got = await Promise.all(files.map((f) => timed(f, stats.files)));
        if (got.every((d) => d && d.metadata && d.metadata.dataVersion === v)) {
          active = v;
          // A rollback republishes an older dataVersion; its publish time tells the two apart.
          const key = `${v} (published ${manifest.updatedAt ?? '?'})`;
          const seen = stats.versions.get(key) ?? { first: now(), last: 0, pages: 0 };
          seen.last = now();
          seen.pages += 1;
          stats.versions.set(key, seen);
        } else {
          stats.mismatches += 1;
        }
      }
    } catch (e) {
      const key = e.message.replace(/\?t=\S+/, '');
      stats.errors.set(key, (stats.errors.get(key) ?? 0) + 1);
    }
    await sleep(poll * 1000);
  }
}

/** The report lines and whether the run passed. */
function summarize(stats, { pages, maxP95, expectPublishes, seconds }) {
  const m = [...stats.manifest].sort((a, b) => a - b);
  const f = [...stats.files].sort((a, b) => a - b);
  const failed = [...stats.errors.values()].reduce((a, b) => a + b, 0);
  const fmt = (s) => (s.length ? `p50 ${pct(s, 50).toFixed(0)}, p95 ${pct(s, 95).toFixed(0)}, p99 ${pct(s, 99).toFixed(0)}, max ${s[s.length - 1].toFixed(0)} ms` : 'none');
  const lines = [
    `${pages} pages for ${seconds.toFixed(0)} s: ${m.length} manifest polls (${(m.length / seconds).toFixed(1)}/s), ${f.length} data-file fetches`,
    `manifest latency: ${fmt(m)}`,
    `data-file latency: ${fmt(f)}`,
    `errors: ${failed}${failed ? ` (${[...stats.errors].map(([k, n]) => `${k} x${n}`).join(', ')})` : ''}`,
    `version mismatches (page kept its data, retried next poll): ${stats.mismatches}`,
  ];
  const versions = [...stats.versions].sort((a, b) => a[1].first - b[1].first);
  versions.forEach(([v, s], i) => {
    lines.push(`version ${v}: on ${s.pages} of ${pages} pages${i ? `, all within ${((s.last - s.first) / 1000).toFixed(0)} s of the first` : ' (already live at start)'}`);
  });
  const newVersions = Math.max(0, versions.length - 1);
  const problems = [];
  if (failed) problems.push(`${failed} error(s)`);
  const p95 = Math.max(pct(m, 95) || 0, pct(f, 95) || 0);
  if (!m.length) problems.push('no successful polls');
  else if (p95 > maxP95) problems.push(`p95 ${p95.toFixed(0)} ms > ${maxP95} ms`);
  if (newVersions < expectPublishes) problems.push(`${newVersions} new version(s) seen, expected ${expectPublishes}`);
  lines.push(problems.length ? `FAIL: ${problems.join('; ')}` : 'OK');
  return { lines, ok: problems.length === 0 };
}

async function run(opts, { fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const stats = createStats();
  const start = now();
  const until = start + opts.duration * 1000;
  await Promise.all(Array.from({ length: opts.pages }, (_, i) => runPage({
    base: opts.base, bust: opts.bust, poll: opts.poll, until, files: pageKind(i, opts.pages).files, stats, fetchImpl, now, sleep,
    firstDelay: (i / opts.pages) * opts.poll * 1000,
  })));
  return summarize(stats, { ...opts, seconds: Math.max(1, (now() - start) / 1000) });
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\nUsage: node tools/load-election-night.js <bucket base URL> [--pages N] [--duration s] [--poll s] [--expect-publishes N] [--max-p95 ms] [--no-bust]`);
    process.exit(2);
  }
  console.log(`${opts.pages} pages polling ${opts.base}current/manifest.json every ${opts.poll} s for ${opts.duration} s${opts.bust ? '' : ' (no cache-buster)'}`);
  run(opts).then(({ lines, ok }) => {
    lines.forEach((l) => console.log(l));
    if (!ok) process.exitCode = 1;
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, pageKind, runPage, summarize, run, createStats };
