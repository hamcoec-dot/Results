/**
 * archive.html: every election's official archive (docs/ARCHIVE.md), from the public bucket's
 * archive/index.json, newest election first, with links to that election's own pages
 * (index.html?election=<id> and so on). Names are set as text, never as HTML.
 */
(function () {
  'use strict';

  var RESULTS = window.RESULTS;
  var NUMBER = new Intl.NumberFormat('en-US');

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** "November 20, 2026" for a YYYY-MM-DD date. */
  function longDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
    if (!m) return ymd || '';
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function pageLink(page, id) {
    return page + '?' + RESULTS.carry + 'election=' + encodeURIComponent(id);
  }

  function item(e) {
    var li = el('li', { class: 'archive-item' });
    var heading = el('h2', { id: 'archive-' + e.id }, e.name || e.title || e.id);
    li.appendChild(heading);
    var facts = [];
    if (e.date) facts.push('Election held ' + longDate(e.date) + '.');
    if (e.certifiedDate) facts.push('Results certified ' + longDate(e.certifiedDate) + '.');
    if (typeof e.totalBallots === 'number') {
      facts.push(NUMBER.format(e.totalBallots) + ' ballots cast' + (typeof e.turnoutPercent === 'number' ? ' (' + e.turnoutPercent.toFixed(2) + '% turnout).' : '.'));
    }
    li.appendChild(el('p', null, facts.join(' ')));
    var links = el('div', { class: 'archive-links', role: 'group', 'aria-labelledby': 'archive-' + e.id });
    links.appendChild(el('a', { class: 'export-btn', href: pageLink('index.html', e.id) }, 'Summary results'));
    if (e.precinctPage !== false) links.appendChild(el('a', { class: 'export-btn', href: pageLink('precincts.html', e.id) }, 'Precinct results'));
    links.appendChild(el('a', { class: 'export-btn', href: pageLink('reporting.html', e.id) }, 'Reporting status'));
    li.appendChild(links);
    return li;
  }

  function show(list) {
    var ul = document.getElementById('archive-list');
    var status = document.getElementById('archive-status');
    list.forEach(function (e) { ul.appendChild(item(e)); });
    status.textContent = list.length
      ? list.length + (list.length === 1 ? ' past election.' : ' past elections, newest first.')
      : 'No past elections have been archived yet.';
  }

  function load() {
    var status = document.getElementById('archive-status');
    fetch(RESULTS.bucketUrl('archive/index.json', { bust: true }), { cache: 'no-store' })
      .then(function (res) {
        if (res.status === 404 || res.status === 403) return { elections: [] }; // nothing archived yet
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (index) {
        var list = (index && Array.isArray(index.elections) ? index.elections : [])
          .filter(function (e) { return e && typeof e.id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(e.id); });
        show(list);
      })
      .catch(function (err) {
        console.error('Past elections could not be loaded.', err);
        status.textContent = 'Past elections could not be loaded. Reload the page to try again.';
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
}());
