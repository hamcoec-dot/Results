'use strict';
/**
 * Automated checks on a draft (plan: "Robust review before publish" › Automated checks).
 *
 * Every check is {key, id, severity, title, detail, refs}; key (id:n) is unique within a draft and is
 * what an acknowledgement names (drafts never change, so keys are stable):
 *   block  publishing is impossible; fix the export and upload again
 *   warn   must be acknowledged one by one before publishing
 *   info   size of the change, at a glance
 * refs point the review screen at what to show: [{contest}] / [{precinct}] / [{contest, candidate}].
 *
 * Severity decisions that differ from the first plan, made on the real exports in Test_Files/:
 *   - overvote (votes > ballots x vote-for) and ballots > registered are WARN, not block: in the real
 *     8-column exports the STATISTICS ballots leave out early votes that the contest rows include
 *     (EV test: 1,224 precinct rows "over"; ED test: WALDEN 399 + 585 governor votes on 325 ballots).
 *     A block would stop a legitimate election-night file.
 *   - a date the parser cannot read is a warn; a date it reads and that differs is a block.
 *   - reporting-mismatch is a WARN (user decision, 2026-10-21): the CSV's count is still published,
 *     and the reviewer must acknowledge which precincts are flagged before publishing.
 */
const { pyStrip, pyInt } = require('./pycompat');
const { voteForNumber } = require('./merge');
const { cleanContestName, parseReporting } = require('./parse');
const { eachContestBlock, candidateColumns } = require('./verify');
const { validateFile } = require('./validate');

const REPORTING_MISMATCH_SEVERITY = 'warn';
const KINDS = ['zero', 'early', 'ed'];

/** Every check id this module can emit (TESTING.md: each must have a test). */
const CHECK_IDS = Object.freeze([
  'unreadable', 'not-custom-table-report', 'no-contests', 'no-statistics', 'verify-failed', 'date-mismatch',
  'reporting-over-cap', 'reporting-over-total', 'reporting-inconsistent', 'reporting-mismatch', 'negative-votes', 'non-numeric-cell',
  'zero-file-has-votes', 'output-invalid',
  'date-unreadable', 'title-mismatch', 'precinct-count', 'overvote', 'ballots-over-registered', 'reporting-decreased',
  'votes-decreased', 'contest-added', 'contest-removed', 'candidate-added', 'candidate-removed', 'leader-changed',
  'close-race', 'ed-none-reporting', 'early-has-reporting', 'duplicate-upload', 'no-change', 'turnout-high',
  'status-changed', 'older-export', 'rollback', 'settings-changed',
  'summary',
]);

const mk = (id, severity, title, detail, refs = []) => ({ id, severity, title, detail, refs });
const entries = (m) => (m instanceof Map ? [...m.entries()] : Object.entries(m));
const fmt = (n) => Number(n).toLocaleString('en-US');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "November 3, 2026" | "6-Aug-26" | "2026-11-03" | "11/3/2026" -> "2026-11-03", or null. */
function normalizeDate(text) {
  const s = pyStrip(String(text ?? '')).toLowerCase();
  const month = (name) => MONTHS.findIndex((m) => m.startsWith(name) && name.length >= 3) + 1;
  const iso = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return m >= 1 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  const year = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  let m = /^([a-z]+)\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) return iso(Number(m[3]), month(m[1]), Number(m[2]));
  m = /^(\d{1,2})-([a-z]+)-(\d{2}|\d{4})$/.exec(s);
  if (m) return iso(year(m[3]), month(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) return iso(year(m[3]), Number(m[1]), Number(m[2]));
  return null;
}

/** The two leading candidates' margin when it is under 0.5 % of the contest's votes or under 10 votes. */
function closeMargin(contest) {
  const vf = voteForNumber(contest.voteFor);
  const votes = contest.candidates.map((c) => c.votes).sort((a, b) => b - a);
  if (votes.length <= vf || contest.totalVotes <= 0 || votes[vf - 1] <= 0) return null;
  const margin = votes[vf - 1] - votes[vf];
  return margin < 10 || margin / contest.totalVotes < 0.005 ? margin : null;
}

/** Contest title -> every [R, T] its "R of T Precincts Reporting" headers state, in file order. */
function reportingHeaders(rows) {
  const out = new Map();
  eachContestBlock(rows, (i, cells, contestRow) => {
    for (const [col, text] of cells) {
      const title = cleanContestName(contestRow[col] ? pyStrip(contestRow[col]) : '');
      const rt = parseReporting(text);
      if (!title || !rt) continue;
      if (!out.has(title)) out.set(title, []);
      out.get(title).push(rt);
    }
  });
  return out;
}

/** Cells that should hold a whole, non-negative count but do not: [{row, col, value, kind}]. */
function badNumberCells(rows) {
  const out = [];
  const inspect = (r, c, raw) => {
    const s = pyStrip(raw ?? '');
    if (s === '') return;
    const n = pyInt(s.replaceAll(',', ''));
    if (n === null) out.push({ row: r, col: c, value: s, kind: 'non-numeric' });
    else if (n < 0) out.push({ row: r, col: c, value: s, kind: 'negative' });
  };
  eachContestBlock(rows, (i, cells, contestRow, candidateRow, totalsIdx) => {
    if (totalsIdx === null) return;
    cells.forEach(([col], k) => {
      const nextCol = k + 1 < cells.length ? cells[k + 1][0] : candidateRow.length;
      for (const [c] of candidateColumns(candidateRow, col, nextCol)) {
        for (let d = i + 2; d <= totalsIdx; d++) if (rows[d][0] && pyStrip(rows[d][0])) inspect(d, c, rows[d][c]);
      }
    });
  });
  return out;
}

/**
 * @param {object} a
 * @param {'zero'|'early'|'ed'} a.kind      the uploaded file's slot kind
 * @param {string[][]} a.rows               the uploaded file's rows
 * @param {object} a.result                 buildResults() output for the draft
 * @param {object|null} a.current           currently published `latest` (data.js), or null
 * @param {{name: string, date: string, precinctCap: number}} a.election
 * @param {{sha256: string, lastModified?: number}} a.upload
 * @param {{uploadSha256s?: string[], lastPublishedFileTime?: number}} [a.history]
 * @param {{before: object|null, after: object}|null} [a.settingsChange]  a settings rebuild: published vs new page config
 * @returns {object[]} checks, blocks first
 */
function runChecks({ kind, rows, result, current = null, election, upload, history = {}, settingsChange = null }) {
  if (!KINDS.includes(kind)) throw new TypeError(`unknown upload kind ${kind}`);
  const out = [];
  const add = (...a) => out.push(mk(...a));
  const parsed = kind === 'ed' ? result?.parsed.ed : result?.parsed.early;

  // --- the file itself
  if ((rows[0]?.[0] ?? '') !== 'Custom Table Report') {
    add('not-custom-table-report', 'block', 'Not a Custom Table Report', `Row 1 starts with "${rows[0]?.[0] ?? ''}", expected "Custom Table Report". Export the Custom Table Report from the tally system.`);
  }
  if (!parsed) {
    add('unreadable', 'block', 'File could not be read', 'The file has fewer than 5 rows.');
    return order(out);
  }
  if (parsed.contestsRaw.size === 0) add('no-contests', 'block', 'No contests found', 'No "Precincts Reporting" rows were found.');
  if (!rows.some((r) => r.some((c) => c.includes('STATISTICS')))) add('no-statistics', 'block', 'STATISTICS block missing', 'The turnout (STATISTICS) section is missing from the export.');

  const merged = result.merged;
  const failed = result.verify.filter((c) => !c.pass);
  if (failed.length) {
    add('verify-failed', 'block', `Independent verification failed (${failed.length})`,
      failed.slice(0, 20).map((c) => c.detail).join('\n') + (failed.length > 20 ? `\n… and ${failed.length - 20} more` : ''));
  }

  // The pages refuse data that fails validate.js; never publish something they would reject.
  const invalid = ['summary.json', 'reporting.json', 'precincts.json']
    .flatMap((f) => validateFile(f, JSON.parse(result.outputs.files[f])).errors.map((e) => `${f} ${e}`));
  if (invalid.length) add('output-invalid', 'block', 'Published files would be rejected by the results pages', invalid.slice(0, 20).join('\n'));

  const fileDate = normalizeDate(parsed.electionDate);
  const setDate = normalizeDate(election.date);
  if (fileDate === null || setDate === null) {
    add('date-unreadable', 'warn', 'Election date not recognised', `File: "${parsed.electionDate}". Election settings: "${election.date}". Check they are the same day.`);
  } else if (fileDate !== setDate) {
    add('date-mismatch', 'block', 'Election date does not match', `File says ${parsed.electionDate} (${fileDate}); this election is ${setDate}. Wrong election's export?`);
  }

  // Every "R of T" header, page repeats included (the parser keeps the first one per contest).
  const headers = reportingHeaders(rows);
  for (const [title, list] of headers) {
    const r = Math.max(...list.map((x) => x[0]));
    const bad = list.find(([a, b]) => a > b);
    if (r > election.precinctCap) add('reporting-over-cap', 'block', 'More precincts reporting than the county has', `${title}: ${r} reporting, max precincts is ${election.precinctCap}.`, [{ contest: title }]);
    if (bad) add('reporting-over-total', 'block', 'Reporting count above its total', `${title}: "${bad[0]} of ${bad[1]}".`, [{ contest: title }]);
    if (new Set(list.map((x) => x.join(' of '))).size > 1) {
      add('reporting-inconsistent', 'block', 'Pages of one contest disagree on precincts reporting',
        `${title}: ${[...new Set(list.map((x) => x.join(' of ')))].join(' vs ')}. Re-export the report.`, [{ contest: title }]);
    }
  }
  for (const m of result.diagnostics.reportingMismatches) {
    add('reporting-mismatch', REPORTING_MISMATCH_SEVERITY, 'Reported precincts do not match the count',
      `${m.contest}: the file says ${m.csvReporting} reporting, but ${m.inferred.length} precinct(s) are listed as reported${m.inferred.length ? `: ${m.inferred.join(', ')}` : ''}`
        + `${m.marked?.length ? ` (marked by an admin: ${m.marked.join(', ')})` : ''}. `
        + (m.inferred.length < m.csvReporting
          ? 'A precinct that reported with no new Election Day votes is listed as Pending; mark it as reported under "Precincts reporting" on the admin page.'
          : m.marked?.length ? 'Check the precincts marked as reported on the admin page.' : 'More precincts have new votes than the file counts; check the export.'),
      [{ contest: m.contest }]);
  }

  const bad = badNumberCells(rows);
  const neg = bad.filter((b) => b.kind === 'negative');
  const nonNum = bad.filter((b) => b.kind === 'non-numeric');
  const cellList = (list) => list.slice(0, 10).map((b) => `row ${b.row + 1}, column ${b.col + 1}: "${b.value}"`).join('\n');
  if (neg.length) add('negative-votes', 'block', 'Negative vote counts', cellList(neg));
  if (nonNum.length) add('non-numeric-cell', 'block', 'Vote cells that are not whole numbers', cellList(nonNum));

  if (kind === 'zero') {
    const nonzero = merged.totalBallots > 0 || merged.contests.some((c) => c.totalVotes > 0);
    if (nonzero) add('zero-file-has-votes', 'block', 'Zero file contains votes', `Total ballots ${fmt(merged.totalBallots)}; a Zero report must be all zeros. Was the wrong kind chosen?`);
  }

  // --- plausibility (warn)
  if (pyStrip(parsed.electionTitle).toLowerCase() !== pyStrip(election.name ?? '').toLowerCase()) {
    add('title-mismatch', 'warn', 'Title differs from the election name', `File: "${parsed.electionTitle}". Election: "${election.name}".`);
  }
  const nPrecincts = merged.masterPrecincts.length;
  if (nPrecincts !== election.precinctCap) {
    add('precinct-count', 'warn', 'Precinct count differs from max precincts', `The file lists ${nPrecincts} precincts; max precincts is ${election.precinctCap}.`);
  }
  // Grouped (one acknowledgement) — the real exports trip this per contest; see the header.
  const over = merged.contests.filter((c) => merged.totalBallots > 0 && c.totalVotes > merged.totalBallots * voteForNumber(c.voteFor));
  if (over.length) {
    add('overvote', 'warn', `More votes than ballots allow (${over.length} contest${over.length > 1 ? 's' : ''})`,
      over.map((c) => `${c.title}: ${fmt(c.totalVotes)} votes, ${fmt(merged.totalBallots)} ballots x ${voteForNumber(c.voteFor)}`).join('\n'),
      over.map((c) => ({ contest: c.title })));
  }
  const overReg = entries(merged.precinctStats).filter(([, s]) => s.ballots > s.voters);
  if (overReg.length) {
    add('ballots-over-registered', 'warn', 'Precincts with more ballots than registered voters',
      overReg.slice(0, 10).map(([p, s]) => `${p}: ${fmt(s.ballots)} ballots, ${fmt(s.voters)} registered`).join('\n'), overReg.map(([p]) => ({ precinct: p })));
  }
  if (merged.turnoutPercent > 100) add('turnout-high', 'warn', 'Turnout above 100 %', `County turnout ${merged.turnoutPercent} %.`);
  const hot = entries(merged.precinctStats).filter(([, s]) => s.voters > 0 && s.ballots <= s.voters && s.ballots / s.voters > 0.95);
  if (hot.length) add('turnout-high', 'warn', 'Precinct turnout above 95 %', hot.map(([p, s]) => `${p}: ${s.turnoutPercent} %`).join('\n'), hot.map(([p]) => ({ precinct: p })));

  const maxReporting = Math.max(0, ...[...headers.values()].flat().map(([r]) => r));
  if (kind === 'ed' && maxReporting === 0) add('ed-none-reporting', 'warn', 'Election Day file with no precincts reporting', 'Every contest says 0 precincts reporting. Was this meant as an Early/ABS upload?');
  if (kind !== 'ed' && maxReporting > 0) add('early-has-reporting', 'warn', `${kind === 'zero' ? 'Zero' : 'Early/ABS'} file has precincts reporting`, `Up to ${maxReporting} precincts reporting. Was this meant as an Election Day upload?`);

  const close = merged.contests.map((c) => [c, closeMargin(c)]).filter(([, m]) => m !== null);
  if (close.length) {
    add('close-race', 'warn', `Close race${close.length > 1 ? `s (${close.length})` : ''}`,
      close.map(([c, m]) => `${c.title}: margin ${fmt(m)} vote(s)`).join('\n'), close.map(([c]) => ({ contest: c.title })));
  }

  if ((history.uploadSha256s ?? []).includes(upload.sha256)) add('duplicate-upload', 'warn', 'This exact file was uploaded before', `sha256 ${upload.sha256.slice(0, 12)}…`);
  if (upload.lastModified && history.lastPublishedFileTime && upload.lastModified < history.lastPublishedFileTime) {
    add('older-export', 'warn', 'File is older than the last published file',
      `This file was saved ${new Date(upload.lastModified).toISOString()}; the last published one ${new Date(history.lastPublishedFileTime).toISOString()}.`);
  }

  const marked = election.markedReported ?? [];
  if (marked.length) {
    add('marked-reported', 'info', 'Precincts marked as reported by an admin',
      `${marked.join(', ')}. ${result?.parsed.ed ? 'Each is listed as reported in every contest it is in.' : 'These apply once an Election Day file is in use.'}`);
  }
  if (settingsChange) add('settings-changed', 'info', 'Settings change: the same files, rebuilt', describeSettingsChange(settingsChange));
  if (current) compareWithCurrent(merged, current, add);
  return order(out);
}

const SETTING_LABELS = { precinctCap: 'Max precincts', enablePrecinctResults: 'Precinct Results page' };
const settingText = (k, v) => (k === 'enablePrecinctResults' ? (v === false ? 'hidden' : 'shown') : String(v));

/** "Max precincts: 92 → 94. Precinct Results page: shown → hidden." for a settings rebuild. */
function describeSettingsChange({ before, after }) {
  const keys = Object.keys(SETTING_LABELS);
  if (!before) return `No settings were published before. Publishing: ${keys.map((k) => `${SETTING_LABELS[k]} ${settingText(k, after[k])}`).join(', ')}.`;
  const changed = keys.filter((k) => settingText(k, before[k] ?? (k === 'precinctCap' ? 92 : true)) !== settingText(k, after[k]));
  if (!changed.length) return 'No page settings (max precincts, Precinct Results page) differ from what is published.';
  return changed.map((k) => `${SETTING_LABELS[k]}: ${settingText(k, before[k] ?? (k === 'precinctCap' ? 92 : true))} → ${settingText(k, after[k])}.`).join(' ');
}

function compareWithCurrent(draft, current, add) {
  if (draft.dataVersion === current.dataVersion) add('no-change', 'warn', 'No change from what is published', `Data version ${draft.dataVersion} is already live.`);
  if (draft.statusLabel !== current.statusLabel) add('status-changed', 'warn', 'Status label changed', `"${current.statusLabel}" → "${draft.statusLabel}".`);
  if (draft.overallPrecinctsReporting < current.overallPrecinctsReporting) {
    add('reporting-decreased', 'warn', 'Precincts reporting went down', `${current.overallPrecinctsReporting} → ${draft.overallPrecinctsReporting}.`);
  }
  if (draft.totalBallots < current.totalBallots) add('votes-decreased', 'warn', 'Total ballots went down', `${fmt(current.totalBallots)} → ${fmt(draft.totalBallots)}.`);

  const cur = new Map(current.contests.map((c) => [c.title, c]));
  const nxt = new Map(draft.contests.map((c) => [c.title, c]));
  // Per-contest decreases are one grouped warning per kind, like close races.
  const fewer = [], contestDown = [], candidateDown = [];
  let changed = 0;
  for (const [title, c] of nxt) {
    const old = cur.get(title);
    if (!old) { add('contest-added', 'warn', 'Contest added', title, [{ contest: title }]); continue; }
    if (c.precinctsReporting < old.precinctsReporting) fewer.push([title, old.precinctsReporting, c.precinctsReporting]);
    if (c.totalVotes < old.totalVotes) contestDown.push([`${title}: ${fmt(old.totalVotes)} → ${fmt(c.totalVotes)}`, { contest: title }]);
    const oc = new Map(old.candidates.map((x) => [x.name, x]));
    const nc = new Map(c.candidates.map((x) => [x.name, x]));
    for (const [name, x] of nc) {
      const o = oc.get(name);
      if (!o) add('candidate-added', 'warn', 'Candidate added', `${title}: ${name}`, [{ contest: title, candidate: name }]);
      else if (x.votes < o.votes) candidateDown.push([`${title} / ${name}: ${fmt(o.votes)} → ${fmt(x.votes)}`, { contest: title, candidate: name }]);
    }
    for (const name of oc.keys()) if (!nc.has(name)) add('candidate-removed', 'warn', 'Candidate removed', `${title}: ${name}`, [{ contest: title, candidate: name }]);
    const leaders = (list) => list.filter((x) => x.isLeading).map((x) => x.name).sort().join(' + ');
    if (old.totalVotes > 0 && c.totalVotes > 0 && leaders(old.candidates) !== leaders(c.candidates)) {
      add('leader-changed', 'warn', 'Leader changed', `${title}: ${leaders(old.candidates) || 'none'} → ${leaders(c.candidates) || 'none'}.`, [{ contest: title }]);
    }
    if (c.totalVotes !== old.totalVotes || c.precinctsReporting !== old.precinctsReporting) changed++;
  }
  for (const title of cur.keys()) if (!nxt.has(title)) add('contest-removed', 'warn', 'Contest removed', title, [{ contest: title }]);
  if (fewer.length) {
    add('reporting-decreased', 'warn', `Contest${fewer.length > 1 ? `s (${fewer.length})` : ''} with fewer precincts reporting`,
      fewer.map(([t, was, now]) => `${t}: ${was} → ${now}`).join('\n'), fewer.map(([t]) => ({ contest: t })));
  }
  const grouped = (rows, one, many) => {
    if (rows.length) add('votes-decreased', 'warn', rows.length > 1 ? `${many} (${rows.length})` : one, rows.map(([line]) => line).join('\n'), rows.map(([, ref]) => ref));
  };
  grouped(contestDown, 'Contest total went down', 'Contest totals that went down');
  grouped(candidateDown, 'Candidate total went down', 'Candidate totals that went down');
  add('summary', 'info', 'Size of this update',
    `${changed} of ${nxt.size} contests changed; precincts reporting ${current.overallPrecinctsReporting} → ${draft.overallPrecinctsReporting} of ${draft.overallPrecinctsTotal}; ballots ${fmt(current.totalBallots)} → ${fmt(draft.totalBallots)}.`);
}

const RANK = { block: 0, warn: 1, info: 2 };
function order(checks) {
  const seen = new Map();
  return checks.map((c, i) => [c, i])
    .sort((a, b) => RANK[a[0].severity] - RANK[b[0].severity] || a[1] - b[1])
    .map(([c]) => {
      const n = seen.get(c.id) ?? 0;
      seen.set(c.id, n + 1);
      return { key: `${c.id}:${n}`, ...c };
    });
}

/**
 * Checks for a rollback draft: an earlier version's exact files, so no CSV checks apply. The pages
 * must still accept the files, every difference from what is live is listed, and the rollback
 * itself must be acknowledged.
 * @param {{latest: object, files: object, current: object|null, version: string, publishedAt?: string}} a
 */
function runRollbackChecks({ latest, files, current, version, publishedAt }) {
  const out = [];
  const add = (...a) => out.push(mk(...a));
  add('rollback', 'warn', 'This is a rollback', `Republishing version ${version}${publishedAt ? ` (first published ${publishedAt})` : ''}. Every number below reverts to it.`);
  const invalid = ['summary.json', 'reporting.json', 'precincts.json']
    .flatMap((f) => validateFile(f, JSON.parse(files[f])).errors.map((e) => `${f} ${e}`));
  if (invalid.length) add('output-invalid', 'block', 'Published files would be rejected by the results pages', invalid.slice(0, 20).join('\n'));
  if (current) compareWithCurrent(latest, current, add);
  return order(out);
}

/** A file that could not be read at all (CsvError / ParseError from the pipeline). */
function unreadableCheck(err) {
  return order([mk('unreadable', 'block', 'File could not be read', `${err.message}. Re-export the Custom Table Report and upload it again.`)])[0];
}

module.exports = { runChecks, runRollbackChecks, unreadableCheck, normalizeDate, closeMargin, badNumberCells, describeSettingsChange, CHECK_IDS, REPORTING_MISMATCH_SEVERITY };
