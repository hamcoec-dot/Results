'use strict';
/**
 * Checks every public page against the CSV files behind what a bucket serves now, the way a checker
 * with the printed tally report would on rehearsal night (docs/REHEARSAL.md › Run), but for every
 * number on every page. The expected numbers come from the legacy Python converter (convert_data.py
 * via tools/py_bridge.py), not from the cloud pipeline, so a wrong number anywhere between the CSV
 * and the screen is caught.
 *
 * The pages are this checkout's index/reporting/precincts/scrolling.html served on 127.0.0.1 in
 * Chromium with ?staging. Requests for the staging bucket are answered from the bucket given (so
 * production can be checked before PUBLIC_BASE is set), with CORS allowed for 127.0.0.1.
 *
 * Checked on each page, against the CSVs:
 *   summary     title, date, status, voters, ballots, turnout, precincts reporting, early badge; every
 *               contest: title, vote-for, total votes, "R of T Election Day Precincts Reporting",
 *               every candidate's name, votes and percentage, in the page's order
 *   reporting   one row per contest: title, R of T, total votes; every contest's dialog: exactly which
 *               precincts are listed as Reported and as Pending
 *   precincts   by contest: every precinct's status and votes for every contest; by precinct: three
 *               precincts' cards. With the page turned off: hidden, and no nav link on the others
 *   scrolling   the summary slide's precincts line, a slide for every contest, one contest slide's votes
 * and that every page's data carries the manifest's dataVersion (no mixed publish). With a draft id it
 * checks the four previews the review screen opens (?draft=<id>) instead of what is live.
 *
 * Usage:
 *   node tools/check-live-pages.js <bucket> --early <csv|-> --ed <csv|-> [--cap 92] [--precinct-page true|false]
 *       e.g. hcec-election-results-staging-results --early "Test_Files/Web Results Samples/02-After EV (92).csv" --ed -
 * Or from Node: const c = await createChecker({ bucket }); await c.check({ early, ed, cap, precinctPage }); await c.close();
 * Needs the root dev dependencies (npm ci) and Chromium (npx playwright install chromium, or CHROMIUM_PATH=<chrome>).
 * Exits 1 on any difference.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const STAGING_BASE = 'https://storage.googleapis.com/hcec-election-results-staging-results/';
const PAGES = ['index.html', 'reporting.html', 'precincts.html', 'scrolling.html'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fmt = (n) => Number(n).toLocaleString('en-US');
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function bridge(op, inputs) {
  const out = execFileSync(process.env.PYTHON || 'python3', [path.join(ROOT, 'tools', 'py_bridge.py')], {
    input: JSON.stringify({ op, inputs }), maxBuffer: 1 << 28,
  });
  return JSON.parse(out).map((r) => {
    if (!('ok' in r)) throw new Error(`convert_data ${op} failed: ${r.error}`);
    return r.ok;
  });
}

/**
 * The reference result: convert_data.merge_parsed_data of the two files (either may be null), with
 * which precincts have reported worked out as the plan specifies (defect d1, fixed in
 * functions/src/merge.js): an ED file's own "R of T" per contest; a precinct has reported when its ED
 * votes are not all zero and differ from the early file's (all of them when R = T).
 */
function expected(early, ed) {
  const b64 = (f) => (f ? fs.readFileSync(f).toString('base64') : null);
  const [want] = bridge('merge', [[b64(early), b64(ed)]]);
  if (!ed) return want;
  const [edP, earlyP] = bridge('parse', [[b64(ed), true], ...(early ? [[b64(early), false]] : [])]);
  for (const c of want.contests) {
    const e = edP.contests_raw[c.title];
    if (!e) continue;
    const before = earlyP?.contests_raw[c.title];
    const all = e.csvPrecinctsTotal > 0 && e.csvPrecinctsReporting >= e.csvPrecinctsTotal;
    const reported = (p) => {
      if (all) return true;
      const cands = Object.entries(e.candidates).filter(([, x]) => p in x.precinctVotes);
      return cands.some(([, x]) => x.precinctVotes[p] !== 0) && cands.some(([n, x]) => x.precinctVotes[p] !== before?.candidates[n]?.precinctVotes[p]);
    };
    c.precinctsReporting = e.csvPrecinctsReporting;
    c.precinctsTotal = e.csvPrecinctsTotal;
    c.precinctsStatus = c.precinctsStatus.map((p) => ({ name: p.name, reported: reported(p.name) }));
    // The file's own count and the precincts with new ED votes must agree (merge.js flags it otherwise).
    const n = c.precinctsStatus.filter((p) => p.reported).length;
    if (!all && n !== e.csvPrecinctsReporting) c.reportedMismatch = `${c.title}: the CSV says ${e.csvPrecinctsReporting} reporting, but ${n} precincts have new Election Day votes`;
  }
  want.overallPrecinctsReporting = Math.max(0, ...want.contests.map((c) => c.precinctsReporting));
  want.overallPrecinctsTotal = Math.max(...want.contests.map((c) => c.precinctsTotal));
  return want;
}

/** RFC 4180 rows of a CSV file (quoted cells may hold commas). */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * The per-precinct STATISTICS rows (registered voters, ballots cast) of an export, read straight from
 * the CSV. convert_data.py skips the 5-column export's rows (defect d3, fixed in functions/src/parse.js),
 * so the reference result has none for these files.
 */
function precinctStats(file) {
  const out = {};
  if (!file) return out;
  const num = (v) => Number(String(v ?? '').replace(/[,\s]/g, '')) || 0;
  let inStats = false;
  for (const row of csvRows(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))) {
    if (row.some((c) => c.includes('STATISTICS'))) { inStats = true; continue; }
    if (!inStats) continue;
    if (row[0] === 'Totals' || row.some((c) => /^Precincts Reporting/.test(c.trim()))) break;
    const at = row[0].trim() ? 0 : 1;
    const name = (row[at] || '').trim();
    if (!name || /^(Registered Voters|Totals|STATISTICS)/.test(name) || row.length < at + 3) continue;
    const voters = num(row[at + 1]);
    const ballots = num(row[at + 2]);
    if (voters > 0 || ballots > 0) out[name] = { voters, ballots };
  }
  return out;
}

/** A static server for the checkout (the pages need no build). */
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function createChecker({ bucket, emulator = false }) {
  const { chromium } = require(path.join(ROOT, 'node_modules', '@playwright/test'));
  // An object's URL: the public bucket, or the Storage emulator's download path (tools/staging-election.js --emulator).
  const objectUrl = (object) => (emulator
    ? `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199'}/download/storage/v1/b/${bucket}/o/${encodeURIComponent(object.split('?')[0])}?alt=media`
    : `https://storage.googleapis.com/${bucket}/${object}`);
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const context = await browser.newContext({ timezoneId: 'America/New_York', locale: 'en-US', viewport: { width: 1280, height: 900 } });
  // The bucket's CORS allows only the real sites; answer the pages' requests from Node instead.
  await context.route(`${STAGING_BASE}**`, async (route) => {
    const url = objectUrl(route.request().url().slice(STAGING_BASE.length));
    try {
      const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
      const body = Buffer.from(await res.arrayBuffer());
      await route.fulfill({ status: res.status, body, headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'access-control-allow-origin': '*' } });
    } catch (e) {
      await route.abort();
    }
  });

  /** `draft` (+ its `version`): the review screen's previews of that draft instead of what is live. */
  async function check({ early = null, ed = null, cap = 92, precinctPage = true, label = '', draft = null, version = null }) {
    const want = expected(early, ed);
    const problems = [];
    const eq = (what, got, exp) => { if (norm(got) !== norm(exp)) problems.push(`${what}: page shows "${norm(got)}", expected "${norm(exp)}"`); };
    const capped = (n) => Math.min(n || 0, cap);
    const manifest = draft ? { dataVersion: version } : await (await fetch(objectUrl('current/manifest.json'), { headers: { 'cache-control': 'no-cache' } })).json();
    const contests = want.contests;
    for (const c of contests) if (c.reportedMismatch) problems.push(`CSV: ${c.reportedMismatch}`);
    const edStats = precinctStats(ed);
    const wantStats = Object.keys(edStats).length ? edStats : precinctStats(early);

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const open = async (file) => {
      await page.goto(`${origin}${file}?staging${draft ? `&draft=${draft}` : ''}`);
      await page.waitForFunction(() => window.ELECTION_DATA && window.ELECTION_DATA.latest, null, { timeout: 30000 });
      const v = await page.evaluate(() => window.ELECTION_DATA.metadata && window.ELECTION_DATA.metadata.dataVersion);
      if (v !== manifest.dataVersion) problems.push(`${file}: data is version ${v}, the ${draft ? 'draft' : 'manifest'} says ${manifest.dataVersion}`);
      const navHidden = await page.evaluate(() => Array.from(document.querySelectorAll('a[href="precincts.html"]')).every((a) => a.hidden));
      if (file !== 'precincts.html' && navHidden === precinctPage) problems.push(`${file}: the Precinct Results link is ${navHidden ? 'hidden' : 'shown'}, expected ${precinctPage ? 'shown' : 'hidden'}`);
    };

    // Summary page.
    await open('index.html');
    await page.locator('#contests-container > article').first().waitFor();
    const s = await page.evaluate(() => {
      const t = (id) => document.getElementById(id)?.textContent;
      return {
        title: t('hero-title'), date: t('hero-date'), status: t('status-text'), voters: t('stat-voters'), ballots: t('stat-ballots'),
        turnout: t('stat-turnout'), reporting: t('stat-reporting'), early: t('stat-early-val'),
        cards: Array.from(document.querySelectorAll('#contests-container > article')).map((card) => ({
          title: card.querySelector('.contest-title').textContent,
          meta: card.querySelector('.contest-meta').textContent,
          reporting: card.querySelector('.reporting-btn').textContent,
          rows: Array.from(card.querySelectorAll('.candidate-row')).map((r) => ({
            name: r.querySelector('.cand-name-cell span').textContent,
            votes: r.querySelector('.vote-count').textContent,
            pct: r.querySelector('.vote-percent').textContent,
          })),
        })),
      };
    });
    eq('summary title', s.title, `${want.county} County ${want.electionTitle}`);
    eq('summary date', s.date, want.electionDate);
    eq('summary status', s.status, want.statusLabel);
    eq('registered voters', s.voters, fmt(want.totalVoters));
    eq('ballots cast', s.ballots, fmt(want.totalBallots));
    eq('turnout', s.turnout, `${want.turnoutPercent.toFixed(2)}%`);
    eq('precincts reporting', s.reporting, `${capped(want.overallPrecinctsReporting)} of ${Math.min(want.overallPrecinctsTotal || cap, cap)} Precincts`);
    const earlyDone = want.earlyVotingReporting > 0;
    eq('early voting badge', s.early.replace(/^\W+/, ''), `Early & Absentee: ${earlyDone ? 1 : 0} of 1 (${earlyDone ? 'Complete' : 'Pending'})`);
    if (s.cards.length !== contests.length) problems.push(`summary: ${s.cards.length} contests shown, the CSV has ${contests.length}`);
    for (const c of contests) {
      const card = s.cards.find((x) => norm(x.title) === norm(c.title));
      if (!card) { problems.push(`summary: contest "${c.title}" missing`); continue; }
      if (!norm(card.meta).includes(norm(c.voteFor))) problems.push(`summary ${c.title}: vote-for "${c.voteFor}" missing`);
      if (!norm(card.meta).includes(`Total Votes: ${fmt(c.totalVotes)}`)) problems.push(`summary ${c.title}: "${norm(card.meta)}", expected Total Votes: ${fmt(c.totalVotes)}`);
      if (!norm(card.reporting).includes(`${capped(c.precinctsReporting)} of ${capped(c.precinctsTotal)} Election Day Precincts Reporting`)) {
        problems.push(`summary ${c.title}: "${norm(card.reporting)}", expected ${capped(c.precinctsReporting)} of ${capped(c.precinctsTotal)}`);
      }
      if (card.rows.length !== c.candidates.length) problems.push(`summary ${c.title}: ${card.rows.length} candidates shown, the CSV has ${c.candidates.length}`);
      for (const x of c.candidates) {
        const row = card.rows.find((r) => norm(r.name) === norm(x.name));
        if (!row) { problems.push(`summary ${c.title}: candidate "${x.name}" missing`); continue; }
        eq(`summary ${c.title} / ${x.name} votes`, row.votes, fmt(x.votes));
        eq(`summary ${c.title} / ${x.name} percent`, row.pct, `(${x.percentage.toFixed(1)}%)`);
      }
    }

    // Reporting page.
    await open('reporting.html');
    const rows = page.locator('#reporting-table-body tr');
    await rows.first().waitFor();
    const shown = await rows.evaluateAll((trs) => trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
    if (shown.length !== contests.length) problems.push(`reporting: ${shown.length} rows, the CSV has ${contests.length} contests`);
    for (const c of contests) {
      const r = shown.find((x) => x[0] === norm(c.title));
      if (!r) { problems.push(`reporting: contest "${c.title}" missing`); continue; }
      if (!r[2].includes(`${capped(c.precinctsReporting)} of ${capped(c.precinctsTotal)}`)) problems.push(`reporting ${c.title}: "${r[2]}", expected ${capped(c.precinctsReporting)} of ${capped(c.precinctsTotal)}`);
      eq(`reporting ${c.title} total votes`, r[4], fmt(c.totalVotes));
    }
    // Every precinct a dialog lists as Reported, for the log (which precincts the public saw as in).
    const shownReported = new Set();
    for (const c of contests) {
      const at = shown.findIndex((x) => x[0] === norm(c.title));
      if (at < 0) continue;
      await rows.nth(at).locator('.reporting-btn').click();
      const chips = () => page.locator('#modal-precinct-grid .precinct-chip span:first-child').allTextContents();
      await page.locator('.modal-filter-btn[data-mfilter="REPORTED"]').click();
      const reported = (await chips()).map(norm).sort();
      reported.forEach((n) => shownReported.add(n));
      await page.locator('.modal-filter-btn[data-mfilter="PENDING"]').click();
      const pending = (await chips()).map(norm).sort();
      await page.keyboard.press('Escape');
      const expR = c.precinctsStatus.filter((p) => p.reported).map((p) => p.name).sort();
      const expP = c.precinctsStatus.filter((p) => !p.reported).map((p) => p.name).sort();
      if (JSON.stringify(reported) !== JSON.stringify(expR)) problems.push(`reporting ${c.title} dialog: ${reported.length} reported precincts shown, the CSV has ${expR.length} (${expR.filter((n) => !reported.includes(n)).slice(0, 5).join(', ')})`);
      if (JSON.stringify(pending) !== JSON.stringify(expP)) problems.push(`reporting ${c.title} dialog: ${pending.length} pending precincts shown, the CSV has ${expP.length}`);
    }

    // Precinct page.
    await open('precincts.html');
    // Turned off, app.js hides the page's sections and shows a "Precinct Results Currently Disabled" note.
    const hidden = (await page.locator('#precinct-disabled-note').count()) > 0 && !(await page.locator('#precinct-results-container').isVisible());
    if (!precinctPage) {
      if (!hidden) problems.push('precincts: the page is turned off but its results are still shown');
    } else {
      if (hidden) problems.push('precincts: the page is turned on but shows no results');
      await page.locator('#precinct-results-container article').first().waitFor();
      await page.click('#view-mode-contest-btn');
      for (const c of contests) {
        await page.selectOption('#contest-precinct-select', c.title);
        const table = page.locator('#precinct-results-container table');
        await table.waitFor();
        const head = (await table.locator('thead th').allTextContents()).map(norm);
        const body = await table.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => Array.from(tr.cells).map((td) => td.textContent.replace(/\s+/g, ' ').trim())));
        const names = c.candidates.map((x) => norm(x.name));
        if (JSON.stringify(head.slice(3)) !== JSON.stringify(names)) problems.push(`precincts ${c.title}: candidate columns "${head.slice(3).join(', ')}", expected "${names.join(', ')}"`);
        if (body.length !== c.precinctsStatus.length) problems.push(`precincts ${c.title}: ${body.length} precinct rows, the CSV has ${c.precinctsStatus.length}`);
        for (const p of c.precinctsStatus) {
          const row = body.find((x) => x[0] === norm(p.name));
          if (!row) { problems.push(`precincts ${c.title}: precinct ${p.name} missing`); continue; }
          eq(`precincts ${c.title} / ${p.name} status`, row[1], p.reported ? 'REPORTED' : 'PENDING');
          const votes = c.candidates.map((x) => x.precinctVotes[p.name] || 0);
          eq(`precincts ${c.title} / ${p.name} total`, row[2], fmt(votes.reduce((a, b) => a + b, 0)));
          eq(`precincts ${c.title} / ${p.name} votes`, row.slice(3).map((v) => v.replace(' ✔', '')).join(' | '), votes.map(fmt).join(' | '));
        }
      }
      await page.click('#view-mode-precinct-btn');
      const all = want.masterPrecincts;
      for (const name of [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]]) {
        await page.selectOption('#precinct-select', name);
        const inPrecinct = contests.filter((c) => c.precinctsStatus.some((p) => p.name === name));
        const cards = await page.locator('#precinct-results-container article').evaluateAll((arts) => arts.map((a) => ({
          title: a.querySelector('.contest-title').textContent,
          votes: Array.from(a.querySelectorAll('.candidate-row .vote-count')).map((v) => v.textContent),
        })));
        if (cards.length !== inPrecinct.length) problems.push(`precincts ${name}: ${cards.length} contests shown, the CSV has ${inPrecinct.length}`);
        for (const c of inPrecinct) {
          const card = cards.find((x) => norm(x.title) === norm(c.title));
          if (!card) { problems.push(`precincts ${name}: contest ${c.title} missing`); continue; }
          eq(`precincts ${name} / ${c.title}`, card.votes.join(' | '), c.candidates.map((x) => `${fmt(x.precinctVotes[name] || 0)} votes`).join(' | '));
        }
        const stats = wantStats[name] || { voters: 0, ballots: 0 };
        eq(`precincts ${name} voters`, await page.locator('#precinct-stat-voters').textContent(), fmt(stats.voters));
        eq(`precincts ${name} ballots`, await page.locator('#precinct-stat-ballots').textContent(), fmt(stats.ballots));
      }
    }

    // Scrolling (lobby screen) page.
    await open('scrolling.html');
    await page.locator('#slide-viewport .slide-card').first().waitFor();
    const first = norm(await page.locator('#slide-viewport .slide-card').first().textContent());
    const overall = `${capped(want.overallPrecinctsReporting)} of ${Math.min(want.overallPrecinctsTotal || cap, cap)}`;
    if (!first.includes(overall)) problems.push(`scrolling: the summary slide does not show ${overall} precincts`);
    // One slide is on screen at a time; the jump menu lists them all.
    const slides = (await page.locator('#slide-jump-menu option').allTextContents()).map(norm);
    const missing = contests.filter((c) => !slides.some((t) => t.includes(norm(c.title))));
    if (missing.length) problems.push(`scrolling: no slide for ${missing.map((c) => c.title).join(', ')}`);
    // Jump to a contest's slide and check its numbers.
    const c = contests[Math.floor(contests.length / 2)];
    const at = slides.findIndex((t) => t.includes(norm(c.title)));
    if (at >= 0) {
      await page.selectOption('#slide-jump-menu', { index: at });
      const text = norm(await page.locator('#slide-viewport').textContent());
      const absent = c.candidates.filter((x) => !text.includes(fmt(x.votes)));
      if (!text.includes(norm(c.title)) || absent.length) problems.push(`scrolling ${c.title}: slide is missing ${absent.map((x) => `${x.name} ${fmt(x.votes)}`).join(', ') || 'the title'}`);
    }

    if (errors.length) problems.push(`script errors: ${[...new Set(errors)].join('; ')}`);
    await page.close();
    const files = [early && `early ${path.basename(early)}`, ed && `ED ${path.basename(ed)}`].filter(Boolean).join(' + ');
    const flags = contests.reduce((n, c) => n + c.precinctsStatus.filter((p) => p.reported).length, 0);
    const counts = [...new Set(contests.map((c) => capped(c.precinctsReporting)))].sort((a, b) => a - b).join('/');
    console.log(`  ${draft ? 'draft previews' : 'public pages'} ${label}${label ? ' ' : ''}(${files}; ${manifest.dataVersion}): ${problems.length ? `${problems.length} PROBLEM(S)\n    ${problems.slice(0, 40).join('\n    ')}` : `all 4 pages match the CSV (${contests.length} contests, ${contests.reduce((n, c) => n + c.candidates.length, 0)} candidates, ${want.masterPrecincts.length} precincts; ${capped(want.overallPrecinctsReporting)} of ${Math.min(want.overallPrecinctsTotal || cap, cap)} reporting, per contest ${counts}; ${flags} reported precinct-contest pairs, each listed as reported)`}`);
    if (ed) {
      const names = [...shownReported].sort();
      console.log(`    precincts shown as Reported (${names.length}): ${names.join(', ') || 'none'}`);
    }
    return problems;
  }

  return {
    check,
    close: async () => { await browser.close(); server.close(); },
  };
}

module.exports = { createChecker };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
  const file = (v) => (v && v !== '-' ? path.resolve(v) : null);
  const early = file(opt('--early'));
  const ed = file(opt('--ed'));
  const cap = Number(opt('--cap', '92'));
  const precinctPage = !/^(false|no|0)$/i.test(opt('--precinct-page', 'true'));
  const [bucket] = args;
  if (!bucket || (!early && !ed)) {
    console.error('Usage: node tools/check-live-pages.js <bucket> --early <csv|-> --ed <csv|-> [--cap 92] [--precinct-page true|false]');
    process.exit(2);
  }
  (async () => {
    const c = await createChecker({ bucket });
    const problems = await c.check({ early, ed, cap, precinctPage }).finally(c.close);
    process.exit(problems.length ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
