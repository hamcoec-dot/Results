'use strict';
/**
 * Review payload for a draft (plan: "Robust review before publish" › Review payload). Written to
 * drafts/{draftId}/review.json and trace.json; the review screen renders it as-is.
 *
 *   review.json  file identity, header vs settings, headline current -> draft -> delta, every contest
 *                (every candidate), precinct reporting changes and turnout changes, the other slot
 *   trace.json   for every contest, the CSV rows the parser read (header, precinct and Totals rows,
 *                cut to the contest's columns) with their physical line numbers in the file
 *
 * `current` is the published data.js `latest` (plain JSON) or null before the first publish.
 */
const { pyStrip } = require('./pycompat');
const { cleanContestName } = require('./parse');
const { voteForNumber } = require('./merge');
const { eachContestBlock } = require('./verify');
const { closeMargin, normalizeDate } = require('./checks');

const REVIEW_SCHEMA = 1;

const asEntries = (m) => (m instanceof Map ? [...m.entries()] : Object.entries(m ?? {}));
const diff = (cur, next) => ({ current: cur ?? null, draft: next, delta: cur === undefined || cur === null ? null : round2(next - cur) });
const round2 = (x) => Math.round(x * 100) / 100;
const leaders = (c) => (c ? c.candidates.filter((x) => x.isLeading).map((x) => x.name).sort() : []);

/** Precinct name -> reported in at least one of its contests. */
function precinctReported(latest) {
  const out = new Map();
  for (const c of latest?.contests ?? []) {
    for (const p of c.precinctsStatus ?? []) out.set(p.name, (out.get(p.name) ?? false) || p.reported);
  }
  return out;
}

function contestDiff(title, cur, next) {
  const status = !cur ? 'added' : !next ? 'removed' : 'same';
  const c = next ?? cur;
  const curCands = new Map((cur?.candidates ?? []).map((x) => [x.name, x]));
  const nextCands = new Map((next?.candidates ?? []).map((x) => [x.name, x]));
  const names = [...nextCands.keys(), ...[...curCands.keys()].filter((n) => !nextCands.has(n))];
  const candidates = names.map((name) => {
    const o = curCands.get(name);
    const n = nextCands.get(name);
    const votes = diff(o?.votes, n ? n.votes : 0);
    return {
      name,
      party: (n ?? o).party,
      ...votes,
      currentPct: o?.percentage ?? null,
      draftPct: n ? n.percentage : null,
      leading: Boolean(n?.isLeading),
      wasLeading: Boolean(o?.isLeading),
      decreased: votes.delta !== null && votes.delta < 0,
      status: !o ? 'added' : !n ? 'removed' : 'same',
    };
  });
  const flags = (x) => new Map((x?.precinctsStatus ?? []).map((p) => [p.name, p.reported]));
  const before = flags(cur);
  const after = flags(next);
  const total = diff(cur?.totalVotes, next ? next.totalVotes : 0);
  const leaderChanged = Boolean(cur && next && cur.totalVotes > 0 && next.totalVotes > 0 && leaders(cur).join('\n') !== leaders(next).join('\n'));
  return {
    title,
    voteFor: c.voteFor,
    seats: voteForNumber(c.voteFor),
    status,
    reporting: { current: cur ? cur.precinctsReporting : null, draft: next ? next.precinctsReporting : null, of: c.precinctsTotal },
    total,
    candidates,
    leaders: leaders(next),
    previousLeaders: leaders(cur),
    leaderChanged,
    closeMargin: next ? closeMargin(next) : null,
    decreased: (total.delta ?? 0) < 0 || candidates.some((x) => x.decreased) || (cur && next && next.precinctsReporting < cur.precinctsReporting),
    changed: status !== 'same' || total.delta !== 0 || cur.precinctsReporting !== next.precinctsReporting || candidates.some((x) => x.delta !== 0),
    newlyReported: [...after].filter(([p, r]) => r && !before.get(p)).map(([p]) => p),
    stoppedReporting: [...before].filter(([p, r]) => r && !after.get(p)).map(([p]) => p),
  };
}

/**
 * @param {object} a
 * @param {object} a.result        buildResults() output for the draft
 * @param {object|null} a.current  published `latest`, or null
 * @param {{rows: string[][], lines: number[]}} a.source  the uploaded file's rows + line numbers
 * @param {object} a.meta          {draftId, baseVersion, kind, filename, size, sha256, lastModified, uploadedAt, uploadedBy}
 * @param {object} a.election      {name, date, county, precinctCap}
 * @param {object|null} [a.otherSlot]  {kind, filename, uploadedAt} of the upload filling the other slot
 * @returns {{review: object, trace: object}}
 */
function buildReview({ result, current = null, source, meta, election, otherSlot = null }) {
  const d = result.merged;
  const header = [
    ['title', d.electionTitle, election.name, (a, b) => pyStrip(a).toLowerCase() === pyStrip(b ?? '').toLowerCase()],
    ['date', d.electionDate, election.date, (a, b) => normalizeDate(a) !== null && normalizeDate(a) === normalizeDate(b)],
    ['county', d.county, election.county ?? null, (a, b) => b === null || a.toLowerCase() === b.toLowerCase()],
    ['status', d.statusLabel, current ? current.statusLabel : null, (a, b) => b === null || a === b],
  ].map(([field, file, setting, eq]) => ({ field, file, setting, match: eq(file, setting) }));

  const curStats = new Map(asEntries(current?.precinctStats));
  const precinctChanges = asEntries(d.precinctStats)
    .map(([name, s]) => [name, s, curStats.get(name)])
    .filter(([, s, o]) => !o || o.voters !== s.voters || o.ballots !== s.ballots)
    .map(([name, s, o]) => ({ name, voters: diff(o?.voters, s.voters), ballots: diff(o?.ballots, s.ballots), turnout: diff(o?.turnoutPercent, s.turnoutPercent) }));

  const curContests = new Map((current?.contests ?? []).map((c) => [c.title, c]));
  const nextContests = new Map(d.contests.map((c) => [c.title, c]));
  const titles = [...nextContests.keys(), ...[...curContests.keys()].filter((t) => !nextContests.has(t))];
  const contests = titles.map((t) => contestDiff(t, current ? curContests.get(t) : undefined, nextContests.get(t)));

  const before = precinctReported(current);
  const after = precinctReported(d);
  const review = {
    schema: REVIEW_SCHEMA,
    draftId: meta.draftId,
    baseVersion: meta.baseVersion ?? null,
    dataVersion: d.dataVersion,
    file: {
      kind: meta.kind, filename: meta.filename, size: meta.size, sha256: meta.sha256,
      lastModified: meta.lastModified ?? null, uploadedAt: meta.uploadedAt, uploadedBy: meta.uploadedBy,
    },
    header,
    otherSlot,
    headline: {
      precinctsReporting: { ...diff(current?.overallPrecinctsReporting, d.overallPrecinctsReporting), of: d.overallPrecinctsTotal, max: election.precinctCap },
      registeredVoters: diff(current?.totalVoters, d.totalVoters),
      ballotsCast: diff(current?.totalBallots, d.totalBallots),
      turnoutPercent: diff(current?.turnoutPercent, d.turnoutPercent),
    },
    contests,
    precincts: {
      newlyReported: [...after].filter(([p, r]) => r && !before.get(p)).map(([p]) => p),
      stoppedReporting: [...before].filter(([p, r]) => r && !after.get(p)).map(([p]) => p),
      statsChanged: precinctChanges,
    },
    counts: {
      contests: contests.length,
      changed: contests.filter((c) => c.changed).length,
      leaderChanges: contests.filter((c) => c.leaderChanged).length,
      decreases: contests.filter((c) => c.decreased).length,
      closeRaces: contests.filter((c) => c.closeMargin !== null).length,
    },
  };
  return { review, trace: buildTrace(source) };
}

/** Contest title -> blocks of {line, cells} (precinct name + the contest's columns). */
function buildTrace({ rows, lines }) {
  const contests = {};
  eachContestBlock(rows, (i, cells, contestRow, candidateRow, totalsIdx) => {
    cells.forEach(([col], k) => {
      const title = cleanContestName(contestRow[col] ? pyStrip(contestRow[col]) : '');
      if (!title) return;
      const stop = k + 1 < cells.length ? cells[k + 1][0] : candidateRow.length;
      const end = totalsIdx ?? i + 1;
      const block = [];
      for (let r = i - 2; r <= end; r++) {
        if (r < 0 || !rows[r]) continue;
        block.push({ line: lines[r], cells: [rows[r][0] ?? '', ...rows[r].slice(col, stop)] });
      }
      (contests[title] ??= []).push(block);
    });
  });
  return { schema: REVIEW_SCHEMA, contests };
}

module.exports = { buildReview, buildTrace, REVIEW_SCHEMA };
