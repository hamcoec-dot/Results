'use strict';
/**
 * Port of convert_data.merge_parsed_data (convert_data.py:244).
 *
 * The Early slot holds a Zero or Early/ABS upload, the ED slot an Election Day upload. The ED
 * file is cumulative (it includes early votes), so votes are never added across slots.
 *
 * precinctCap (the election's "max precincts", default 92) replaces the MAX_PRECINCT_CAP constant.
 *
 * Fix d1 — which precincts have reported. The export has no per-precinct flag, only each
 * contest's "R of T Precincts Reporting". In the real exports a precinct has reported in a contest
 * exactly when its ED votes there are not all zero AND differ from its votes in the Early-slot file
 * (early votes are already spread across precincts, so non-zero alone overcounts). This is
 * checked against R for every contest; any contest where the two disagree is listed in
 * `diagnostics.reportingMismatches` (a check in checks.js) and keeps R as its count. When R = T
 * every precinct is reported. An admin can mark a precinct as reported (opts.markedReported) for the
 * rare precinct that reported with no Election Day votes in a contest. Legacy behaviour (every listed precinct reported, plus the "largest
 * contest complete => every contest complete" rule) is kept only for the parity tests.
 */
const crypto = require('node:crypto');
const { PY_WS, pyRound2, pyInt, pyCompare, pyDumps } = require('./pycompat');
const { FIXES } = require('./parse');

const S = `[${PY_WS}]`;
const VOTE_FOR = new RegExp(`(?:VOTE${S}+(?:FOR${S}+)?(?:UP${S}+TO${S}+)?|SELECT${S}+)(\\p{Nd}+)`, 'iu');
const FIRST_NUMBER = /(\p{Nd}+)/u;

/** "VOTE FOR 3" -> 3 (at least 1). */
function voteForNumber(text) {
  const m = VOTE_FOR.exec(text) ?? FIRST_NUMBER.exec(text);
  return m ? Math.max(1, pyInt(m[1])) : 1;
}

const copyCandidate = (c) => ({ name: c.name, party: c.party, votes: c.votes, precinctVotes: c.precinctVotes });

/** Precincts of an ED contest that reported (fix d1; see the header). */
function inferReported(edC, earlyC) {
  const reported = new Set();
  for (const p of edC.precinctsStatusMap.keys()) {
    let nonzero = false;
    let changed = false;
    for (const [name, cand] of edC.candidates) {
      const v = cand.precinctVotes.get(p);
      if (v === undefined) continue;
      if (v !== 0) nonzero = true;
      if (v !== earlyC?.candidates.get(name)?.precinctVotes.get(p)) changed = true;
    }
    if (nonzero && changed) reported.add(p);
  }
  return reported;
}

/**
 * @param {object|null} early  parseRows() result for the Early slot
 * @param {object|null} ed     parseRows() result for the ED slot
 * @param {{precinctCap?: number, fixes?: object, markedReported?: string[]}} [opts]
 *   markedReported  precincts the admin marked as reported (election setting): with an ED file, each
 *                   is listed as reported in every contest it is in, whatever its votes. The count
 *                   stays the file's R, so a wrong mark shows up as a reporting mismatch.
 * @returns {{data: object, diagnostics: {reportingMismatches: object[]}}|null}
 */
function mergeParsedData(early, ed, { precinctCap = 92, fixes = FIXES, markedReported = [] } = {}) {
  if (!early && !ed) return null;
  markedReported = new Set(markedReported);
  const head = ed ?? early;
  const totalVoters = Math.max(early ? early.totalVoters : 0, ed ? ed.totalVoters : 0);
  const totalBallots = head.totalBallots;
  const precinctStats = ed && ed.precinctStats.size ? ed.precinctStats : early ? early.precinctStats : new Map();

  const titles = [];
  const seen = new Set();
  for (const p of [early, ed]) {
    if (!p) continue;
    for (const t of p.contestsRaw.keys()) if (!seen.has(t)) { seen.add(t); titles.push(t); }
  }

  const reportingMismatches = [];
  const contests = titles.map((title) => {
    const earlyC = early ? early.contestsRaw.get(title) : undefined;
    const edC = ed ? ed.contestsRaw.get(title) : undefined;
    const voteFor = (edC ?? earlyC).voteFor;

    let reportedCnt;
    let totalCnt;
    let statusMap;
    if (edC) {
      reportedCnt = edC.csvPrecinctsReporting;
      totalCnt = edC.csvPrecinctsTotal;
      statusMap = edC.precinctsStatusMap;
    } else {
      reportedCnt = 0;
      totalCnt = earlyC.csvPrecinctsTotal;
      statusMap = new Map([...earlyC.precinctsStatusMap.keys()].map((p) => [p, false]));
    }

    const byName = new Map();
    for (const src of [edC, earlyC]) {
      if (!src) continue;
      for (const [name, c] of src.candidates) if (!byName.has(name)) byName.set(name, copyCandidate(c));
    }
    const candidates = [...byName.values()];

    // No REP/DEM in the contest: every candidate is IND, and the label is dropped.
    if (!candidates.some((c) => c.party === 'REP' || c.party === 'DEM')) for (const c of candidates) c.party = '';
    const totalVotes = candidates.reduce((s, c) => s + c.votes, 0);
    const vf = voteForNumber(voteFor);
    // Leading: among the top vote-for candidates (ties at the cutoff included), with votes.
    const sorted = candidates.map((c) => c.votes).sort((a, b) => b - a);
    const cutoff = sorted[Math.min(vf, sorted.length) - 1];
    for (const c of candidates) {
      c.percentage = totalVotes > 0 ? pyRound2((c.votes / totalVotes) * 100) : 0;
      c.isLeading = c.votes > 0 && c.votes >= cutoff;
    }

    if (edC && fixes.d1) {
      const complete = totalCnt > 0 && reportedCnt >= totalCnt;
      const reported = complete ? new Set(statusMap.keys()) : inferReported(edC, earlyC);
      // Precincts the admin marked as reported count in every contest they are in (an ED file only).
      const marked = complete ? [] : [...statusMap.keys()].filter((p) => markedReported.has(p) && !reported.has(p));
      for (const p of marked) reported.add(p);
      statusMap = new Map([...statusMap.keys()].map((p) => [p, reported.has(p)]));
      if (!complete && reported.size !== reportedCnt) {
        reportingMismatches.push({ contest: title, csvReporting: reportedCnt, inferred: [...reported], marked });
      }
    } else {
      const fromMap = [...statusMap.values()].filter(Boolean).length;
      if (fromMap > 0) reportedCnt = Math.max(reportedCnt, fromMap);
      if (edC && reportedCnt >= totalCnt && totalCnt > 0) {
        reportedCnt = totalCnt;
        for (const p of statusMap.keys()) statusMap.set(p, true);
      }
    }

    return {
      title,
      voteFor,
      precinctsReporting: Math.min(reportedCnt, precinctCap),
      precinctsTotal: Math.min(totalCnt, precinctCap),
      totalVotes,
      candidates,
      precinctsStatus: [...statusMap].map(([name, reported]) => ({ name, reported })),
    };
  });

  const overallRep = Math.min(Math.max(0, ...contests.map((c) => c.precinctsReporting)), precinctCap);
  const overallTot = Math.min(contests.length ? Math.max(...contests.map((c) => c.precinctsTotal)) : precinctCap, precinctCap);

  if (!fixes.d1 && ed && overallRep >= overallTot && overallTot > 0) {
    for (const c of contests) {
      c.precinctsReporting = c.precinctsTotal;
      for (const p of c.precinctsStatus) p.reported = true;
    }
  }

  const master = new Set(precinctStats.keys());
  for (const c of contests) for (const p of c.precinctsStatus) master.add(p.name);
  const masterPrecincts = [...master].sort(pyCompare);
  const index = new Map(masterPrecincts.map((name, i) => [name, i]));
  for (const c of contests) {
    c.precinctsStatusIndexed = c.precinctsStatus.map((p) => [index.get(p.name), p.reported ? 1 : 0]);
  }

  const dataVersion = crypto.createHash('md5').update(pyDumps(contests, { sortKeys: true })).digest('hex').slice(0, 12);

  const data = {
    electionTitle: head.electionTitle,
    electionDate: head.electionDate,
    county: head.county,
    statusLabel: head.statusLabel,
    totalVoters,
    totalBallots,
    ballotsRep: head.ballotsRep,
    ballotsDem: head.ballotsDem,
    ballotsGen: head.ballotsGen,
    turnoutPercent: totalVoters > 0 ? pyRound2((totalBallots / totalVoters) * 100) : 0,
    overallPrecinctsReporting: overallRep,
    overallPrecinctsTotal: overallTot,
    hasEarlyUpload: Boolean(early),
    earlyVotingReporting: early && totalBallots > 0 ? 1 : 0,
    earlyVotingTotal: 1,
    earlyBallotsCast: early ? early.totalBallots : 0,
    masterPrecincts,
    precinctStats,
    contests,
    dataVersion,
  };
  return { data, diagnostics: { reportingMismatches } };
}

module.exports = { mergeParsedData, voteForNumber, inferReported };
