'use strict';
/**
 * Election-night load sanity (plan: Verification › Production load sanity): many concurrent
 * manifest.json fetches, as thousands of open pages polling every 60 s would make.
 *
 *   node tools/load-manifest.js <url> [--requests 1000] [--concurrency 100] [--max-p95 300]
 *   e.g. node tools/load-manifest.js https://storage.googleapis.com/hcec-election-results-results/current/manifest.json
 *
 * Reports latency percentiles, errors and whether the CDN served the responses (Age, Cache-Control).
 * Exits 1 when any request fails or the p95 is over --max-p95 ms. No cache-buster is added, so the
 * edge cache is what gets measured, as for real visitors between polls.
 */
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args.splice(i, 2)[1]) : dflt; };
const total = opt('--requests', 1000);
const concurrency = opt('--concurrency', 100);
const maxP95 = opt('--max-p95', 300);
const url = args[0];
if (!url || !/^https?:\/\//.test(url) || !(total > 0) || !(concurrency > 0)) {
  console.error('Usage: node tools/load-manifest.js <url> [--requests N] [--concurrency N] [--max-p95 ms]');
  process.exit(2);
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

async function main() {
  const times = [];
  const errors = new Map();
  let withAge = 0;
  let cacheControl = null;
  let next = 0;
  const worker = async () => {
    while (next < total) {
      next += 1;
      const t = performance.now();
      try {
        const res = await fetch(url);
        await res.arrayBuffer();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        times.push(performance.now() - t);
        if (res.headers.get('age') !== null) withAge += 1;
        cacheControl ??= res.headers.get('cache-control');
      } catch (e) {
        errors.set(e.message, (errors.get(e.message) ?? 0) + 1);
      }
    }
  };
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const seconds = (performance.now() - start) / 1000;

  const sorted = times.sort((a, b) => a - b);
  const failed = [...errors.values()].reduce((a, b) => a + b, 0);
  console.log(`${total} requests, ${concurrency} at a time, ${seconds.toFixed(1)} s (${(total / seconds).toFixed(0)}/s)`);
  if (sorted.length) {
    console.log(`latency ms: p50 ${pct(sorted, 50).toFixed(0)}, p95 ${pct(sorted, 95).toFixed(0)}, p99 ${pct(sorted, 99).toFixed(0)}, max ${sorted[sorted.length - 1].toFixed(0)}`);
  }
  console.log(`errors: ${failed}${failed ? ` (${[...errors].map(([m, n]) => `${m} x${n}`).join(', ')})` : ''}`);
  console.log(`CDN: Age header on ${withAge} of ${sorted.length} responses; Cache-Control: ${cacheControl ?? 'none'}`);
  const p95 = sorted.length ? pct(sorted, 95) : Infinity;
  if (failed || p95 > maxP95) {
    console.log(`FAIL: ${failed ? `${failed} error(s)` : ''}${failed && p95 > maxP95 ? '; ' : ''}${p95 > maxP95 ? `p95 ${p95.toFixed(0)} ms > ${maxP95} ms` : ''}`);
    process.exitCode = 1;
  } else {
    console.log('OK');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
