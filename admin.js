/**
 * admin.html: election settings, upload -> draft, open drafts, published versions (rollback) and
 * uploads. Every write goes through a callable; this page only reads Firestore (rules: admins read).
 */
(function () {
  'use strict';

  var C = window.AdminCommon;
  var h = C.h;
  var db;
  var elections = [];
  var current = null; // {id, data}
  var NEW = '__new__';

  document.addEventListener('DOMContentLoaded', function () {
    db = firebase.firestore();
    C.gate(function () { loadElections(); });
    document.getElementById('election-select').addEventListener('change', function (e) { selectElection(e.target.value); });
    document.getElementById('settings-form').addEventListener('submit', saveSettings);
    document.getElementById('upload-form').addEventListener('submit', upload);
    document.getElementById('settings-draft-btn').addEventListener('click', settingsDraft);
  });

  // ---------- elections & settings ----------

  function loadElections(selectId) {
    return db.collection('elections').get().then(function (snap) {
      elections = snap.docs.map(function (d) { return { id: d.id, data: d.data() }; })
        .sort(function (a, b) { return (b.data.date || '').localeCompare(a.data.date || ''); });
      var sel = C.clear(document.getElementById('election-select'));
      elections.forEach(function (e) {
        sel.appendChild(h('option', { value: e.id }, (e.data.active ? '★ ' : '') + e.data.name + ' (' + e.data.date + ')' + (e.data.active ? ' — active' : '')));
      });
      sel.appendChild(h('option', { value: NEW }, '+ New election…'));
      var active = elections.find(function (e) { return e.data.active; });
      var pick = selectId || (current && current.id) || (active && active.id) || (elections[0] && elections[0].id) || NEW;
      sel.value = pick;
      selectElection(pick);
    }, function (e) { C.announce('Could not load elections: ' + C.errorText(e), { alert: true }); });
  }

  function selectElection(id) {
    current = id === NEW ? null : elections.find(function (e) { return e.id === id; }) || null;
    var f = document.getElementById('settings-form');
    var d = current ? current.data : {};
    f.id.value = current ? current.id : '';
    f.id.readOnly = Boolean(current);
    f.name.value = d.name || '';
    f.date.value = d.date || '';
    f.county.value = d.county || 'Hamilton';
    f.precinctCap.value = d.precinctCap || 92;
    f.enablePrecinctResults.checked = d.enablePrecinctResults !== false;
    f.makeActive.checked = Boolean(d.active);
    ['id', 'name', 'date', 'county', 'cap'].forEach(function (k) { setFieldError(k, ''); });
    document.getElementById('upload-form').hidden = !current;
    // A settings rebuild needs published files to rebuild.
    document.getElementById('settings-draft-btn').closest('.settings-draft').hidden = !(current && current.data.currentVersion);
    renderPublished();
    renderAuditBanner();
    if (current) { loadDrafts(); loadHistory(); loadUploads(); } else {
      ['drafts', 'history', 'uploads'].forEach(function (s) { C.clear(document.getElementById(s)).appendChild(h('p', null, 'Save the new election first.')); });
    }
  }

  function renderPublished() {
    var el = C.clear(document.getElementById('published-now'));
    if (!current) return;
    var v = current.data.currentVersion;
    el.appendChild(v ? h('span', null, 'Live data version ', h('code', null, v), ' · ') : h('span', null, 'Nothing published yet · '));
    el.appendChild(h('a', { href: 'index.html', target: '_blank', rel: 'noopener' }, 'View public page (opens in new tab)'));
  }

  function renderAuditBanner() {
    var el = C.clear(document.getElementById('audit-alert'));
    var a = current && current.data.lastAudit;
    if (!a || a.ok) return;
    el.appendChild(h('strong', null, 'LIVE CHECK FAILED ' + C.when(a.at) + ': the public pages are not serving the published numbers. '));
    el.appendChild(h('span', null, (a.problems || []).join('; ') + ' Retry the publish or roll back, and check the bucket.'));
  }

  var FIELD_ERR = { id: 's-id', name: 's-name', date: 's-date', county: 's-county', precinctCap: 's-cap', cap: 's-cap' };
  function setFieldError(field, msg) {
    var base = FIELD_ERR[field];
    if (!base) return false;
    document.getElementById(base + '-error').textContent = msg;
    var input = document.getElementById(base);
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    return true;
  }

  function saveSettings(ev) {
    ev.preventDefault();
    var f = ev.target;
    ['id', 'name', 'date', 'county', 'cap'].forEach(function (k) { setFieldError(k, ''); });
    var cap = Number(f.precinctCap.value);
    if (!Number.isInteger(cap) || cap < 1 || cap > 999) {
      setFieldError('cap', 'Max precincts must be a whole number from 1 to 999.');
      f.precinctCap.focus();
      return;
    }
    var data = {
      id: f.id.value.trim(), name: f.name.value.trim(), date: f.date.value, county: f.county.value.trim(),
      precinctCap: cap, enablePrecinctResults: f.enablePrecinctResults.checked, makeActive: f.makeActive.checked,
    };
    C.busy(f.querySelector('button[type=submit]'), 'Saving…', function () { return C.call('upsertElection', data); })
      .then(function (r) {
        C.announce(r.created ? 'Election created.' : 'Settings saved. They apply to the next draft; use "Create draft with these settings" to apply them to what is published now.');
        return loadElections(r.id);
      }, function (e) {
        var field = e.details && e.details.field;
        if (setFieldError(field, e.message.replace(/^\w+: /, ''))) document.getElementById(FIELD_ERR[field]).focus();
      });
  }

  // ---------- upload ----------

  /** gzip + base64 in the browser (≈10x smaller on mobile data); plain text where unsupported. */
  function encode(text) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve({ csv: text });
    var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).blob().then(function (blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve({ csvGzipBase64: String(r.result).split(',')[1] }); };
        r.onerror = function () { reject(r.error); };
        r.readAsDataURL(blob);
      });
    });
  }

  function upload(ev) {
    ev.preventDefault();
    var f = ev.target;
    var kind = (f.querySelector('input[name=kind]:checked') || {}).value;
    var file = f.file.files[0];
    document.getElementById('kind-error').textContent = kind ? '' : 'Choose what this file is: Zero, Early voting / Absentee, or Election Day.';
    document.getElementById('file-error').textContent = file ? (/\.csv$/i.test(file.name) ? '' : 'Choose the .csv export (Custom Table Report).') : 'Choose the CSV file.';
    if (!kind) { f.querySelector('input[name=kind]').focus(); return; }
    if (!file || !/\.csv$/i.test(file.name)) { f.file.focus(); return; }
    if (!current) { C.announce('Choose or save an election first.', { alert: true }); return; }
    var btn = f.querySelector('button[type=submit]');
    C.busy(btn, 'Processing file…', function () {
      return file.text().then(encode).then(function (payload) {
        return C.call('createDraft', Object.assign({ electionId: current.id, kind: kind, filename: file.name, lastModified: file.lastModified }, payload));
      });
    }).then(function (r) {
      C.announce('Draft created (' + r.status + '): ' + r.counts.block + ' blocking, ' + r.counts.warn + ' warnings. Opening review…');
      location.href = 'review.html?' + C.cfg.carry + 'e=' + encodeURIComponent(current.id) + '&draft=' + r.draftId;
    }, function () {});
  }

  // ---------- lists ----------

  /**
   * Show "Loading…" in a list. If it takes over 15 s (a poor connection), say so and offer Retry
   * instead of leaving the section blank. Returns a token; a result whose token is no longer the
   * list's latest (it was reloaded meanwhile) is ignored.
   */
  function loading(el, what, retry) {
    var token = {};
    el.loadToken = token;
    C.clear(el).appendChild(h('p', null, 'Loading ' + what + '…'));
    clearTimeout(el.loadTimer); // a reload replaces the previous load's timer
    el.loadTimer = setTimeout(function () {
      if (el.loadToken !== token || !el.textContent.startsWith('Loading')) return;
      var again = h('button', { class: 'btn', type: 'button' }, 'Retry');
      again.addEventListener('click', retry);
      C.clear(el).appendChild(h('p', null, 'Still loading ' + what + '. Check the connection, or ', again));
    }, 15000);
    return token;
  }

  function table(caption, heads, rows) {
    if (!rows.length) return h('p', null, 'None.');
    var id = 't' + Math.random().toString(36).slice(2, 8);
    return h('div', { class: 'scroll-region', role: 'region', 'aria-labelledby': id, tabindex: '0' },
      h('table', { class: 'data' },
        h('caption', { id: id }, caption),
        h('thead', null, h('tr', null, heads.map(function (x) { return h('th', { scope: 'col', class: x.n ? 'n' : null }, x.t || x); }))),
        h('tbody', null, rows)));
  }

  function loadDrafts() {
    var el = document.getElementById('drafts');
    var token = loading(el, 'drafts', loadDrafts);
    db.collection('elections/' + current.id + '/drafts').where('status', 'in', ['ready', 'blocked', 'stale']).get().then(function (snap) {
      if (el.loadToken !== token) return;
      var docs = snap.docs.map(function (d) { return { id: d.id, d: d.data() }; }).sort(function (a, b) { return b.d.createdAt.localeCompare(a.d.createdAt); });
      C.clear(el).appendChild(table('Drafts not yet published', ['Status', 'Kind', 'Created', 'By', 'Actions'], docs.map(function (x) {
        var review = h('a', { class: 'btn', href: 'review.html?' + C.cfg.carry + 'e=' + encodeURIComponent(current.id) + '&draft=' + x.id }, 'Review');
        var discard = h('button', { class: 'btn btn-danger', type: 'button' }, 'Discard');
        discard.addEventListener('click', function () { discardDraft(x.id, discard); });
        return h('tr', null,
          h('th', { scope: 'row' }, statusLabel(x.d.status)),
          h('td', null, x.d.kind === 'rollback' ? 'Rollback to ' + x.d.rollbackOf : x.d.kind === 'settings' ? 'Settings change' : x.d.kind),
          h('td', null, C.when(x.d.createdAt) + ' (' + C.ago(x.d.createdAt) + ')'),
          h('td', null, x.d.createdBy),
          h('td', null, h('span', { class: 'row' }, review, discard)));
      })));
    }, function (e) { if (el.loadToken === token) C.clear(el).appendChild(h('p', null, 'Could not load drafts: ' + C.errorText(e))); });
  }

  function statusLabel(s) {
    return { ready: 'Ready for review', blocked: 'BLOCKED', stale: 'Stale (re-upload)', published: 'Published', discarded: 'Discarded' }[s] || s;
  }

  function confirmDialog(title, text, okLabel) {
    var dlg = document.getElementById('confirm-dialog');
    document.getElementById('confirm-h').textContent = title;
    document.getElementById('confirm-text').textContent = text;
    document.getElementById('confirm-ok').textContent = okLabel;
    var opener = document.activeElement;
    return new Promise(function (resolve) {
      dlg.addEventListener('close', function done() {
        dlg.removeEventListener('close', done);
        if (opener && opener.focus) opener.focus();
        resolve(dlg.returnValue === 'ok');
      });
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  function discardDraft(id, btn) {
    confirmDialog('Discard this draft?', 'The draft and its files are deleted. Nothing published changes.', 'Discard draft').then(function (ok) {
      if (!ok) return;
      C.busy(btn, 'Discarding…', function () { return C.call('discardDraft', { electionId: current.id, draftId: id }); })
        .then(function () { C.announce('Draft discarded.'); loadDrafts(); }, function () {});
    });
  }

  function loadHistory() {
    var el = document.getElementById('history');
    var token = loading(el, 'published versions', loadHistory);
    Promise.all([
      db.collection('elections/' + current.id + '/versions').get(),
      db.collection('elections/' + current.id + '/uploads').get(),
    ]).then(function (res) {
      if (el.loadToken !== token) return;
      var uploads = {};
      res[1].docs.forEach(function (d) { uploads[d.id] = d.data(); });
      var name = function (id) { return id && uploads[id] ? uploads[id].filename : '—'; };
      var versions = res[0].docs.map(function (d) { return { id: d.id, v: d.data() }; }).sort(function (a, b) { return b.v.publishedAt.localeCompare(a.v.publishedAt); });
      C.clear(el).appendChild(table('Every published version, newest first', ['Published', 'By', 'Early file', 'Election Day file', 'Warnings acknowledged', 'Live check', 'Version', ''], versions.map(function (x) {
        var live = x.id === current.data.currentVersion;
        var btn = live ? h('span', null, 'Live now') : h('button', { class: 'btn', type: 'button' }, 'Roll back to this');
        if (!live) btn.addEventListener('click', function () { rollback(x.id, btn); });
        var lc = x.v.liveCheck;
        return h('tr', null,
          h('th', { scope: 'row' }, C.when(x.v.publishedAt)),
          h('td', null, x.v.publishedBy),
          h('td', null, name(x.v.earlyUploadId)),
          h('td', null, name(x.v.edUploadId)),
          h('td', { class: 'n' }, String((x.v.acknowledgements || []).length)),
          h('td', null, lc ? (lc.ok ? '✓ Passed' : '✗ FAILED') : '—'),
          h('td', null, h('code', null, x.id), x.v.rollbackOf ? ' (rollback)' : ''),
          h('td', null, btn));
      })));
    }, function (e) { if (el.loadToken === token) C.clear(el).appendChild(h('p', null, 'Could not load history: ' + C.errorText(e))); });
  }

  function settingsDraft(ev) {
    var btn = ev.currentTarget;
    C.busy(btn, 'Rebuilding with the saved settings…', function () { return C.call('createSettingsDraft', { electionId: current.id }); })
      .then(function (r) { location.href = 'review.html?' + C.cfg.carry + 'e=' + encodeURIComponent(current.id) + '&draft=' + r.draftId; }, function () {});
  }

  function rollback(version, btn) {
    confirmDialog('Roll back to version ' + version + '?', 'This creates a draft of that version. You review every change before anything is published.', 'Create rollback draft').then(function (ok) {
      if (!ok) return;
      C.busy(btn, 'Building rollback draft…', function () { return C.call('createRollbackDraft', { electionId: current.id, version: version }); })
        .then(function (r) { location.href = 'review.html?' + C.cfg.carry + 'e=' + encodeURIComponent(current.id) + '&draft=' + r.draftId; }, function () {});
    });
  }

  function loadUploads() {
    var el = document.getElementById('uploads');
    var token = loading(el, 'uploads', loadUploads);
    db.collection('elections/' + current.id + '/uploads').get().then(function (snap) {
      if (el.loadToken !== token) return;
      var docs = snap.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return b.uploadedAt.localeCompare(a.uploadedAt); });
      C.clear(el).appendChild(table('Every uploaded file, newest first', ['Uploaded', 'By', 'Kind', 'File', { t: 'Size', n: true }, 'sha256'], docs.map(function (u) {
        return h('tr', null,
          h('th', { scope: 'row' }, C.when(u.uploadedAt)),
          h('td', null, u.uploadedBy),
          h('td', null, u.kind),
          h('td', null, u.filename),
          h('td', { class: 'n' }, C.num(u.size)),
          h('td', null, h('code', null, u.sha256.slice(0, 12) + '…')));
      })));
    }, function (e) { if (el.loadToken === token) C.clear(el).appendChild(h('p', null, 'Could not load uploads: ' + C.errorText(e))); });
  }
}());
