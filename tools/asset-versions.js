#!/usr/bin/env node
/**
 * Cache busting for the pages' own scripts and stylesheets.
 *
 * Browsers (and Cloudflare in front of govotehamiltontn.gov) keep app.js, styles.css and the rest
 * for longer than GitHub Pages asks, so a fixed page can still run yesterday's code for hours. Each
 * local <script src> and stylesheet <link href> in the pages carries ?v=<first 10 hex of the file's
 * sha256>: a changed file gets a new URL, which no cache has, and an unchanged one keeps its cache.
 *
 *   node tools/asset-versions.js          rewrite the ?v= values in the pages
 *   node tools/asset-versions.js --check  fail if any page is out of date (CI)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PAGES = ['index.html', 'reporting.html', 'precincts.html', 'scrolling.html', 'admin.html', 'review.html'];
// src="..." or href="..." pointing at a local .js/.css file, with or without an existing ?v=
const REF = /\b(src|href)="(\.\/)?([\w./-]+\.(?:js|css))(?:\?v=[0-9a-f]*)?"/g;

const check = process.argv.includes('--check');
const hashes = new Map();
function version(file) {
  if (!hashes.has(file)) {
    hashes.set(file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex').slice(0, 10));
  }
  return hashes.get(file);
}

const stale = [];
for (const page of PAGES) {
  const before = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const after = before.replace(REF, (all, attr, dot, file) => {
    if (!fs.existsSync(path.join(ROOT, file))) return all;
    return `${attr}="${dot || ''}${file}?v=${version(file)}"`;
  });
  if (after === before) continue;
  stale.push(page);
  if (!check) fs.writeFileSync(path.join(ROOT, page), after);
}

if (check && stale.length) {
  console.error(`Out-of-date ?v= asset versions in: ${stale.join(', ')}.\nRun: node tools/asset-versions.js, then commit the pages.`);
  process.exit(1);
}
console.log(stale.length ? `${check ? 'Stale' : 'Updated'}: ${stale.join(', ')}` : 'Asset versions are up to date.');
