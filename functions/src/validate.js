/**
 * Shape and sanity validation of the published JSON (plan: Test strategy › client-side validation).
 * Shared by the public pages (app.js), review.js and the auditLive function, so it is plain
 * browser-safe JavaScript in a UMD wrapper: no Node APIs, no dependencies.
 *
 * Invalid data is never rendered: a page that gets { ok: false } keeps showing its last good data.
 *
 *   validateFile(name, obj)      'summary.json' | 'reporting.json' | 'precincts.json' | 'manifest.json'
 *   validateSet(manifest, files) every fetched file is valid and carries the manifest's dataVersion
 * Each returns { ok: boolean, errors: string[] } (at most MAX_ERRORS errors).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResultsValidate = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_ERRORS = 50;
  var VERSION_RE = /^[0-9a-f]{12}$/;

  function Report() { this.errors = []; }
  Report.prototype.fail = function (path, msg) {
    if (this.errors.length < MAX_ERRORS) this.errors.push(path + ': ' + msg);
    return false;
  };
  Report.prototype.result = function () { return { ok: this.errors.length === 0, errors: this.errors }; };

  var isObj = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
  function count(r, path, v) {
    return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v ? true : r.fail(path, 'expected a whole number >= 0, got ' + JSON.stringify(v));
  }
  function pct(r, path, v) {
    return typeof v === 'number' && isFinite(v) && v >= 0 ? true : r.fail(path, 'expected a percentage >= 0, got ' + JSON.stringify(v));
  }
  function str(r, path, v) { return typeof v === 'string' ? true : r.fail(path, 'expected text'); }
  function bool(r, path, v) { return typeof v === 'boolean' ? true : r.fail(path, 'expected true/false'); }
  function arr(r, path, v) { return Array.isArray(v) ? true : r.fail(path, 'expected a list'); }
  function obj(r, path, v) { return isObj(v) ? true : r.fail(path, 'expected an object'); }

  function metadata(r, m) {
    if (!obj(r, 'metadata', m)) return;
    ['electionTitle', 'electionDate', 'county', 'statusLabel', 'lastUpdated'].forEach(function (k) { str(r, 'metadata.' + k, m[k]); });
    if (typeof m.dataVersion !== 'string' || !VERSION_RE.test(m.dataVersion)) r.fail('metadata.dataVersion', 'expected 12 hex characters');
  }

  function reporting(r, path, c) {
    if (count(r, path + '.precinctsReporting', c.precinctsReporting) && count(r, path + '.precinctsTotal', c.precinctsTotal)
      && c.precinctsReporting > c.precinctsTotal) {
      r.fail(path, 'precincts reporting ' + c.precinctsReporting + ' is more than the total ' + c.precinctsTotal);
    }
  }

  function candidates(r, path, c) {
    if (!arr(r, path + '.candidates', c.candidates)) return;
    var sum = 0;
    var names = {};
    c.candidates.forEach(function (x, i) {
      var p = path + '.candidates[' + i + ']';
      if (!obj(r, p, x)) return;
      str(r, p + '.name', x.name);
      if (Object.prototype.hasOwnProperty.call(names, x.name)) r.fail(p, 'duplicate candidate ' + JSON.stringify(x.name));
      names[x.name] = true;
      if (['REP', 'DEM', 'IND', ''].indexOf(x.party) < 0) r.fail(p + '.party', 'unexpected party ' + JSON.stringify(x.party));
      if (count(r, p + '.votes', x.votes)) sum += x.votes;
      if (pct(r, p + '.percentage', x.percentage) && x.percentage > 100) r.fail(p + '.percentage', 'over 100');
      bool(r, p + '.isLeading', x.isLeading);
    });
    if (count(r, path + '.totalVotes', c.totalVotes) && sum !== c.totalVotes) {
      r.fail(path, 'candidate votes add up to ' + sum + ', contest total is ' + c.totalVotes);
    }
  }

  function contestList(r, path, list, each) {
    if (!arr(r, path, list)) return;
    var titles = {};
    list.forEach(function (c, i) {
      var p = path + '[' + i + ']';
      if (!obj(r, p, c)) return;
      str(r, p + '.title', c.title);
      if (Object.prototype.hasOwnProperty.call(titles, c.title)) r.fail(p, 'duplicate contest ' + JSON.stringify(c.title));
      titles[c.title] = true;
      reporting(r, p, c);
      each(p, c);
    });
  }

  function statusIndexed(r, path, c, nPrecincts) {
    if (!arr(r, path + '.precinctsStatusIndexed', c.precinctsStatusIndexed)) return;
    var reported = 0;
    c.precinctsStatusIndexed.forEach(function (pair, k) {
      var p = path + '.precinctsStatusIndexed[' + k + ']';
      if (!Array.isArray(pair) || pair.length !== 2 || !(pair[1] === 0 || pair[1] === 1)) { r.fail(p, 'expected [index, 0|1]'); return; }
      if (count(r, p, pair[0]) && pair[0] >= nPrecincts) r.fail(p, 'precinct index out of range');
      reported += pair[1];
    });
    // Flags may differ from the count only when the reviewer acknowledged a reporting-mismatch
    // warning (the CSV's count publishes as written), so the hard limit here is the total.
    if (reported > c.precinctsTotal) r.fail(path, reported + ' precincts flagged reported, but the contest has only ' + c.precinctsTotal);
  }

  function overall(r, path, l) {
    if (count(r, path + '.overallPrecinctsReporting', l.overallPrecinctsReporting) && count(r, path + '.overallPrecinctsTotal', l.overallPrecinctsTotal)
      && l.overallPrecinctsReporting > l.overallPrecinctsTotal) {
      r.fail(path, 'overall precincts reporting is more than the total');
    }
  }

  var VALIDATORS = {
    'summary.json': function (r, d) {
      metadata(r, d.metadata);
      obj(r, 'config', d.config);
      if (!obj(r, 'latest', d.latest)) return;
      var l = d.latest;
      ['totalVoters', 'totalBallots', 'ballotsRep', 'ballotsDem', 'ballotsGen', 'earlyBallotsCast'].forEach(function (k) { count(r, 'latest.' + k, l[k]); });
      pct(r, 'latest.turnoutPercent', l.turnoutPercent);
      overall(r, 'latest', l);
      contestList(r, 'latest.contests', l.contests, function (p, c) { str(r, p + '.voteFor', c.voteFor); candidates(r, p, c); });
    },
    'reporting.json': function (r, d) {
      metadata(r, d.metadata);
      obj(r, 'config', d.config);
      if (!arr(r, 'masterPrecincts', d.masterPrecincts) || !obj(r, 'latest', d.latest)) return;
      overall(r, 'latest', d.latest);
      contestList(r, 'latest.contests', d.latest.contests, function (p, c) { statusIndexed(r, p, c, d.masterPrecincts.length); });
    },
    'precincts.json': function (r, d) {
      metadata(r, d.metadata);
      obj(r, 'config', d.config);
      if (!arr(r, 'masterPrecincts', d.masterPrecincts) || !obj(r, 'precinctStats', d.precinctStats)) return;
      Object.keys(d.precinctStats).forEach(function (name) {
        var s = d.precinctStats[name];
        var p = 'precinctStats[' + JSON.stringify(name) + ']';
        if (!obj(r, p, s)) return;
        ['voters', 'ballots', 'rep', 'dem', 'gen'].forEach(function (k) { count(r, p + '.' + k, s[k]); });
        pct(r, p + '.turnoutPercent', s.turnoutPercent);
      });
      contestList(r, 'contests', d.contests, function (p, c) {
        candidates(r, p, c);
        statusIndexed(r, p, c, d.masterPrecincts.length);
        (c.candidates || []).forEach(function (x, i) {
          if (!obj(r, p + '.candidates[' + i + '].precinctVotes', x && x.precinctVotes)) return;
          Object.keys(x.precinctVotes).forEach(function (pn) { count(r, p + '.candidates[' + i + '].precinctVotes[' + JSON.stringify(pn) + ']', x.precinctVotes[pn]); });
        });
      });
    },
    'manifest.json': function (r, d) {
      if (typeof d.dataVersion !== 'string' || !VERSION_RE.test(d.dataVersion)) r.fail('dataVersion', 'expected 12 hex characters');
      str(r, 'updatedAt', d.updatedAt);
      if (!obj(r, 'files', d.files)) return;
      Object.keys(d.files).forEach(function (k) {
        if (!/^[0-9a-f]{64}$/.test(String(d.files[k]))) r.fail('files.' + k, 'expected a sha256');
      });
    },
  };

  function validateFile(name, data) {
    var r = new Report();
    if (!VALIDATORS[name]) r.fail(name, 'unknown file');
    else if (!isObj(data)) r.fail(name, 'expected a JSON object');
    else VALIDATORS[name](r, data);
    return r.result();
  }

  /** files: { 'summary.json': obj, ... } — only the ones this page fetched. */
  function validateSet(manifest, files) {
    var r = new Report();
    var m = validateFile('manifest.json', manifest);
    m.errors.forEach(function (e) { r.fail('manifest.json', e); });
    Object.keys(files).forEach(function (name) {
      validateFile(name, files[name]).errors.forEach(function (e) { r.fail(name, e); });
      var v = files[name] && files[name].metadata && files[name].metadata.dataVersion;
      if (m.ok && v !== manifest.dataVersion) r.fail(name, 'dataVersion ' + v + ' does not match the manifest ' + manifest.dataVersion);
    });
    return r.result();
  }

  return { validateFile: validateFile, validateSet: validateSet, MAX_ERRORS: MAX_ERRORS };
}));
