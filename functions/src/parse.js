'use strict';
/**
 * Port of convert_data.parse_election_csv (convert_data.py:40) and its helpers.
 *
 * Ordered collections are Maps so iteration order matches Python dicts even for keys such as "12",
 * which a plain object would move to the front.
 *
 * Legacy defects are fixed behind `fixes` flags (see TESTING.md). FIXES is the production default;
 * LEGACY reproduces the Python output exactly and is used only by the parity tests.
 *   d1  ED files no longer mark every listed precinct reported; merge.js infers it (see there).
 *   d2  county and status come from the last non-empty header cell, not column 4.
 *   d3  STATISTICS rows of the 5-column export (5 cells, 3 on continuation pages) are read.
 */
const { PY_WS, pyStrip, pyLowerChars, pyInt, pyIntBig, pyTrueDiv, pyFloat, pyRound2 } = require('./pycompat');
const { readCsv } = require('./csv');

const FIXES = Object.freeze({ d1: true, d2: true, d3: true });
const LEGACY = Object.freeze({ d1: false, d2: false, d3: false });

/** Raised where the legacy parser raises (an IndexError on a malformed header). */
class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

/** convert_data.clean_num */
function cleanNum(val) {
  const clean = pyStrip(String(val ?? '').replaceAll(',', ''));
  const n = clean.includes('.') ? pyFloat(clean) : pyInt(clean);
  return n ?? 0;
}

/** clean_num's int, exactly (BigInt), when the cell is an int; null for a float or unreadable cell. */
function cleanIntExact(val) {
  const clean = pyStrip(String(val ?? '').replaceAll(',', ''));
  return clean.includes('.') ? null : pyIntBig(clean);
}

/**
 * ballots / voters as convert_data.py computes it. Two ints divide exactly in Python, so when either
 * is past 2^53 (and so rounded as a Number) the cells are divided as BigInts instead.
 */
function statsRatio(ballotsCell, votersCell, ballots, voters) {
  if (Number.isSafeInteger(ballots) && Number.isSafeInteger(voters)) return ballots / voters;
  const a = cleanIntExact(ballotsCell);
  const b = cleanIntExact(votersCell);
  return a !== null && b !== null ? pyTrueDiv(a, b) : ballots / voters;
}

/** A STATISTICS row's turnout: round(ballots / voters * 100, 2), 0 when there are no voters. */
function statsTurnout(ballotsCell, votersCell) {
  const voters = cleanNum(votersCell);
  const ballots = cleanNum(ballotsCell);
  return voters > 0 ? pyRound2(statsRatio(ballotsCell, votersCell, ballots, voters) * 100) : 0;
}

// Python's \w and \b for str patterns (Unicode letters, numbers, underscore); '.' excludes only \n.
const W = '[\\p{L}\\p{N}_]';
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const S = `[${PY_WS}]`;
// re.IGNORECASE compares backreferences by lower() of each character, which JS's /i (case
// folding) does not: 'ς' vs 'Σ', 'ſ' vs 's'. So both patterns run case-sensitively on a lowercased
// copy (pyLowerChars keeps every index) and the groups are cut from the original.
const DUP_PHRASE = new RegExp(`${B}([^\\n]+?)${S}+\\1${B}`, 'gu');
const WRAPPED = new RegExp(`^(${W}+)${S}+([^\\n]+?)${S}+\\1$`, 'du');
const WS_RUN = new RegExp(`${S}+`, 'gu');
const MAX_TITLE = 1000; // the patterns backtrack super-linearly; real titles are under 120 chars

/** convert_data.clean_contest_name: "District 28 District 28" -> "District 28". */
function cleanContestName(name) {
  if (!name) return '';
  const original = pyStrip(name);
  if (original.length > MAX_TITLE) throw new ParseError(`Contest title longer than ${MAX_TITLE} characters`);
  let cleaned = '';
  let at = 0;
  for (const m of pyLowerChars(original).matchAll(DUP_PHRASE)) {
    cleaned += original.slice(at, m.index) + original.substr(m.index, m[1].length);
    at = m.index + m[0].length;
  }
  cleaned += original.slice(at);
  const m = WRAPPED.exec(pyLowerChars(cleaned));
  if (m) cleaned = `${cleaned.slice(0, m[1].length)} ${cleaned.slice(...m.indices[2])}`;
  return pyStrip(cleaned.replace(WS_RUN, ' '));
}

const ND = '\\p{Nd}+';
const REPORTING = new RegExp(`(${ND})${S}+of${S}+(${ND})${S}+(?:Election${S}+Day${S}+)?Precincts${S}+Reporting`, 'iu');

/** "R of T Precincts Reporting" -> [R, T], or null. */
function parseReporting(text) {
  const m = REPORTING.exec(text);
  return m ? [pyInt(m[1]), pyInt(m[2])] : null;
}

const STATS_SKIP_0 = new Set(['Custom Table Report', 'STATISTICS', 'Totals', 'Precincts Reporting', 'Registered Voters - Total']);
const STATS_SKIP_1 = new Set(['STATISTICS', 'Totals', 'Registered Voters - Total']);
const STATS_SKIP_WORDS = ['August', 'State', 'Federal', 'County', 'General', 'Primary'];

/** Last non-empty cell after column 0 (d2), else the legacy column-4 cell; null means "use the default". */
function headerCell(row, fixes) {
  if (fixes.d2) {
    for (let k = row.length - 1; k >= 1; k--) if (pyStrip(row[k])) return pyStrip(row[k]);
    return null;
  }
  return row[4] ? pyStrip(row[4]) : null; // legacy: a blank-but-present cell gives ''
}

function partyOf(contestName, candRaw) {
  const upper = contestName.toUpperCase();
  let party = upper.startsWith('REP') ? 'REP' : upper.startsWith('DEM') ? 'DEM' : 'IND';
  let name = candRaw;
  if (candRaw.startsWith('REP ')) { party = 'REP'; name = pyStrip(candRaw.slice(4)); }
  else if (candRaw.startsWith('DEM ')) { party = 'DEM'; name = pyStrip(candRaw.slice(4)); }
  else if (candRaw.startsWith('IND ')) { party = 'IND'; name = pyStrip(candRaw.slice(4)); }
  else if (candRaw.toUpperCase().includes('NO CANDIDATE')) {
    name = 'No Candidate Qualified';
    if (upper.startsWith('REP')) party = 'REP';
    else if (upper.startsWith('DEM')) party = 'DEM';
  }
  return { party, name };
}

/** Index of the next "Totals" row at or after `from`, or null. */
function findTotals(rows, from) {
  for (let r = from; r < rows.length; r++) if (rows[r][0] === 'Totals') return r;
  return null;
}

/**
 * [precinct name, index of its voters cell] for a STATISTICS row, or null. First-page rows put the
 * name in column 1, continuation pages in column 0; minimum row lengths are min0 / min1 (d3).
 * Column-0 names containing a header word are skipped (legacy: repeated page titles).
 */
function statsRowName(row, min0, min1) {
  const c0 = pyStrip(row[0]);
  if (row.length >= min0 && c0 && !STATS_SKIP_0.has(c0)) {
    return STATS_SKIP_WORDS.some((k) => row[0].includes(k)) ? null : [c0, 1];
  }
  const c1 = pyStrip(row[1] ?? '');
  return row.length >= min1 && c1 && !STATS_SKIP_1.has(c1) ? [c1, 2] : null;
}

function parseStats(rows, fixes) {
  const [min0, min1] = fixes.d3 ? [3, 4] : [6, 7];
  const stats = new Map();
  let inStats = false;
  for (const row of rows) {
    if (row.length === 0) continue;
    if (row[0] === 'Totals' && inStats) break;
    if (row.some((cell) => cell.includes('STATISTICS'))) { inStats = true; continue; }
    if (!inStats) continue;

    const at = statsRowName(row, min0, min1);
    if (!at) continue;
    const [name, v] = at;
    const voters = cleanNum(row[v]);
    const ballots = cleanNum(row[v + 1]);
    if (voters > 0 || ballots > 0) {
      stats.set(name, {
        name,
        voters,
        ballots,
        rep: cleanNum(row[v + 2]),
        dem: cleanNum(row[v + 3]),
        gen: cleanNum(row[v + 4]),
        turnoutPercent: statsTurnout(row[v + 1], row[v]),
      });
    }
  }
  return stats;
}

function parseContests(rows, isEd, fixes) {
  const contests = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const reportingCells = [];
    row.forEach((cell, idx) => { if (cell.includes('Precincts Reporting')) reportingCells.push([idx, cell]); });
    if (reportingCells.length === 0) continue;

    const contestRow = rows[i - 2] ?? [];
    const voteForRow = rows[i - 1] ?? [];
    const candidateRow = rows[i + 1] ?? [];
    const totalsIdx = findTotals(rows, i + 2);

    reportingCells.forEach(([col, repText], k) => {
      const contestName = cleanContestName(contestRow[col] ? pyStrip(contestRow[col]) : '');
      const voteFor = voteForRow[col] ? pyStrip(voteForRow[col]) : 'VOTE FOR 1';
      if (!contestName) return;

      const rep = parseReporting(repText);
      const pRep = rep && isEd ? rep[0] : 0;
      const pTot = rep ? rep[1] : 0;
      const nextCol = k + 1 < reportingCells.length ? reportingCells[k + 1][0] : candidateRow.length;

      if (!contests.has(contestName)) {
        contests.set(contestName, {
          title: contestName,
          voteFor,
          candidates: new Map(),
          precinctsStatusMap: new Map(),
          csvPrecinctsReporting: pRep,
          csvPrecinctsTotal: pTot,
        });
      }
      const contest = contests.get(contestName);

      const candCols = [];
      for (let c = col; c < Math.min(nextCol, candidateRow.length); c++) {
        const candRaw = pyStrip(candidateRow[c]);
        if (!candRaw || candRaw.toLowerCase().includes('write-in')) continue;
        const { party, name } = partyOf(contestName, candRaw);
        const votes = cleanNum(rows[totalsIdx]?.[c]);
        const existing = contest.candidates.get(name);
        if (!existing) contest.candidates.set(name, { name, party, votes, precinctVotes: new Map() });
        else existing.votes = Math.max(existing.votes, votes);
        candCols.push([c, name]);
      }

      if (totalsIdx === null) return;
      for (let d = i + 2; d < totalsIdx; d++) {
        const dRow = rows[d];
        const pName = dRow[0] ? pyStrip(dRow[0]) : '';
        if (!pName) continue;
        let hasEntry = false;
        for (const [c, name] of candCols) {
          const cell = pyStrip(dRow[c] ?? '');
          if (cell !== '') {
            hasEntry = true;
            contest.candidates.get(name).precinctVotes.set(pName, cleanNum(cell));
          }
        }
        if (hasEntry) {
          if (!contest.precinctsStatusMap.has(pName)) contest.precinctsStatusMap.set(pName, false);
          if (isEd && !fixes.d1) contest.precinctsStatusMap.set(pName, true);
        }
      }
    });
    // Python: `i = totals_row_idx if totals_row_idx else i + 1`, then `i += 1` (so no Totals skips a row).
    i = totalsIdx ?? i + 1;
  }
  return contests;
}

/**
 * Parse already-read CSV rows.
 * @param {string[][]} rows
 * @param {{isEd?: boolean, fixes?: object}} [opts]
 * @returns {object|null} null when the file has fewer than 5 rows (as the legacy parser)
 */
function parseRows(rows, { isEd = false, fixes = FIXES } = {}) {
  if (!rows || rows.length < 5) return null;
  if (rows[1].length === 0 || rows[2].length === 0) {
    throw new ParseError('Header rows 2-3 are empty: not a Custom Table Report');
  }

  const totalsRow = rows.find((r) => r[0] === 'Totals');
  const tot = (k) => cleanNum(totalsRow?.[k]);

  return {
    isEd,
    electionTitle: rows[1][0] ? pyStrip(rows[1][0]) : 'General Election',
    electionDate: rows[2][0] ? pyStrip(rows[2][0]) : '',
    county: headerCell(rows[2], fixes) ?? 'Hamilton',
    statusLabel: headerCell(rows[0], fixes) ?? 'UNOFFICIAL RESULTS',
    totalVoters: tot(1),
    totalBallots: tot(2),
    ballotsRep: tot(3),
    ballotsDem: tot(4),
    ballotsGen: tot(5),
    precinctStats: parseStats(rows, fixes),
    contestsRaw: parseContests(rows, isEd, fixes),
  };
}

/** Parse a CSV export (bytes or text). */
function parseElectionCsv(input, opts) {
  return parseRows(readCsv(input), opts);
}

module.exports = {
  parseElectionCsv, parseRows, cleanNum, cleanContestName, parseReporting, findTotals, partyOf, statsRowName, statsTurnout,
  ParseError, FIXES, LEGACY,
};
