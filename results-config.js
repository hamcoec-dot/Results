/**
 * Where the public pages read their data (plan: Front-end changes › results-config.js).
 *
 *   default      PUBLIC_BASE when set (the public bucket's current/), otherwise ./ (the files
 *                next to the pages, as the legacy monitor writes them). PUBLIC_BASE stays null until
 *                Phase 5 creates the bucket, so merging this before then changes nothing live.
 *   ?local       ./ always (the offline fallback with Run_Monitor.bat)
 *   ?emulator    the Storage emulator's results bucket (localhost only)
 *   ?staging     the staging project's public bucket (current/ or a draft), for rehearsals
 *   ?draft=<id>  a draft's files, for the review screen: red DRAFT banner, no auto-refresh,
 *                [DRAFT] title prefix, DRAFT_ export file names. Only a 32-hex id is accepted.
 *                Drafts are always read from the bucket (they never exist next to the pages),
 *                so the review previews work before PUBLIC_BASE is set.
 */
(function () {
  'use strict';

  // PHASE 5: 'https://storage.googleapis.com/hcec-election-results-results/'
  var PUBLIC_BASE = null;
  var PROD_BUCKET_BASE = 'https://storage.googleapis.com/hcec-election-results-results/';
  var STAGING_BUCKET_BASE = 'https://storage.googleapis.com/hcec-election-results-staging-results/';
  var EMULATOR_BUCKET = 'demo-hcec-results';

  var params = new URLSearchParams(location.search);
  var localHost = ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;
  var emulator = localHost && params.has('emulator');
  var draft = /^[0-9a-f]{32}$/.test(params.get('draft') || '') ? params.get('draft') : null;
  var staging = !emulator && params.has('staging');
  var local = !staging && (params.has('local') || (!emulator && !PUBLIC_BASE));

  /** Object path (in the bucket) for a data file. */
  function objectPath(file) { return (draft ? 'drafts/' + draft + '/' : 'current/') + file; }

  /**
   * URL of a data file. Local files get a cache-buster (no CDN); bucket files are cached for at
   * most 15 s at the edge, and the cheap manifest poll decides when to fetch them.
   */
  function url(file, opts) {
    var bust = opts && opts.bust;
    if (local && !draft) return './' + file + '?t=' + Date.now();
    if (emulator) {
      return 'http://127.0.0.1:9199/download/storage/v1/b/' + EMULATOR_BUCKET + '/o/' + encodeURIComponent(objectPath(file)) + '?alt=media' + (bust ? '&t=' + Date.now() : '');
    }
    var base = staging ? STAGING_BUCKET_BASE : draft ? (PUBLIC_BASE || PROD_BUCKET_BASE) : (PUBLIC_BASE || './');
    return base + objectPath(file) + (bust ? '?t=' + Date.now() : '');
  }

  window.RESULTS = {
    url: url,
    draft: draft,
    local: local && !draft,
    /** Poll manifest.json for changes (only where publishDraft writes one). */
    usesManifest: !draft && !(local && !draft),
    /** A fetch this script started early for `file` (see data-files below), handed out once. */
    takeEarly: function (file) {
      var p = early[file] || null;
      delete early[file];
      return p;
    },
  };

  // <script src="results-config.js" data-files="summary.json"> in <head> starts the page's data
  // requests (and the manifest's) before app.js has even downloaded, for a faster first paint.
  var early = {};
  var script = document.currentScript;
  var files = ((script && script.getAttribute('data-files')) || '').split(/\s+/).filter(Boolean);
  if (files.length && window.fetch) {
    if (window.RESULTS.usesManifest) files.unshift('manifest.json');
    files.forEach(function (f) {
      early[f] = fetch(url(f, { bust: true }), { cache: 'no-store' });
      early[f].catch(function () { /* app.js reports it when it takes the request */ });
    });
  }

  // Staging serves realistic test numbers from the official domain, so it is marked like a draft.
  if (!draft && !staging) return;
  var label = staging ? 'STAGING — TEST DATA, NOT REAL RESULTS' + (draft ? ' — DRAFT ' + draft.slice(0, 8) + '…' : '')
    : 'DRAFT — NOT PUBLIC — ' + draft.slice(0, 8) + '…';
  document.title = (staging ? '[TEST] ' : '[DRAFT] ') + document.title;
  var showBanner = function () {
    var b = document.createElement('div');
    b.className = 'draft-banner';
    b.setAttribute('role', 'note');
    b.textContent = label;
    document.body.insertBefore(b, document.body.firstChild);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner);
  else showBanner();
}());
