'use strict';
/**
 * Seeded generator of synthetic elections and their tally-system "Custom Table Report" CSVs.
 *
 *   generateElection(opts) -> model   (the ground truth: every number the CSV encodes)
 *   toCsv(model, csvOpts)  -> string  (the export, mimicking the real file layout)
 *
 * Layout features copied from the real exports in Test_Files/ and Results/:
 *   - 3 header rows: title (r1c0), date (r2c0), status (r0, last col), county (r2, last col)
 *   - STATISTICS block, "narrow" (voters, ballots: 5 cols) or "wide" (+ REP/DEM/GEN ballots: 8 cols),
 *     with page breaks (first page rows start in col 1, continuation pages in col 0)
 *   - contest blocks: title / VOTE FOR n / "R of T Precincts Reporting" / candidate row,
 *     precinct rows, page breaks that repeat the 4 header rows, a Totals row
 *   - small contests packed side by side; wide contests wrapped into continuation blocks
 *   - party prefixes ("REP Name"), Write-in Totals columns, thousands separators, quoting
 *
 * Same seed + same options => byte-identical CSV.
 *
 * CLI:  node tools/gen-fixture.js --seed 42 [--kind zero|early|ed] [--layout narrow|wide]
 *                                 [--names tame|wild] [--precincts N] [--contests N] [--out file.csv]
 */

// ---------- PRNG (mulberry32) ----------
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  const chance = (p) => next() < p;
  return { next, int, pick, chance };
}

// ---------- name pools ----------
// Pools avoid words the legacy parser treats specially: precinct names never contain
// August/State/Federal/County/General/Primary/Totals; contest titles never start with
// REP/DEM unless they are partisan-primary titles; nothing contains "write-in",
// "NO CANDIDATE" or "Precincts Reporting".
const PRECINCT_WORDS = ['AIRPORT', 'ALTON PARK', 'APISON', 'AVONDALE', 'BIRCHWOOD', 'BONNY OAKS', 'BRAINERD',
  'BUSHTOWN', 'CONCORD', 'DALEWOOD', 'DALLAS', 'DOWNTOWN', 'DUPONT', 'EASTGATE', 'FAIRMOUNT', 'HIXSON',
  'LOOKOUT VALLEY', 'MOCCASIN BEND', 'NORTHGATE', 'OOLTEWAH', 'RIVERVIEW', 'SODDY', 'TYNER', 'WALDEN',
  'WESTVIEW', 'WOODMORE'];
const PRECINCT_WILD = ["O'BRIEN HILL", 'SMITH, JR. PARK', 'PEÑA CROSSING', 'ÅLAND', '"THE" FLATS',
  '<script>alert(1)</script>', 'A & B'];
const FIRST = ['Marsha', 'Jerri', 'Dean', 'Ray', 'David', 'Lauren', 'Victor', 'Karl', 'Robert', 'Ana', 'Wei',
  'Priya', 'Omar', 'Grace', 'Luis', 'Tamika', 'Hannah', 'Jamal'];
const LAST = ['Blackburn', 'Green', 'Brewer', 'Brown', 'Hatley', 'Jackson', 'Morgan', 'Murphy', 'Pinkston',
  'Scoggin', 'Seeman', 'Taylor', 'Vick', 'Nguyen', 'Patel', 'Okafor', 'Kim', 'Alvarez'];
const CAND_WILD = ['Robert "Bob" Smith', 'José Núñez', 'Lee, Jr.', "D'Angelo Moss", '<img src=x onerror=alert(1)>',
  'Zoë Ünal', 'Mary-Kate O\'Neil', '李 小龙'];
const OFFICES = ['Governor', 'Mayor', 'Sheriff', 'Trustee', 'Assessor of Property', 'County Commission',
  'School Board', 'City Council', 'State House', 'State Senate', 'Circuit Court Clerk', 'Register of Deeds',
  'Constitutional Amendment', 'Judge Circuit Court Part', 'Constable', 'Clerk and Master'];
const CONTEST_WILD = ['Mayor, City of "Ooltewah"', '<b>Council</b> Seat', 'Board & Authority', 'Référendum'];

// Port of convert_data.clean_contest_name's dedupe tests: a generated title must pass through unchanged.
function titleIsStable(t) {
  if (/\b(.+?)\s+\1\b/i.test(t)) return false;
  const m = /^(\w+)\s+(.+?)\s+(\w+)$/.exec(t);
  if (m && m[1].toLowerCase() === m[3].toLowerCase()) return false;
  return t === t.trim() && !/\s{2}/.test(t);
}

// ---------- model ----------
const DEFAULTS = {
  seed: 1,
  kind: 'ed', // zero | early | ed
  layout: 'narrow', // narrow (5-col header/stats) | wide (8-col)
  names: 'tame', // tame | wild
  precincts: 30, // 1-150
  contests: 8, // 1-60
  maxCandidates: 6, // 1-12
  maxVoteFor: 1, // 1-5
  reportingFraction: null, // ED only; null = random
  title: null,
  date: 'November 3, 2026',
  county: 'Hamilton',
  status: 'UNOFFICIAL RESULTS',
};

function uniqueName(r, used, make) {
  for (let tries = 0; tries < 200; tries++) {
    const n = make(tries);
    if (!used.has(n)) { used.add(n); return n; }
  }
  // Fall back to a guaranteed-unique suffix (letters only, so titles stay dedupe-stable).
  let i = used.size;
  let n;
  do { n = `${make(0)} ${toLetters(i++)}`; } while (used.has(n));
  used.add(n);
  return n;
}

function toLetters(i) {
  let s = '';
  i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function generateElection(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const r = rng(o.seed);
  const wild = o.names === 'wild';
  const isPrimary = o.layout === 'wide';

  // Precincts and their STATISTICS rows.
  const usedP = new Set();
  const precincts = [];
  for (let i = 0; i < o.precincts; i++) {
    const name = uniqueName(r, usedP, (t) => (wild && r.chance(0.15)
      ? r.pick(PRECINCT_WILD)
      : `${r.pick(PRECINCT_WORDS)}${t > 0 || r.chance(0.5) ? ' ' + toLetters(r.int(0, 3 + t)) : ''}`));
    const voters = r.int(1, 6000);
    let ballots = 0;
    let rep = 0, dem = 0, gen = 0;
    if (o.kind !== 'zero') {
      ballots = r.int(0, Math.floor(voters * 0.8));
      if (isPrimary) {
        rep = r.int(0, ballots);
        dem = r.int(0, ballots - rep);
        gen = ballots - rep - dem;
      }
    }
    precincts.push({ name, voters, ballots, rep, dem, gen });
  }

  // Which precincts have reported (ED only); everything else is 0 of T.
  const frac = o.reportingFraction ?? r.next();
  const reported = new Set(o.kind === 'ed' ? precincts.filter(() => r.next() < frac).map((p) => p.name) : []);

  // Contests.
  const usedC = new Set();
  const contests = [];
  for (let c = 0; c < o.contests; c++) {
    const style = isPrimary ? r.pick(['REP', 'DEM', 'nonpartisan']) : r.pick(['partisan', 'nonpartisan', 'nonpartisan']);
    let title;
    do {
      title = uniqueName(r, usedC, (t) => {
        const base = wild && r.chance(0.2) ? r.pick(CONTEST_WILD) : r.pick(OFFICES);
        const suffix = r.chance(0.6) || t > 0 ? ` District ${r.int(1, 30 + t)}` : '';
        return `${style === 'REP' || style === 'DEM' ? style + ' ' : ''}${base}${suffix}`;
      });
    } while (!titleIsStable(title) && usedC.delete(title));

    const voteFor = r.int(1, o.maxVoteFor);
    const nCand = r.int(1, o.maxCandidates);
    const usedN = new Set();
    const candidates = [];
    for (let k = 0; k < nCand; k++) {
      const name = uniqueName(r, usedN, () => (wild && r.chance(0.2) ? r.pick(CAND_WILD) : `${r.pick(FIRST)} ${r.pick(LAST)}`));
      let party = '';
      let prefix = '';
      if (style === 'REP' || style === 'DEM') party = style; // primary: party comes from the title
      else if (style === 'partisan') {
        party = k === 0 ? 'REP' : k === 1 ? 'DEM' : 'IND';
        prefix = party === 'IND' ? '' : party + ' ';
      }
      candidates.push({ name, party, label: prefix + name, votes: 0, precinctVotes: {} });
    }

    // District races cover a subset of precincts.
    const members = r.chance(0.3) && precincts.length > 1
      ? precincts.filter(() => r.chance(0.5))
      : precincts.slice();
    if (members.length === 0) members.push(precincts[0]);

    for (const p of members) {
      const budget = p.ballots * voteFor;
      for (const cand of candidates) {
        const v = budget === 0 ? 0 : r.int(0, Math.floor(budget / candidates.length));
        cand.precinctVotes[p.name] = v;
        cand.votes += v;
      }
    }
    const writeIn = r.chance(0.4);
    contests.push({
      title,
      voteFor: `VOTE FOR ${voteFor}`,
      voteForNum: voteFor,
      candidates,
      writeIn,
      writeInVotes: writeIn ? Object.fromEntries(members.map((p) => [p.name, r.int(0, 3)])) : null,
      precincts: members.map((p) => p.name),
      precinctsTotal: members.length,
      precinctsReporting: members.filter((p) => reported.has(p.name)).length,
    });
  }

  const totals = precincts.reduce((t, p) => ({
    voters: t.voters + p.voters, ballots: t.ballots + p.ballots, rep: t.rep + p.rep, dem: t.dem + p.dem, gen: t.gen + p.gen,
  }), { voters: 0, ballots: 0, rep: 0, dem: 0, gen: 0 });

  return {
    seed: o.seed,
    kind: o.kind,
    layout: o.layout,
    title: o.title ?? (isPrimary ? '2026-08-06 Primary Election' : '2026-11-03 General'),
    date: o.date,
    county: o.county,
    status: o.status,
    precincts,
    reported: [...reported],
    contests,
    totals,
  };
}

/**
 * The Early/ABS file that preceded an ED election: the same precincts and contests, where every
 * precinct that has not reported shows exactly its ED votes and every reported precinct shows
 * fewer votes (the ED file is cumulative). A reported precinct whose ED votes in a contest are all
 * zero cannot differ, which is the one case the reported-precinct inference cannot see.
 */
function deriveEarly(ed, seed = ed.seed + 1) {
  const r = rng(seed);
  const reported = new Set(ed.reported);
  const contests = ed.contests.map((c) => {
    const candidates = c.candidates.map((cand) => ({ ...cand, precinctVotes: { ...cand.precinctVotes } }));
    for (const p of c.precincts) {
      if (!reported.has(p)) continue;
      const withVotes = candidates.filter((x) => x.precinctVotes[p] > 0);
      if (!withVotes.length) continue;
      const must = r.pick(withVotes);
      for (const x of withVotes) {
        if (x === must || r.chance(0.5)) x.precinctVotes[p] -= r.int(1, x.precinctVotes[p]);
      }
    }
    for (const x of candidates) x.votes = Object.values(x.precinctVotes).reduce((a, b) => a + b, 0);
    return { ...c, candidates, precinctsReporting: 0 };
  });
  return { ...ed, kind: 'early', reported: [], contests };
}

/** Per contest of an ED model: the reported precincts an export actually reveals (see deriveEarly). */
function visibleReported(ed) {
  const reported = new Set(ed.reported);
  return new Map(ed.contests.map((c) => [c.title, c.precinctsReporting === c.precinctsTotal
    ? c.precincts.slice()
    : c.precincts.filter((p) => reported.has(p) && c.candidates.some((x) => x.precinctVotes[p] > 0))]));
}

// ---------- CSV ----------
const fmt = (n) => n.toLocaleString('en-US');

function cell(v) {
  const s = String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pad(row, width) {
  while (row.length < width) row.push('');
  return row;
}

/**
 * csvOpts: { eol: '\r\n' | '\n', bom: false, pageRows: 33, maxBlockCols: 15 }
 */
function toCsv(model, csvOpts = {}) {
  const { eol = '\r\n', bom = false, pageRows = 33, maxBlockCols = 15 } = csvOpts;
  const wide = model.layout === 'wide';
  const W = wide ? 8 : 5;
  const rows = [];

  rows.push(pad(['Custom Table Report'], W - 1).concat(model.status));
  rows.push(pad([model.title], W));
  rows.push(pad([model.date], W - 1).concat(model.county));

  // STATISTICS
  rows.push(pad(['', '', 'STATISTICS'], W));
  const statHead = ['', '', 'Registered Voters - Total', 'Ballots Cast - Total'];
  if (wide) statHead.push('Ballots Cast - Republican', 'Ballots Cast - Democratic', 'Ballots Cast - General');
  rows.push(pad(statHead, W));
  model.precincts.forEach((p, i) => {
    const vals = [fmt(p.voters), fmt(p.ballots)];
    if (wide) vals.push(fmt(p.rep), fmt(p.dem), fmt(p.gen));
    if (i < pageRows) rows.push(pad(['', p.name, ...vals], W));
    else rows.push(wide ? [p.name, ...vals, ''] : [p.name, ...vals]); // continuation pages start in col 0
  });
  const t = model.totals;
  rows.push(wide ? ['Totals', fmt(t.voters), fmt(t.ballots), fmt(t.rep), fmt(t.dem), fmt(t.gen)] : ['Totals', fmt(t.voters), fmt(t.ballots)]);

  // Contest pieces: each contest becomes one or more column groups (wrapping wide contests).
  const span = maxBlockCols - 1; // data columns per block (col 0 is the precinct name)
  const pieces = [];
  for (const c of model.contests) {
    const cols = c.candidates.map((cand) => ({ label: cand.label, votes: (p) => cand.precinctVotes[p], total: cand.votes }));
    if (c.writeIn) {
      const wv = c.writeInVotes;
      cols.push({ label: 'Write-in Totals', votes: (p) => wv[p], total: Object.values(wv).reduce((a, b) => a + b, 0) });
    }
    for (let i = 0; i < cols.length; i += span) pieces.push({ contest: c, cols: cols.slice(i, i + span) });
  }

  // Pack pieces side by side into blocks.
  const blocks = [];
  for (const piece of pieces) {
    const last = blocks[blocks.length - 1];
    if (last && last.width + piece.cols.length <= span) { last.pieces.push(piece); last.width += piece.cols.length; }
    else blocks.push({ pieces: [piece], width: piece.cols.length });
  }

  const reportingText = (c) => `${model.kind === 'ed' ? c.precinctsReporting : 0} of ${c.precinctsTotal} Precincts Reporting`;

  const members = new Map(model.contests.map((c) => [c, new Set(c.precincts)]));
  for (const b of blocks) {
    const width = 1 + b.width;
    const header = () => {
      const r1 = [''], r2 = [''], r3 = [''], r4 = [''];
      for (const piece of b.pieces) {
        piece.cols.forEach((col, k) => {
          r1.push(k === 0 ? piece.contest.title : '');
          r2.push(k === 0 ? piece.contest.voteFor : '');
          r3.push(k === 0 ? reportingText(piece.contest) : '');
          r4.push(col.label);
        });
      }
      rows.push(r1, r2, r3, r4);
    };
    const inBlock = model.precincts.filter((p) => b.pieces.some((piece) => members.get(piece.contest).has(p.name)));
    header();
    inBlock.forEach((p, i) => {
      if (i > 0 && i % pageRows === 0) header();
      const row = [p.name];
      for (const piece of b.pieces) {
        const member = members.get(piece.contest).has(p.name);
        for (const col of piece.cols) row.push(member ? fmt(col.votes(p.name)) : '');
      }
      rows.push(row);
    });
    const tot = ['Totals'];
    for (const piece of b.pieces) for (const col of piece.cols) tot.push(fmt(col.total));
    rows.push(pad(tot, width));
  }

  const text = rows.map((row) => row.map(cell).join(',')).join(eol) + eol;
  return bom ? '﻿' + text : text;
}

module.exports = { generateElection, deriveEarly, visibleReported, toCsv, rng, titleIsStable, DEFAULTS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = {};
  let out = null;
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i].replace(/^--/, '');
    const v = args[i + 1];
    if (k === 'out') out = v;
    else opt[k] = /^\d+$/.test(v) ? Number(v) : v;
  }
  const csv = toCsv(generateElection(opt));
  if (out) require('fs').writeFileSync(out, csv);
  else process.stdout.write(csv);
}
