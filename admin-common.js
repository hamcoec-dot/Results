/**
 * Shared by admin.html and review.html: sign-in and the admin gate, a DOM builder that only ever
 * sets text (never innerHTML: names come from CSV files), status announcements (WCAG 4.1.3),
 * callable wrappers with immediate progress feedback, and number formatting.
 */
window.AdminCommon = (function () {
  'use strict';

  var cfg = window.RESULTS_ADMIN;

  /** h('p', {class: 'x', 'aria-live': 'polite', on: {click: fn}}, 'text', childNode, ...) */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  /** Polite status (progress, success) or assertive alert (failures); never moves focus. */
  function announce(msg, opts) {
    var el = document.getElementById(opts && opts.alert ? 'page-alert' : 'page-status');
    if (!el) return;
    el.textContent = '';
    // A fresh text node after a tick makes screen readers announce a repeated message too.
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  var nf = new Intl.NumberFormat('en-US');
  function num(n) { return n === null || n === undefined ? '—' : nf.format(n); }
  /** "▲ +120 (increase)" / "▼ −120 (decrease)" / "no change" — never colour alone (1.4.1). */
  function delta(d) {
    if (d === null || d === undefined) return 'new';
    if (d === 0) return 'no change';
    var mag = nf.format(Math.abs(d));
    return d > 0 ? '▲ +' + mag + ' (increase)' : '▼ −' + mag + ' (decrease)';
  }
  function pct(p) { return p === null || p === undefined ? '—' : p.toFixed(2) + ' %'; }
  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? String(iso) : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function ago(iso, now) {
    var s = Math.max(0, Math.round(((now || Date.now()) - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + ' s ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    return Math.round(s / 3600) + ' h ago';
  }

  var FRIENDLY = {
    'functions/unauthenticated': 'Your sign-in expired. Sign in again.',
    'functions/permission-denied': 'This account is not an administrator.',
    'functions/deadline-exceeded': 'The server took too long. Nothing was published. Try again.',
    'functions/unavailable': 'Cannot reach the server. Check the connection and try again.',
    'functions/internal': 'Something went wrong on the server. Nothing was published. Try again.',
  };
  function errorText(e) { return FRIENDLY[e && e.code] || (e && e.message) || 'Something went wrong.'; }

  function call(name, data) {
    return cfg.functions.httpsCallable(name, { timeout: 120000 })(data).then(function (r) { return r.data; });
  }

  /**
   * Run `work` with the button disabled and a status message shown at once (within 100 ms of the
   * tap; plan › Progress feedback). Resolves to work's result; on failure announces and rethrows.
   */
  function busy(button, message, work) {
    var label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = message;
    announce(message);
    return Promise.resolve().then(work).then(function (r) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
      return r;
    }, function (e) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = label;
      announce(errorText(e), { alert: true });
      throw e;
    });
  }

  /** Yield to the main thread between render chunks (no long tasks). */
  function yieldToMain() {
    if (window.scheduler && typeof window.scheduler.yield === 'function') return window.scheduler.yield();
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  function param(name) { return new URLSearchParams(location.search).get(name); }

  /**
   * Sign-in and admin gate. Shows #signin, #not-admin or #app; calls onAdmin(user) once per sign-in.
   * The page must have: form#signin-form (email, password), #signin-error, #not-admin, #app,
   * button.sign-out (any number).
   */
  function gate(onAdmin) {
    var auth = firebase.auth();
    var signin = document.getElementById('signin');
    var notAdmin = document.getElementById('not-admin');
    var app = document.getElementById('app');
    var form = document.getElementById('signin-form');
    var err = document.getElementById('signin-error');
    var show = function (which) {
      [signin, notAdmin, app].forEach(function (s) { s.hidden = s !== which; });
    };
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      err.textContent = '';
      var btn = form.querySelector('button[type=submit]');
      busy(btn, 'Signing in…', function () {
        return auth.signInWithEmailAndPassword(form.email.value.trim(), form.password.value);
      }).catch(function (e) {
        err.textContent = /password|user|credential/i.test(e.code || '')
          ? 'Email or password is not right. Check both and try again.'
          : errorText(e);
        form.email.setAttribute('aria-invalid', 'true');
        form.password.focus();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.sign-out'), function (b) {
      b.addEventListener('click', function () { auth.signOut(); });
    });
    auth.onAuthStateChanged(function (user) {
      if (!user) { show(signin); return; }
      firebase.firestore().doc('admins/' + user.uid).get().then(function (snap) {
        if (!snap.exists) { show(notAdmin); return; }
        show(app);
        document.querySelectorAll('.who').forEach(function (el) { el.textContent = user.email; });
        announce('Signed in as ' + user.email + '.');
        call('ping', {}).catch(function () {}); // warm the functions
        onAdmin(user);
      }, function () { show(notAdmin); });
    });
  }

  return { h: h, clear: clear, announce: announce, num: num, delta: delta, pct: pct, when: when, ago: ago,
    errorText: errorText, call: call, busy: busy, yieldToMain: yieldToMain, param: param, gate: gate, cfg: cfg };
}());
