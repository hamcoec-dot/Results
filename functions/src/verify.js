'use strict';
/**
 * Port of verify.run_verification (verify.py:36): an independent re-read of the source CSVs that
 * audits the merged dataset (oracle 2). Instead of printing, it returns [{name, pass, detail}];
 * `detail` is verify.py's message text, so legacy-mode results equal the golden verify.json.
 *
 * With fixes on, the audit expects the fixed behaviour: county from the last header cell (d2),
 * precinct stats from 5-column exports (d3), and each contest's precinctsReporting equal to its
 * CSV "R of T" (d1) rather than the legacy overrides.
 */
const { pyStrip, pyRound2, pyStrFloat } = require('./pycompat');
const { cleanNum, cleanContestName, parseReporting, findTotals, statsRowName, stripPrefixes, FIXES } = require('./parse');

/** Visits every contest block: cb(i, reportingCells, contestRow, candidateRow, totalsIdx). */
function eachContestBlock(rows, cb) {
  for (let i = 0; i < rows.length; i++) {
    const cells = [];
    rows[i].forEach((cell, idx) => { if (cell.includes('Precincts Reporting')) cells.push([idx, cell]); });
    if (!cells.length) continue;
    const totalsIdx = findTotals(rows, i + 2);
    cb(i, cells, rows[i - 2] ?? [], rows[i + 1] ?? [], totalsIdx);
    i = totalsIdx ?? i + 1;
  }
}

const rawCell = (row, col) => (row[col] ? pyStrip(row[col]) : '');

const WRITE_IN_SUFFIX = ' (Certified Write-in)';
/**
 * A write-in column's candidate name, read independently of parse.resultColumns (verify is the
 * second reader of the CSV): '' for a column that is not a named write-in. The header is
 * "Write-in" (any case; a space or hyphen, or nothing, between the words), then ":" and the name.
 * "Totals", "Not Assigned" and an empty name are not candidates; a party word before the name is dropped.
 */
function writeInName(raw) {
  const lower = raw.toLowerCase();
  if (!lower.startsWith('write')) return '';
  let i = 5;
  while (i < raw.length && (raw[i] === '-' || /\s/u.test(raw[i]))) i++;
  if (lower.slice(i, i + 2) !== 'in') return '';
  i += 2;
  while (i < raw.length && /\s/u.test(raw[i])) i++;
  if (raw[i] !== ':') return '';
  let name = raw.slice(i + 1).split(/\s+/u).filter(Boolean).join(' ');
  for (const p of ['REP ', 'DEM ', 'IND ']) if (name.startsWith(p)) { name = pyStrip(name.slice(p.length)); break; }
  const l = name.toLowerCase();
  if (!name || l.split(' ').join('') === 'notassigned' || l.includes('write') && /write[\s-]*in/u.test(l)) return '';
  return name;
}

/**
 * Candidate columns of one contest: [[col, name], ...] (party prefix removed). Legacy skips every
 * column containing "write-in"; with fix d6 named write-ins are kept (a name equal to a ballot
 * candidate's gets the " (Certified Write-in)" suffix) and totals / not-assigned columns are not.
 */
function candidateColumns(candidateRow, col, nextCol, fixes = FIXES) {
  const ballot = [];
  const writeIns = [];
  for (let c = col; c < Math.min(nextCol, candidateRow.length); c++) {
    const raw = pyStrip(candidateRow[c] ?? '');
    if (!raw) continue;
    if (!fixes.d6) { if (!raw.toLowerCase().includes('write-in')) ballot.push([c, stripPrefixes(raw)]); continue; }
    if (!/write[\s-]*in/iu.test(raw)) { ballot.push([c, stripPrefixes(raw)]); continue; }
    const name = writeInName(raw);
    if (name) writeIns.push([c, name]);
  }
  const names = new Set(ballot.map(([, n]) => n));
  const out = [...ballot, ...writeIns.map(([c, n]) => [c, names.has(n) ? n + WRITE_IN_SUFFIX : n])];
  return out.sort((a, b) => a[0] - b[0]);
}

function firstTotals(rows) {
  const r = rows.find((x) => x[0] === 'Totals');
  return [cleanNum(r?.[1]), cleanNum(r?.[2])];
}

/** Contest name -> [R, T] as written in the CSV. */
function findAllRawContests(rows) {
  const found = new Map();
  eachContestBlock(rows, (i, cells, contestRow) => {
    for (const [col, repText] of cells) {
      const name = cleanContestName(rawCell(contestRow, col));
      if (!name) continue;
      found.set(name, parseReporting(repText) ?? [0, 0]);
    }
  });
  return found;
}

/** Contest name (uncleaned, as verify.py keys it) -> candidate -> Totals-row votes. */
function extractCandidateVotes(rows, fixes) {
  const res = new Map();
  eachContestBlock(rows, (i, cells, contestRow, candidateRow, totalsIdx) => {
    cells.forEach(([col], k) => {
      const name = rawCell(contestRow, col);
      if (!name) return;
      if (!res.has(name)) res.set(name, new Map());
      const m = res.get(name);
      const nextCol = k + 1 < cells.length ? cells[k + 1][0] : candidateRow.length;
      for (const [c, cand] of candidateColumns(candidateRow, col, nextCol, fixes)) {
        const votes = cleanNum(rows[totalsIdx]?.[c]);
        m.set(cand, Math.max(m.get(cand) ?? 0, votes));
      }
    });
  });
  return res;
}

function rawPrecinctStats(rows, fixes) {
  const [min0, min1] = fixes.d3 ? [3, 4] : [6, 7];
  const out = new Map();
  let inStats = false;
  for (const row of rows) {
    if (!row.length) continue;
    if (row[0] === 'Totals' && inStats) break;
    if (row.some((c) => c.includes('STATISTICS'))) { inStats = true; continue; }
    if (!inStats) continue;
    // verify.py repeats the parser's row matcher verbatim, so the port shares it.
    const at = statsRowName(row, min0, min1);
    if (!at) continue;
    const voters = cleanNum(row[at[1]]);
    const ballots = cleanNum(row[at[1] + 1]);
    if (voters > 0 || ballots > 0) out.set(at[0], { voters, ballots });
  }
  return out;
}

function rawCounty(rows, fixes) {
  const row = rows[2] ?? [];
  if (fixes.d2) {
    for (let k = row.length - 1; k >= 1; k--) if (pyStrip(row[k])) return pyStrip(row[k]);
    return 'Hamilton';
  }
  return row[4] ? pyStrip(row[4]) : 'Hamilton';
}

/**
 * @param {{earlyRows: string[][]|null, edRows: string[][]|null, latest: object, files?: object}} input
 *   latest  the merged dataset (data.js `latest`); files: the buildOutputs() files, if written
 * @param {{precinctCap?: number, fixes?: object}} [opts]
 * @returns {{name: string, pass: boolean, detail: string}[]}
 */
function verify({ earlyRows, edRows, latest: js, files = {} }, { precinctCap = 92, fixes = FIXES } = {}) {
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });
  const early = earlyRows ?? [];
  const ed = edRows ?? [];
  const rows = edRows ?? earlyRows;
  if (!rows) return [{ name: 'input', pass: false, detail: 'Missing primary CSV file' }];

  // 1. Metadata
  const rawTitle = rows[1]?.[0] ? pyStrip(rows[1][0]) : 'General Election';
  const rawDate = rows[2]?.[0] ? pyStrip(rows[2][0]) : '';
  const county = rawCounty(rows, fixes);
  check('files', files['summary.json'] !== undefined, 'summary.json file generated successfully (~15KB)');
  check('files', files['precincts.json'] !== undefined, 'precincts.json file generated successfully (~230KB)');
  check('dataVersion', typeof js.dataVersion === 'string' && js.dataVersion.length > 0, 'Data Revision Hash (dataVersion) generated');
  const nMaster = Array.isArray(js.masterPrecincts) ? js.masterPrecincts.length : 0;
  check('masterPrecincts', nMaster > 0, `Dynamic Master Precinct List built (${nMaster} precincts)`);
  check('title', js.electionTitle === rawTitle, `Election Title matches ('${rawTitle}')`);
  check('date', js.electionDate === rawDate, `Election Date matches ('${rawDate}')`);
  check('county', js.county === county, `County Name matches ('${county}')`);

  // 2. Turnout
  const [earlyVoters, earlyBallots] = firstTotals(early);
  const [edVoters, edBallots] = firstTotals(ed);
  const expVoters = Math.max(earlyVoters, edVoters);
  const expBallots = ed.length ? edBallots : earlyBallots;
  const expTurnout = expVoters > 0 ? pyRound2((expBallots / expVoters) * 100) : 0;
  check('voters', js.totalVoters === expVoters, `Registered Voters count (${js.totalVoters} == ${expVoters})`);
  check('ballots', js.totalBallots === expBallots, `Total Ballots Cast (${js.totalBallots} == ${expBallots})`);
  check('turnout', js.turnoutPercent === expTurnout,
    `Turnout Percentage (${pyStrFloat(js.turnoutPercent)}% == ${pyStrFloat(expTurnout)}%)`);

  // 3. Contests and precinct counts
  const jsContests = new Map(js.contests.map((c) => [c.title, c]));
  const earlyInfo = findAllRawContests(early);
  const edInfo = findAllRawContests(ed);
  const rawFound = new Set([...earlyInfo.keys(), ...edInfo.keys()]);
  const overallComplete = (js.overallPrecinctsReporting ?? 0) >= (js.overallPrecinctsTotal ?? 92);
  for (const name of rawFound) {
    check('contest', jsContests.has(name), `Contest '${name}' present in JS dataset`);
    if (!jsContests.has(name)) continue;
    const c = jsContests.get(name);
    let [pRep, pTot] = ed.length && edInfo.has(name) ? edInfo.get(name) : [0, (earlyInfo.get(name) ?? [0, 0])[1]];
    let expRep = Math.min(pRep, precinctCap);
    const expTot = Math.min(pTot, precinctCap);
    if (!fixes.d1) {
      const fromMap = (c.precinctsStatus ?? []).filter((p) => p.reported).length;
      if (fromMap > expRep) expRep = fromMap;
      if (overallComplete && expTot > 0) expRep = expTot;
    }
    check('precinctsReporting', c.precinctsReporting === expRep, `'${name}' Precincts Reported (${c.precinctsReporting} == ${expRep})`);
    check('precinctsTotal', c.precinctsTotal === expTot, `'${name}' Total Precincts (${c.precinctsTotal} == ${expTot})`);
  }
  check('contestCount', jsContests.size === rawFound.size, `Total contest count matches (${jsContests.size} == ${rawFound.size})`);

  // 4. Candidate totals
  const earlyCands = extractCandidateVotes(early, fixes);
  const edCands = extractCandidateVotes(ed, fixes);
  for (const title of new Set([...earlyCands.keys(), ...edCands.keys()])) {
    if (!jsContests.has(title)) continue;
    const jsCands = new Map(jsContests.get(title).candidates.map((c) => [c.name, c]));
    const e = earlyCands.get(title) ?? new Map();
    const d = edCands.get(title) ?? new Map();
    for (const cand of new Set([...e.keys(), ...d.keys()])) {
      const expected = ed.length && d.has(cand) ? d.get(cand) : e.get(cand) ?? 0;
      const actual = jsCands.get(cand)?.votes ?? 0;
      check('candidateVotes', actual === expected, `Candidate '${cand}' vote sum (${actual} == ${expected}) in '${title}'`);
    }
  }

  // 5. Precinct turnout and per-precinct candidate votes
  const precinctRows = ed.length ? ed : early;
  const jsStats = js.precinctStats instanceof Map ? js.precinctStats : new Map(Object.entries(js.precinctStats ?? {}));
  for (const [p, raw] of rawPrecinctStats(precinctRows, fixes)) {
    check('precinctStats', jsStats.has(p), `Precinct '${p}' stats present in JS dataset`);
    if (!jsStats.has(p)) continue;
    const s = jsStats.get(p);
    check('precinctVoters', s.voters === raw.voters, `Precinct '${p}' Registered Voters (${s.voters} == ${raw.voters})`);
    check('precinctBallots', s.ballots === raw.ballots, `Precinct '${p}' Ballots Cast (${s.ballots} == ${raw.ballots})`);
  }

  if (precinctRows.length) {
    let audited = 0;
    eachContestBlock(precinctRows, (i, cells, contestRow, candidateRow, totalsIdx) => {
      cells.forEach(([col], k) => {
        const name = cleanContestName(rawCell(contestRow, col));
        if (!name || !jsContests.has(name)) return;
        const jsCands = new Map(jsContests.get(name).candidates.map((c) => [c.name, c]));
        const nextCol = k + 1 < cells.length ? cells[k + 1][0] : candidateRow.length;
        const cols = candidateColumns(candidateRow, col, nextCol, fixes);
        if (totalsIdx === null) return;
        for (let d = i + 2; d < totalsIdx; d++) {
          const row = precinctRows[d];
          const p = row[0] ? pyStrip(row[0]) : '';
          if (!p) continue;
          for (const [c, cand] of cols) {
            if (pyStrip(row[c] ?? '') === '' || !jsCands.has(cand)) continue;
            const expected = cleanNum(row[c]);
            const pv = jsCands.get(cand).precinctVotes;
            const actual = (pv instanceof Map ? pv.get(p) : pv?.[p]) ?? 0;
            audited++;
            if (actual !== expected) {
              check('precinctVotes', false, `Precinct '${p}' vote for '${cand}' in '${name}' (${actual} != ${expected})`);
            }
          }
        }
      });
    });
    check('precinctVotesAudited', audited > 0, `Audited ${audited} precinct-level candidate vote entries against raw CSV data`);
  }
  return checks;
}

module.exports = { verify, eachContestBlock, findAllRawContests, candidateColumns, writeInName };
