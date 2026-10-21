/**
 * review.html: everything a reviewer needs before publishing a draft, and the only Publish button.
 * Reads the draft's Firestore doc (status, checks, expiry) and its review.json / trace.json from the
 * public bucket. Publish is enabled only when: no blocking checks, every warning ticked, every
 * public page opened, the draft is ready and not expired. The typed count is checked again by the server.
 */
(function () {
  'use strict';

  var C = window.AdminCommon;
  var h = C.h;
  var eid = C.param('e');
  var draftId = C.param('draft');
  var VALID = /^[0-9a-f]{32}$/.test(draftId || '') && /^[a-z0-9][a-z0-9-]{0,62}$/.test(eid || '');
  var S = {}; // draft, review, election, acked, viewed, contests
  var store = {
    get: function (k) { try { return JSON.parse(sessionStorage.getItem(k + ':' + draftId)) || []; } catch (e) { return []; } },
    set: function (k, v) { try { sessionStorage.setItem(k + ':' + draftId, JSON.stringify(v)); } catch (e) { /* private mode: in memory only */ } },
  };

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('back-admin').href = 'admin.html' + (C.cfg.emulator ? '?emulator' : '');
    if (!VALID) { C.announce('This review link is not valid. Open the draft from Election admin.', { alert: true }); return; }
    document.title = 'Review draft ' + draftId.slice(0, 8) + '… – Election Admin';
    C.gate(load);
  });

  function load() {
    var db = firebase.firestore();
    C.announce('Loading draft…');
    Promise.all([
      db.doc('elections/' + eid).get(),
      db.doc('elections/' + eid + '/drafts/' + draftId).get(),
      fetch(C.cfg.publicUrl('drafts/' + draftId + '/review.json'), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }, function () { return null; }),
    ]).then(function (res) {
      if (!res[1].exists) { C.announce('No such draft. It may have been discarded.', { alert: true }); return; }
      S.election = res[0].data() || {};
      S.draft = res[1].data();
      S.review = res[2];
      S.acked = new Set(store.get('acked'));
      S.viewed = new Set(store.get('viewed'));
      renderStatusBar();
      renderChecks();
      if (S.review) {
        renderHeadline();
        renderFile();
        renderPreviews();
        renderPrecincts();
        renderContests(); // chunked; resolves later
      } else {
        ['headline', 'file-identity', 'previews', 'contests', 'precincts'].forEach(function (id) {
          C.clear(document.getElementById(id)).appendChild(h('p', null, 'No files: this upload could not be read (see Checks).'));
        });
      }
      updatePublish();
      // load() runs again when the reviewer signs out and back in. Bind once: the named handlers
      // would be deduplicated anyway, but the search/filter closures and the countdown would pile up.
      if (!S.bound) {
        S.bound = true;
        startCountdown();
        document.getElementById('publish-btn').addEventListener('click', openPublish);
        document.getElementById('publish-form').addEventListener('submit', submitPublish);
        document.getElementById('extend-btn').addEventListener('click', extend);
        document.getElementById('discard-btn').addEventListener('click', discard);
        var timer;
        document.getElementById('contest-search').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(applyFilter, 150); });
        document.getElementById('contest-filter').addEventListener('change', applyFilter);
      }
      C.announce('Draft loaded.');
    }, function (e) { C.announce('Could not load the draft: ' + C.errorText(e), { alert: true }); });
  }

  // ---------- status bar & expiry (WCAG 2.2.1) ----------

  var countdownText;
  var warned = {};
  function renderStatusBar() {
    var d = S.draft;
    var counts = { block: 0, warn: 0, info: 0 };
    d.checks.forEach(function (c) { counts[c.severity]++; });
    countdownText = h('span', { 'aria-live': 'off' });
    C.clear(document.getElementById('status-bar')).appendChild(h('p', { class: 'row' },
      h('span', null, 'Draft ', h('code', null, draftId.slice(0, 8) + '…')),
      h('span', null, '· ' + (d.kind === 'rollback' ? 'Rollback to ' + d.rollbackOf : 'Kind: ' + d.kind)),
      h('span', null, '· Based on ' + (d.baseVersion || 'nothing published')),
      h('span', null, '· ' + counts.block + ' blocking, ' + counts.warn + ' warnings, ' + counts.info + ' info'),
      h('span', null, '· Status: ' + d.status),
      h('span', null, '· ', countdownText)));
  }

  function startCountdown() {
    var tick = function () {
      if (document.hidden) return;
      var left = S.draft.expiresAt - Date.now();
      if (left <= 0) {
        countdownText.textContent = 'Expired — extend it to publish';
        if (!warned.expired) { warned.expired = true; note('The draft has expired. Use "Extend draft 2 hours" to keep reviewing.'); updatePublish(); }
        return;
      }
      var m = Math.floor(left / 60000);
      countdownText.textContent = 'Expires in ' + (m >= 60 ? Math.floor(m / 60) + ' h ' : '') + (m % 60) + ' min';
      if (m < 10 && !warned.ten) { warned.ten = true; note('10 minutes left on this draft. Use "Extend draft 2 hours" if you need more time.'); }
      if (m < 2 && !warned.two) { warned.two = true; note('2 minutes left on this draft.'); }
    };
    tick();
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
  }
  function note(msg) { document.getElementById('expiry-note').textContent = msg; }

  // ---------- checks ----------

  var SEV = { block: ['⛔', 'BLOCKED'], warn: ['⚠', 'WARNING'], info: ['ℹ', 'INFO'] };
  function renderChecks() {
    var el = C.clear(document.getElementById('checks'));
    var checks = S.draft.checks;
    if (!checks.length) { el.appendChild(h('p', null, 'No checks raised anything.')); return; }
    el.appendChild(h('ul', { class: 'checks' }, checks.map(function (c) {
      var sev = h('span', { class: 'sev sev-' + c.severity }, h('span', { 'aria-hidden': 'true' }, SEV[c.severity][0] + ' '), SEV[c.severity][1]);
      var body = [h('h3', null, sev, ' ', c.title), h('p', { class: 'check-detail' }, c.detail)];
      var refs = (c.refs || []).filter(function (r) { return r.contest; }).slice(0, 5);
      if (refs.length) {
        body.push(h('p', { class: 'row' }, refs.map(function (r) {
          return h('a', { href: '#', class: 'btn', on: { click: function (ev) { ev.preventDefault(); showContest(r.contest); } } }, 'Show me: ' + r.contest);
        })));
      }
      if (c.severity === 'warn') {
        var id = 'ack-' + c.key.replace(/[^a-z0-9-]/g, '-');
        var box = h('input', { type: 'checkbox', id: id });
        box.checked = S.acked.has(c.key);
        box.addEventListener('change', function () {
          if (box.checked) S.acked.add(c.key); else S.acked.delete(c.key);
          store.set('acked', Array.from(S.acked));
          updatePublish();
        });
        body.push(h('label', { class: 'choice', for: id }, box, 'I have checked this warning'));
      }
      return h('li', { class: 'check check-' + c.severity }, body);
    })));
  }

  // ---------- headline & file ----------

  function renderHeadline() {
    var hl = S.review.headline;
    var dl = C.clear(document.getElementById('headline'));
    var item = function (label, v, fmt, extra) {
      dl.appendChild(h('div', null, h('dt', null, label),
        h('dd', null, (v.current === null ? '—' : fmt(v.current)) + ' → ' + fmt(v.draft) + (extra || '') + ' (' + C.delta(v.delta) + ')')));
    };
    item('Precincts reporting', hl.precinctsReporting, C.num, ' of ' + hl.precinctsReporting.of + ' (max ' + hl.precinctsReporting.max + ')');
    item('Registered voters', hl.registeredVoters, C.num);
    item('Ballots cast', hl.ballotsCast, C.num);
    item('Turnout', hl.turnoutPercent, C.pct);
  }

  function renderFile() {
    var r = S.review;
    var f = r.file;
    var rows = [
      ['File', f.filename], ['Kind', f.kind], ['Size', C.num(f.size) + ' bytes'], ['sha256', f.sha256],
      ['File saved', f.lastModified ? C.when(new Date(f.lastModified).toISOString()) : 'not known'],
      ['Uploaded', C.when(f.uploadedAt) + ' by ' + f.uploadedBy],
      ['Other slot', r.otherSlot ? r.otherSlot.kind + ' file ' + r.otherSlot.filename + ', uploaded ' + C.when(r.otherSlot.uploadedAt) : 'none'],
    ].map(function (x) { return h('tr', null, h('th', { scope: 'row' }, x[0]), h('td', { colspan: '3' }, x[1])); });
    r.header.forEach(function (x) {
      rows.push(h('tr', { class: x.match ? null : 'down' }, h('th', { scope: 'row' }, 'Header: ' + x.field), h('td', null, x.file),
        h('td', null, x.setting === null ? '—' : x.setting), h('td', null, x.match ? '✓ matches' : '✗ MISMATCH')));
    });
    C.clear(document.getElementById('file-identity')).appendChild(h('div', { class: 'scroll-region', role: 'region', 'aria-labelledby': 'file-cap', tabindex: '0' },
      h('table', { class: 'data' }, h('caption', { id: 'file-cap' }, 'Uploaded file, and its header compared with the election settings'), h('tbody', null, rows))));
  }

  // ---------- previews ----------

  function pages() {
    var p = [['index.html', 'Summary results'], ['reporting.html', 'Reporting status'], ['precincts.html', 'Precinct results'], ['scrolling.html', 'Scrolling results']];
    return S.election.enablePrecinctResults === false ? p.filter(function (x) { return x[0] !== 'precincts.html'; }) : p;
  }
  function draftUrl(page) { return page + '?' + C.cfg.carry + 'draft=' + draftId + '&e=' + encodeURIComponent(eid); }

  function renderPreviews() {
    var ul = C.clear(document.getElementById('previews'));
    pages().forEach(function (p) {
      var mark = h('span', { class: 'viewed' }, S.viewed.has(p[0]) ? '✓ Opened' : '');
      var a = h('a', { class: 'btn', href: draftUrl(p[0]), target: '_blank', rel: 'noopener' }, 'Open ' + p[1] + ' (draft, opens in new tab)');
      a.addEventListener('click', function () {
        S.viewed.add(p[0]);
        store.set('viewed', Array.from(S.viewed));
        mark.textContent = '✓ Opened';
        updatePublish();
      });
      ul.appendChild(h('li', null, a, mark));
    });
    var compare = C.clear(document.getElementById('compare'));
    var details = compare.closest('details');
    details.addEventListener('toggle', function once() {
      if (!details.open || compare.firstChild) return;
      compare.appendChild(h('iframe', { title: 'Draft summary page', src: draftUrl('index.html') + '&embed', loading: 'lazy' }));
      compare.appendChild(h('iframe', { title: 'Live summary page', src: 'index.html' + (C.cfg.emulator ? '?emulator' : ''), loading: 'lazy' }));
    });
  }

  // ---------- contests (chunked render; filters toggle hidden) ----------

  function slug(i) { return 'contest-' + i; }

  function renderContests() {
    var el = C.clear(document.getElementById('contests'));
    var list = S.review.contests;
    S.contests = [];
    var i = 0;
    // Each card is filtered as it is added, so the list only grows by the cards that will stay and
    // the Publish panel below moves as little as possible while the chunks render.
    el.setAttribute('aria-busy', 'true');
    var chunk = function () {
      var frag = document.createDocumentFragment();
      var shows = matcher();
      for (var end = Math.min(i + 8, list.length); i < end; i++) {
        var card = contestCard(list[i], i);
        card.hidden = !shows(S.contests[S.contests.length - 1]);
        frag.appendChild(card);
      }
      el.appendChild(frag);
      if (i < list.length) return C.yieldToMain().then(chunk);
      el.setAttribute('aria-busy', 'false');
      applyFilter();
      return null;
    };
    var filter = document.getElementById('contest-filter');
    if (!list.some(function (c) { return c.changed; })) filter.value = 'all';
    return chunk();
  }

  function contestCard(c, i) {
    var badges = [];
    if (c.status === 'added') badges.push(h('span', { class: 'badge badge-new' }, 'New contest'));
    if (c.status === 'removed') badges.push(h('span', { class: 'badge badge-down' }, 'Removed'));
    if (c.leaderChanged) badges.push(h('span', { class: 'badge badge-leader' }, 'Leader changed'));
    if (c.closeMargin !== null) badges.push(h('span', { class: 'badge badge-close' }, 'Close race (margin ' + C.num(c.closeMargin) + ')'));
    if (c.decreased) badges.push(h('span', { class: 'badge badge-down' }, '▼ Decrease'));
    var capId = slug(i) + '-cap';
    var rows = c.candidates.map(function (x) {
      return h('tr', { class: x.decreased ? 'down' : null },
        h('th', { scope: 'row' }, x.name, x.status !== 'same' ? ' (' + x.status + ')' : ''),
        h('td', null, x.party || '—'),
        h('td', { class: 'n' }, C.num(x.current)),
        h('td', { class: 'n' }, C.num(x.draft)),
        h('td', { class: 'n' }, C.delta(x.delta)),
        h('td', { class: 'n' }, C.pct(x.currentPct)),
        h('td', { class: 'n' }, C.pct(x.draftPct)),
        h('td', null, x.leading ? '✓ Leading' : '', x.wasLeading && !x.leading ? ' (was leading)' : ''));
    });
    var trace = h('details', null, h('summary', null, 'Show the raw CSV rows for this contest'), h('pre', { class: 'trace' }, 'Loading…'));
    trace.addEventListener('toggle', function () { if (trace.open) fillTrace(c.title, trace.querySelector('pre')); });
    var card = h('section', { class: 'card contest', id: slug(i), 'aria-labelledby': slug(i) + '-h' },
      h('h3', { id: slug(i) + '-h', tabindex: '-1' }, c.title, badges),
      h('p', { class: 'contest-meta' }, 'Vote for ' + c.seats + ' · Precincts reporting ' + (c.reporting.current === null ? '—' : c.reporting.current) + ' → '
        + (c.reporting.draft === null ? '—' : c.reporting.draft) + ' of ' + c.reporting.of + ' · Total votes ' + C.num(c.total.current) + ' → ' + C.num(c.total.draft) + ' (' + C.delta(c.total.delta) + ')'),
      h('div', { class: 'scroll-region', role: 'region', 'aria-labelledby': capId, tabindex: '0' },
        h('table', { class: 'data' },
          h('caption', { id: capId }, c.title + ': published → draft'),
          h('thead', null, h('tr', null, ['Candidate', 'Party', { t: 'Published', n: 1 }, { t: 'Draft', n: 1 }, { t: 'Change', n: 1 }, { t: '% published', n: 1 }, { t: '% draft', n: 1 }, 'Leading']
            .map(function (x) { return h('th', { scope: 'col', class: x.n ? 'n' : null }, x.t || x); }))),
          h('tbody', null, rows))),
      c.newlyReported.length ? h('p', null, 'Newly reporting: ' + c.newlyReported.join(', ')) : null,
      c.stoppedReporting.length ? h('p', { class: 'field-error' }, '▼ No longer reporting: ' + c.stoppedReporting.join(', ')) : null,
      trace);
    S.contests.push({ el: card, c: c, text: (c.title + ' ' + c.candidates.map(function (x) { return x.name; }).join(' ')).toLowerCase() });
    return card;
  }

  /** The current filter and search, as a test of one S.contests entry. */
  function matcher() {
    var q = document.getElementById('contest-search').value.trim().toLowerCase();
    var f = document.getElementById('contest-filter').value;
    var test = { changed: function (c) { return c.changed; }, leader: function (c) { return c.leaderChanged; }, down: function (c) { return c.decreased; },
      close: function (c) { return c.closeMargin !== null; }, all: function () { return true; } }[f];
    return function (x) { return test(x.c) && (!q || x.text.indexOf(q) >= 0); };
  }

  function applyFilter() {
    var shows = matcher();
    var shown = 0;
    S.contests.forEach(function (x) {
      var on = shows(x);
      x.el.hidden = !on;
      if (on) shown++;
    });
    document.getElementById('contest-count').textContent = 'Showing ' + shown + ' of ' + S.contests.length + ' contests.';
  }

  function showContest(title) {
    var hit = (S.contests || []).find(function (x) { return x.c.title === title; });
    if (!hit) return;
    if (hit.el.hidden) { document.getElementById('contest-filter').value = 'all'; document.getElementById('contest-search').value = ''; applyFilter(); }
    var head = hit.el.querySelector('h3');
    head.scrollIntoView({ block: 'start' });
    head.focus();
  }

  var tracePromise;
  function fillTrace(title, pre) {
    tracePromise = tracePromise || fetch(C.cfg.publicUrl('drafts/' + draftId + '/trace.json'), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('trace.json ' + r.status);
      return r.json();
    });
    tracePromise.then(function (t) {
      var blocks = t.contests[title] || [];
      pre.textContent = blocks.map(function (b, k) {
        return 'Page ' + (k + 1) + '\n' + b.map(function (row) { return 'line ' + row.line + ':  ' + row.cells.join(' | '); }).join('\n');
      }).join('\n\n') || 'No rows found for this contest.';
    }, function () { pre.textContent = 'Could not load the raw rows. Try again.'; tracePromise = null; });
  }

  // ---------- precincts ----------

  function renderPrecincts() {
    var p = S.review.precincts;
    var el = C.clear(document.getElementById('precincts'));
    el.appendChild(h('h3', null, 'Newly reporting (' + p.newlyReported.length + ')'));
    el.appendChild(p.newlyReported.length ? h('p', null, p.newlyReported.join(', ')) : h('p', null, 'None.'));
    el.appendChild(h('h3', null, 'No longer reporting (' + p.stoppedReporting.length + ')'));
    el.appendChild(p.stoppedReporting.length ? h('p', { class: 'field-error' }, '▼ ' + p.stoppedReporting.join(', ')) : h('p', null, 'None.'));
    el.appendChild(h('h3', null, 'Turnout changes (' + p.statsChanged.length + ')'));
    if (!p.statsChanged.length) { el.appendChild(h('p', null, 'None.')); return; }
    var tableBox = h('div', { class: 'scroll-region', role: 'region', 'aria-labelledby': 'pst-cap', tabindex: '0' },
      h('table', { class: 'data' }, h('caption', { id: 'pst-cap' }, 'Precincts whose registered voters or ballots changed'),
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Precinct'), h('th', { scope: 'col', class: 'n' }, 'Registered'), h('th', { scope: 'col', class: 'n' }, 'Ballots'), h('th', { scope: 'col', class: 'n' }, 'Turnout'))),
        h('tbody', null, p.statsChanged.map(function (s) {
          return h('tr', null, h('th', { scope: 'row' }, s.name),
            h('td', { class: 'n' }, C.num(s.voters.current) + ' → ' + C.num(s.voters.draft)),
            h('td', { class: 'n' }, C.num(s.ballots.current) + ' → ' + C.num(s.ballots.draft) + ' (' + C.delta(s.ballots.delta) + ')'),
            h('td', { class: 'n' }, C.pct(s.turnout.current) + ' → ' + C.pct(s.turnout.draft)));
        }))));
    // Long lists (a first publish lists every precinct) stay folded until asked for.
    el.appendChild(p.statsChanged.length > 20 ? h('details', null, h('summary', null, 'Show all ' + p.statsChanged.length + ' precincts'), tableBox) : tableBox);
  }

  // ---------- publish ----------

  function needs() {
    var d = S.draft;
    var warns = d.checks.filter(function (c) { return c.severity === 'warn'; });
    var acked = warns.filter(function (c) { return S.acked.has(c.key); }).length;
    var ps = S.review ? pages() : [];
    var viewed = ps.filter(function (p) { return S.viewed.has(p[0]); }).length;
    return [
      [d.status === 'ready', d.status === 'ready' ? 'Draft is ready' : 'Draft is ' + d.status],
      [!d.checks.some(function (c) { return c.severity === 'block'; }), 'No blocking checks'],
      [acked === warns.length, 'Warnings checked: ' + acked + ' of ' + warns.length],
      [S.review && viewed === ps.length, 'Pages opened: ' + viewed + ' of ' + ps.length],
      [d.expiresAt > Date.now(), d.expiresAt > Date.now() ? 'Draft has not expired' : 'Draft expired: extend it'],
    ];
  }

  function updatePublish() {
    var list = needs();
    var ul = C.clear(document.getElementById('publish-needs'));
    list.forEach(function (n) { ul.appendChild(h('li', null, (n[0] ? '✓ ' : '✗ ') + n[1])); });
    document.getElementById('publish-btn').disabled = !list.every(function (n) { return n[0]; });
    var done = S.draft.status !== 'ready';
    document.getElementById('extend-btn').disabled = done;
    document.getElementById('discard-btn').disabled = ['published', 'discarded'].indexOf(S.draft.status) >= 0;
  }

  function summarySentence() {
    var r = S.review;
    var hl = r.headline.precinctsReporting;
    var kind = { zero: 'Zero report', early: 'Early/ABS update', ed: 'Election Day update', rollback: 'Rollback' }[r.file.kind] || r.file.kind;
    return 'Publish ' + kind + ': ' + (hl.current === null ? 'first publish, ' : hl.current + ' → ') + hl.draft + ' of ' + hl.of + ' precincts reporting, '
      + r.counts.changed + ' contests changed, ' + r.counts.leaderChanges + ' leader change' + (r.counts.leaderChanges === 1 ? '' : 's') + '.';
  }

  var opener;
  function openPublish() {
    opener = document.activeElement;
    document.getElementById('publish-summary').textContent = summarySentence();
    document.getElementById('confirm-count').value = '';
    document.getElementById('confirm-error').textContent = '';
    var dlg = document.getElementById('publish-dialog');
    dlg.addEventListener('close', function back() { dlg.removeEventListener('close', back); if (opener) opener.focus(); });
    dlg.showModal();
    document.getElementById('confirm-count').focus();
  }

  function submitPublish(ev) {
    if (ev.submitter && ev.submitter.value === 'cancel') return; // dialog closes itself
    ev.preventDefault();
    var input = document.getElementById('confirm-count');
    var typed = input.value.trim();
    if (!/^\d+$/.test(typed) || Number(typed) !== S.draft.confirmCount) {
      document.getElementById('confirm-error').textContent = 'That does not match. Type the precincts-reporting number from the sentence above (' + S.review.headline.precinctsReporting.of + ' is the total, not the number reporting).';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    document.getElementById('publish-dialog').close();
    var btn = document.getElementById('publish-btn');
    C.busy(btn, 'Publishing…', function () {
      return C.call('publishDraft', { electionId: eid, draftId: draftId, acknowledged: Array.from(S.acked), confirmCount: Number(typed) });
    }).then(function (r) {
      S.draft.status = 'published';
      updatePublish();
      var out = C.clear(document.getElementById('publish-result'));
      if (r.liveCheck.ok) {
        out.appendChild(h('div', { class: 'ok-box', role: 'status' }, h('strong', null, '✓ Published. Live check passed: '), 'the public file is exactly the reviewed draft (version ' + r.dataVersion + ').'));
      } else {
        out.appendChild(h('div', { class: 'alert', role: 'alert' }, h('strong', null, '✗ Published, but the live check FAILED. '),
          'The public URL is not serving the reviewed file yet. Wait 30 seconds and reload a public page; if the numbers are wrong, roll back from Election admin › Published versions.'));
      }
      out.focus();
    }, function (e) {
      var refusals = (e.details && e.details.refusals) || [];
      if (refusals.some(function (x) { return x.code === 'stale'; })) S.draft.status = 'stale';
      updatePublish();
    });
  }

  function extend() {
    var btn = document.getElementById('extend-btn');
    C.busy(btn, 'Extending…', function () { return C.call('extendDraft', { electionId: eid, draftId: draftId }); }).then(function (r) {
      S.draft.expiresAt = r.expiresAt;
      warned = {};
      note('Draft extended: 2 more hours.');
      updatePublish();
    }, function () {});
  }

  function discard() {
    var dlg = document.getElementById('confirm-dialog');
    document.getElementById('confirm-h').textContent = 'Discard this draft?';
    document.getElementById('confirm-text').textContent = 'The draft and its files are deleted. Nothing published changes.';
    document.getElementById('confirm-ok').textContent = 'Discard draft';
    var btn = document.getElementById('discard-btn');
    dlg.addEventListener('close', function done() {
      dlg.removeEventListener('close', done);
      btn.focus();
      if (dlg.returnValue !== 'ok') return;
      C.busy(btn, 'Discarding…', function () { return C.call('discardDraft', { electionId: eid, draftId: draftId }); }).then(function () {
        location.href = 'admin.html' + (C.cfg.emulator ? '?emulator' : '');
      }, function () {});
    });
    dlg.returnValue = '';
    dlg.showModal();
  }
}());
