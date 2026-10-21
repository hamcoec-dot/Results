'use strict';
// review.js: the diff math (current -> draft -> delta), leader changes, close races, newly / no
// longer reporting precincts, and the raw-source trace's line numbers against the physical file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse: csvParse } = require('csv-parse/sync');
const { caseInputs, toPlain } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { readCsv } = require('../src/csv');
const { buildReview, REVIEW_SCHEMA } = require('../src/review');

const EV = caseInputs('samples-92-02-ev').early;
const ED3 = caseInputs('samples-92-03-5-reporting').ed;
const ED4 = caseInputs('samples-92-04-10-reporting').ed;
const ELECTION = { name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 92 };
const META = { draftId: 'a'.repeat(32), baseVersion: 'v1', kind: 'ed', filename: '04.csv', size: 29090, sha256: 's', uploadedAt: 'now', uploadedBy: 'me' };

/** The published `latest` for an upload, as data.js carries it (plain JSON). */
const published = (ed, early = EV) => JSON.parse(JSON.stringify(toPlain(buildResults({ early, ed }, { lastUpdated: 'x' }).merged)));

function review(ed, current, { early = EV, election = ELECTION, meta = META, otherSlot = null } = {}) {
  const lines = [];
  const rows = readCsv(ed, lines);
  return buildReview({ result: buildResults({ early, ed }, { lastUpdated: 'x' }), current, source: { rows, lines }, meta, election, otherSlot });
}

test('headline and contest diff: 5 -> 10 precincts', () => {
  const { review: r } = review(ED4, published(ED3));
  assert.equal(r.schema, REVIEW_SCHEMA);
  assert.equal(r.draftId, META.draftId);
  assert.deepEqual(r.headline.precinctsReporting, { current: 5, draft: 10, delta: 5, of: 92, max: 92 });
  assert.deepEqual(r.headline.ballotsCast, { current: 1516, draft: 1700, delta: 184 });
  assert.deepEqual(r.headline.turnoutPercent, { current: 0.66, draft: 0.73, delta: 0.07 });
  const gov = r.contests.find((c) => c.title === 'Governor');
  assert.deepEqual(gov.reporting, { current: 5, draft: 10, of: 92 });
  assert.deepEqual(gov.total, { current: 1430, draft: 1606, delta: 176 });
  assert.equal(gov.candidates.reduce((s, c) => s + c.delta, 0), 176);
  for (const c of gov.candidates) assert.equal(c.delta, c.draft - c.current);
  assert.deepEqual(gov.newlyReported, ['SODDY DAISY C', 'STUART HEIGHTS', 'VALLEYBROOK', 'WALDEN', 'WESTVIEW A']);
  assert.deepEqual(r.precincts.newlyReported, gov.newlyReported);
  assert.deepEqual(r.precincts.stoppedReporting, []);
  assert.equal(gov.changed, true);
  assert.equal(gov.decreased, false);
  assert.deepEqual(r.counts, { contests: 25, changed: 15, leaderChanges: 0, decreases: 0, closeRaces: 17 });
  assert.ok(r.header.every((h) => h.match));
});

test('first publish: no current, every contest added, deltas null', () => {
  const { review: r } = review(ED3, null);
  assert.deepEqual(r.headline.precinctsReporting, { current: null, draft: 5, delta: null, of: 92, max: 92 });
  assert.ok(r.contests.every((c) => c.status === 'added' && c.changed && c.total.delta === null));
  assert.ok(r.contests.every((c) => c.candidates.every((x) => x.current === null && x.status === 'added' && !x.decreased)));
  assert.equal(r.precincts.newlyReported.length, 5);
  assert.equal(r.precincts.statsChanged.length, 92);
});

test('going backwards: decreases, stopped reporting, removed contest and candidate, leader change', () => {
  const cur = published(ED4);
  cur.contests.push({ ...structuredClone(cur.contests[1]), title: 'Gone Contest' });
  const gov = cur.contests.find((c) => c.title === 'Governor');
  gov.candidates.push({ ...structuredClone(gov.candidates[0]), name: 'Gone Candidate', isLeading: true });
  const { review: r } = review(ED3, cur);
  const g = r.contests.find((c) => c.title === 'Governor');
  assert.equal(g.decreased, true);
  assert.deepEqual(g.stoppedReporting.sort(), ['SODDY DAISY C', 'STUART HEIGHTS', 'VALLEYBROOK', 'WALDEN', 'WESTVIEW A']);
  const gone = g.candidates.find((c) => c.name === 'Gone Candidate');
  assert.deepEqual([gone.status, gone.draft, gone.draftPct, gone.leading, gone.wasLeading], ['removed', 0, null, false, true]);
  assert.equal(g.leaderChanged, true);
  assert.ok(g.previousLeaders.includes('Gone Candidate'));
  assert.ok(g.candidates.filter((c) => c.status === 'same').some((c) => c.decreased && c.delta < 0));
  const removed = r.contests.find((c) => c.title === 'Gone Contest');
  assert.deepEqual([removed.status, removed.reporting.draft, removed.total.draft, removed.changed], ['removed', null, 0, true]);
  assert.equal(r.contests.at(-1).title, 'Gone Contest'); // removed contests listed last
  assert.ok(r.counts.decreases >= 1 && r.counts.leaderChanges === 1);
});

test('unchanged contests are not "changed"; precinct stat changes are listed', () => {
  const cur = published(ED4);
  cur.precinctStats.TYNER.ballots -= 7;
  const { review: r } = review(ED4, cur);
  assert.equal(r.counts.changed, 0);
  assert.ok(r.contests.every((c) => !c.changed && !c.decreased && c.newlyReported.length === 0));
  assert.deepEqual(r.precincts.statsChanged.map((s) => [s.name, s.ballots.delta]), [['TYNER', 7]]);
});

test('header identity: mismatches are flagged; other slot passed through', () => {
  const cur = published(ED3);
  cur.statusLabel = 'OFFICIAL RESULTS';
  const otherSlot = { kind: 'early', filename: '02.csv', uploadedAt: 'earlier' };
  const { review: r } = review(ED4, cur, { election: { ...ELECTION, name: 'Other', date: '2026-11-04', county: 'Marion' }, otherSlot });
  assert.deepEqual(r.header.map((h) => [h.field, h.match]), [['title', false], ['date', false], ['county', false], ['status', false]]);
  assert.deepEqual(r.header[1], { field: 'date', file: 'November 3, 2026', setting: '2026-11-04', match: false });
  assert.deepEqual(r.otherSlot, otherSlot);
  assert.deepEqual(r.file, { kind: 'ed', filename: '04.csv', size: 29090, sha256: 's', lastModified: null, uploadedAt: 'now', uploadedBy: 'me' });
  const noCounty = review(ED4, null, { election: { ...ELECTION, county: undefined } }).review.header;
  assert.equal(noCounty.find((h) => h.field === 'county').match, true);
});

test('trace: every row is the physical line of the file, cut to the contest columns', () => {
  const { trace } = review(ED4, null);
  const physical = ED4.toString('utf8').split(/\r?\n/);
  const titles = Object.keys(trace.contests);
  assert.equal(titles.length, 25);
  let rowsChecked = 0;
  for (const title of titles) {
    for (const block of trace.contests[title]) {
      assert.ok(block.length >= 5, `${title}: header rows + precinct rows + Totals`);
      assert.match(block[2].cells.join(','), /Precincts Reporting/);
      assert.equal(block.at(-1).cells[0], 'Totals');
      for (const { line, cells } of block) {
        const row = csvParse(physical[line - 1], { relax_column_count: true, relax_quotes: true })[0] ?? [];
        assert.equal(cells[0], row[0] ?? '', `${title} line ${line}`);
        const rest = cells.slice(1).join('\u0001');
        assert.ok(row.join('\u0001').includes(rest), `${title} line ${line}: ${cells.join(',')}`);
        rowsChecked++;
      }
    }
  }
  assert.ok(rowsChecked > 1000, `${rowsChecked} rows`);
});

test('trace: a quoted cell spanning lines shifts the line numbers that follow', () => {
  const { buildTrace } = require('../src/review');
  const lines = [];
  const rows = readCsv('h\nt\n"multi\nline"\n,Mayor\n,VOTE FOR 1\n,0 of 1 Precincts Reporting\n,Ann\nP1,1\nTotals,1', lines);
  assert.equal(rows.length, 9);
  const trace = buildTrace({ rows, lines });
  assert.deepEqual(trace.contests.Mayor[0].map((x) => x.line), [5, 6, 7, 8, 9, 10]);
  assert.deepEqual(trace.contests.Mayor[0].map((x) => x.cells), [['', 'Mayor'], ['', 'VOTE FOR 1'], ['', '0 of 1 Precincts Reporting'], ['', 'Ann'], ['P1', '1'], ['Totals', '1']]);
});
