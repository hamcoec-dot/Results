/**
 * Where the public pages read their data (plan: Front-end changes › results-config.js).
 *
 *   default      PUBLIC_BASE when set (the public bucket's current/), otherwise ./ (the files
 *                next to the pages, as the legacy monitor writes them). PUBLIC_BASE stays null until
 *                Phase 5 creates the bucket, so merging this before then changes nothing live.
 *   ?local       ./ always (the offline fallback with Run_Monitor.bat)
 *   ?emulator    the Storage emulator's results bucket (localhost only)
 *   ?draft=<id>  a draft's files, for the review screen: red DRAFT banner, no auto-refresh,
 *                [DRAFT] title prefix, DRAFT_ export file names. Only a 32-hex id is accepted.
 */
(function () {
  'use strict';

  // PHASE 5: 'https://storage.googleapis.com/hcec-election-results-results/'
  var PUBLIC_BASE = null;
  var EMULATOR_BUCKET = 'demo-hcec-results';

  var params = new URLSearchParams(location.search);
  var localHost = ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;
  var emulator = localHost && params.has('emulator');
  var draft = /^[0-9a-f]{32}$/.test(params.get('draft') || '') ? params.get('draft') : null;
  var local = params.has('local') || (!emulator && !PUBLIC_BASE);

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
    return (PUBLIC_BASE || './') + objectPath(file) + (bust ? '?t=' + Date.now() : '');
  }

  window.RESULTS = {
    url: url,
    draft: draft,
    local: local && !draft,
    /** Poll manifest.json for changes (only where publishDraft writes one). */
    usesManifest: !draft && !(local && !draft),
  };

  if (!draft) return;
  document.title = '[DRAFT] ' + document.title;
  var showBanner = function () {
    var b = document.createElement('div');
    b.className = 'draft-banner';
    b.setAttribute('role', 'note');
    b.textContent = 'DRAFT — NOT PUBLIC — ' + draft.slice(0, 8) + '…';
    document.body.insertBefore(b, document.body.firstChild);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner);
  else showBanner();
}());
