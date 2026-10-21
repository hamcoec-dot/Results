'use strict';
/**
 * Smoke test of what the public is served (plan: layer 15 staging smoke; Verification › after deploy).
 * Fetches current/manifest.json and every published file from the public bucket the way a browser
 * on the Pages site does, and checks:
 *   - each file's bytes match the manifest's sha256, and the set passes validate.js (auditServed);
 *   - the manifest a page polls is at most 1 KB;
 *   - Cache-Control is the live policy (public, max-age=15) and the JSON is stored gzip-encoded;
 *   - CORS answers the Pages origin;
 *   - the bucket cannot be listed (draft URLs stay unguessable).
 *
 * Usage:
 *   node tools/smoke-public.js <bucket>                      e.g. hcec-election-results-staging-results
 *   node tools/smoke-public.js <bucket> --origin https://govotehamiltontn.gov
 *   node tools/smoke-public.js demo-hcec-results --emulator  the Storage emulator on 127.0.0.1:9199: content
 *                                                            checks only (it has no IAM, CDN or CORS policy)
 * Exits 1 and lists the problems if any check fails.
 */
const path = require('node:path');
const { auditServed } = require(path.join(__dirname, '..', 'functions', 'src', 'audit'));
const { PAGE_FILES, SUMMARY_FILE, MANIFEST_FILE, LIVE } = require(path.join(__dirname, '..', 'functions', 'src', 'publish'));

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1).length > 0 : false; };
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const emulator = flag('--emulator');
const origin = opt('--origin', 'https://govotehamiltontn.gov');
const bucket = args[0];
if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,220}$/.test(bucket)) {
  console.error('Usage: node tools/smoke-public.js <bucket> [--origin URL] [--emulator]');
  process.exit(2);
}

const objectUrl = (object) => (emulator
  ? `http://127.0.0.1:9199/download/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}?alt=media&t=${Date.now()}`
  : `https://storage.googleapis.com/${bucket}/${object}?t=${Date.now()}`);

async function get(object) {
  const res = await fetch(objectUrl(object), { headers: { Origin: origin, 'Accept-Encoding': 'gzip' } });
  return { status: res.status, headers: res.headers, text: res.ok ? await res.text() : null };
}

/** Header checks for one served file (bucket mode only). */
function headerProblems(file, headers) {
  const out = [];
  const cc = headers.get('cache-control');
  if (cc !== LIVE) out.push(`${file}: Cache-Control is "${cc}", expected "${LIVE}"`);
  // fetch decodes gzip itself; GCS reports how the object is stored in x-goog-stored-content-encoding.
  const stored = headers.get('x-goog-stored-content-encoding') || headers.get('content-encoding');
  if (file.endsWith('.json') && stored !== 'gzip') out.push(`${file}: stored without gzip (${stored || 'identity'})`);
  const acao = headers.get('access-control-allow-origin');
  if (acao !== origin && acao !== '*') out.push(`${file}: CORS does not allow ${origin} (Access-Control-Allow-Origin: ${acao || 'none'})`);
  return out;
}

async function main() {
  const problems = [];
  const notes = [];
  const files = [...PAGE_FILES, SUMMARY_FILE];
  const results = Object.fromEntries(await Promise.all([MANIFEST_FILE, ...files].map(async (f) => [f, await get(`current/${f}`)])));

  for (const [f, r] of Object.entries(results)) {
    if (r.status !== 200) problems.push(`${f}: HTTP ${r.status}`);
    else if (!emulator) problems.push(...headerProblems(f, r.headers));
  }

  const manifestText = results[MANIFEST_FILE].text;
  if (manifestText !== null) {
    let manifest = null;
    try { manifest = JSON.parse(manifestText); } catch { /* auditServed reports it */ }
    const bytes = Buffer.byteLength(manifestText);
    if (bytes > 1024) problems.push(`manifest.json is ${bytes} bytes; a poll should cost at most 1 KB`);
    const audit = auditServed({
      manifestText,
      files: Object.fromEntries(files.map((f) => [f, results[f].text ?? undefined])),
      expectedVersion: manifest?.dataVersion,
    });
    problems.push(...audit.problems);
    notes.push(`dataVersion ${manifest?.dataVersion}, published ${manifest?.updatedAt}, manifest ${bytes} bytes`);
  }

  if (!emulator) {
    const list = await fetch(`https://storage.googleapis.com/${bucket}?prefix=drafts/`);
    if (list.status !== 403 && list.status !== 401) problems.push(`listing the bucket returned HTTP ${list.status}; it must be denied`);
    else notes.push(`bucket listing denied (HTTP ${list.status})`);
  }

  for (const n of notes) console.log(`  ${n}`);
  if (problems.length) {
    console.log(`FAIL: ${problems.length} problem(s)`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${bucket} serves the published files${emulator ? ' (emulator: content checks only)' : ''}.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
