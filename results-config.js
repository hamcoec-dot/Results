/**
 * Where the public pages read their data (plan: Front-end changes › results-config.js).
 *
 *   default      PUBLIC_BASE: the production public bucket's current/, polled through its
 *                manifest.json. Strict: data that fails validate.js is never shown.
 *   ?local       ./ always (the offline fallback with Run_Monitor.bat: the files next to the pages,
 *                as the legacy monitor writes them). Lenient, no manifest. A page opened from disk
 *                (file://) is always local too: there is no origin the bucket's CORS would allow.
 *   ?emulator    the Storage emulator's results bucket (localhost only)
 *   ?staging     the staging project's public bucket (current/ or a draft), for rehearsals
 *   ?draft=<id>  a draft's files, for the review screen: red DRAFT banner, no auto-refresh,
 *                [DRAFT] title prefix, DRAFT_ export file names. Only a 32-hex id is accepted.
 *                Drafts are always read from the bucket (they never exist next to the pages).
 *   ?election=<id>  an election's official archive (archive/<id>/, docs/ARCHIVE.md): OFFICIAL
 *                banner with the certification date, no auto-refresh, and the links between the
 *                pages keep ?election=, so each archived page can be linked to directly.
 *                archive.html lists every archive.
 *
 * Rollback: PUBLIC_BASE = null makes the default read ./ again (as before the Phase 5 switch-over).
 */
(function () {
  'use strict';

  var PROD_BUCKET_BASE = 'https://storage.googleapis.com/hcec-election-results-results/';
  // The default data source (null: ./, the pre-switch-over behaviour).
  var PUBLIC_BASE = PROD_BUCKET_BASE;
  var STAGING_BUCKET_BASE = 'https://storage.googleapis.com/hcec-election-results-staging-results/';
  var EMULATOR_BUCKET = 'demo-hcec-results';

  var params = new URLSearchParams(location.search);
  var localHost = ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;
  var emulator = localHost && params.has('emulator');
  var draft = /^[0-9a-f]{32}$/.test(params.get('draft') || '') ? params.get('draft') : null;
  var staging = !emulator && params.has('staging');
  var ELECTION_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
  var archive = !draft && ELECTION_RE.test(params.get('election') || '') ? params.get('election') : null;
  var fromDisk = location.protocol === 'file:';
  var local = !staging && !archive && (params.has('local') || fromDisk || (!emulator && !PUBLIC_BASE));

  /** Object path (in the bucket) for a data file. */
  function objectPath(file) { return (draft ? 'drafts/' + draft + '/' : archive ? 'archive/' + archive + '/' : 'current/') + file; }

  /** URL of any object in the public bucket (archive/index.json for archive.html). */
  function bucketUrl(object, opts) {
    var bust = opts && opts.bust;
    if (emulator) {
      return 'http://127.0.0.1:9199/download/storage/v1/b/' + EMULATOR_BUCKET + '/o/' + encodeURIComponent(object) + '?alt=media' + (bust ? '&t=' + Date.now() : '');
    }
    return (staging ? STAGING_BUCKET_BASE : (PUBLIC_BASE || PROD_BUCKET_BASE)) + object + (bust ? '?t=' + Date.now() : '');
  }

  /** The emulator / staging switch, to carry onto links (with a trailing &, or ''). */
  var carry = emulator ? 'emulator&' : staging ? 'staging&' : '';

  /**
   * URL of a data file. Local files get a cache-buster (no CDN); bucket files are cached for at
   * most 15 s at the edge, and the cheap manifest poll decides when to fetch them.
   */
  function url(file, opts) {
    var bust = opts && opts.bust;
    if (local && !draft) return './' + file + '?t=' + Date.now();
    if (emulator) return bucketUrl(objectPath(file), opts);
    var base = staging ? STAGING_BUCKET_BASE : draft || archive ? (PUBLIC_BASE || PROD_BUCKET_BASE) : (PUBLIC_BASE || './');
    return base + objectPath(file) + (bust ? '?t=' + Date.now() : '');
  }

  window.RESULTS = {
    url: url,
    draft: draft,
    /** The archived election shown (?election=), or null for the live results. */
    archive: archive,
    local: local && !draft,
    bucketUrl: bucketUrl,
    carry: carry,
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

  if (archive) markArchive();

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

  /**
   * An archive's pages: "Official" in the title and in the page text marked data-archive-text, and
   * every link to another results page keeps ?election= (and the staging / emulator switch), so the
   * archive reads as its own set of pages. The banner with the certification date is app.js's
   * (it needs the data).
   */
  function markArchive() {
    var PAGES = /^(index|reporting|precincts|scrolling)\.html$/;
    var query = '?' + carry + 'election=' + encodeURIComponent(archive);
    document.title = 'Official Results | ' + document.title;
    function fixLink(a) {
      var href = a.getAttribute('href');
      if (!href || !PAGES.test(href)) return;
      a.setAttribute('href', href + query);
    }
    function apply() {
      // Election-night notices ("about 3 hours after polls close") do not apply to certified results.
      document.body.classList.add('archive-view');
      Array.prototype.forEach.call(document.querySelectorAll('[data-archive-text]'), function (el) {
        el.textContent = el.getAttribute('data-archive-text');
      });
      Array.prototype.forEach.call(document.querySelectorAll('a[href]'), fixLink);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
    else apply();
    // Links app.js draws later ("Return to Summary Results") are fixed as they are followed.
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (a) fixLink(a);
    }, true);
  }
}());
