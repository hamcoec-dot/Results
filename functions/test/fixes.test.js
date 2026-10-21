'use strict';
// The legacy defects D1-D4 (TESTING.md), each asserted on its own, separately from parity.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse: csvParse } = require('csv-parse/sync');
const { goldenCases, caseInputs, toPlain } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { FIXES, LEGACY, cleanContestName } = require('../src/parse');
const { formatLastUpdated, LEGACY_LAST_UPDATED } = require('../src/outputs');

const run = (input, fixes = FIXES, extra = {}) => buildResults(input, {
  fixes, precinctCap: 92, config: { enablePrecinctResults: true }, lastUpdated: LEGACY_LAST_UPDATED, ...extra,
});
const runCase = (caseId, fixes, extra) => {
  const { early, ed } = caseInputs(caseId);
  return run({ early, ed }, fixes, extra);
};
const only = (k) => ({ ...LEGACY, [k]: true });
const edCases = goldenCases().filter((c) => caseInputs(c).meta.ed);

/**
 * Independent D1 oracle (csv-parse, no port code): per contest, the precincts whose cells in the
 * contest's candidate columns are not all zero and differ from the Early file's cells. Write-ins
 * are not results (never published), so their columns are ignored. A precinct belongs to a
 * contest when it has any non-blank cell there (side-by-side contests share precinct rows).
 * Titles are keyed through cleanContestName (proven against Python in pycompat.property.test.js).
 */
function oracleReported(edBuf, earlyBuf) {
  const cells = (buf) => {
    const rows = csvParse(buf, { bom: true, relax_column_count: true, relax_quotes: true });
    const out = new Map(); // title -> {rep, tot, precincts: Map(name -> cells)}
    for (let i = 0; i < rows.length; i++) {
      const cols = rows[i].map((c, k) => (c.includes('Precincts Reporting') ? k : -1)).filter((k) => k >= 0);
      if (!cols.length) continue;
      let end = i + 2;
      while (rows[end][0] !== 'Totals') end++;
      cols.forEach((col, k) => {
        const stop = k + 1 < cols.length ? cols[k + 1] : rows[i + 1].length;
        const [, rep, tot] = /(\d+) of (\d+)/.exec(rows[i][col]);
        const title = cleanContestName(rows[i - 2][col]);
        const c = out.get(title) ?? { rep: +rep, tot: +tot, precincts: new Map() };
        const candCols = [];
        for (let x = col; x < stop; x++) if (rows[i + 1][x].trim() && !/write-in/i.test(rows[i + 1][x])) candCols.push(x);
        for (let d = i + 2; d < end; d++) {
          const p = rows[d][0].trim();
          const v = candCols.map((x) => (rows[d][x] ?? '').trim());
          if (p && v.some((x) => x !== '')) c.precincts.set(p, [...(c.precincts.get(p) ?? []), ...v]);
        }
        out.set(title, c);
      });
      i = end;
    }
    return out;
  };
  const ed = cells(edBuf);
  const early = earlyBuf ? cells(earlyBuf) : new Map();
  const res = new Map();
  for (const [title, c] of ed) {
    const e = early.get(title)?.precincts ?? new Map();
    const reported = c.rep >= c.tot && c.tot > 0
      ? [...c.precincts.keys()]
      : [...c.precincts].filter(([p, v]) => v.some((x) => x !== '' && x !== '0') && JSON.stringify(v) !== JSON.stringify(e.get(p))).map(([p]) => p);
    res.set(title, { rep: c.rep, tot: c.tot, reported: reported.sort() });
  }
  return res;
}

test('D1: each contest reports exactly the precincts the export shows, and R of T as written', async (t) => {
  for (const caseId of edCases) {
    await t.test(caseId, () => {
      const { early, ed } = caseInputs(caseId);
      const r = run({ early, ed }, only('d1'));
      const oracle = oracleReported(ed, early);
      assert.deepEqual(r.diagnostics.reportingMismatches, []);
      assert.equal(r.merged.contests.length, oracle.size);
      for (const c of r.merged.contests) {
        const o = oracle.get(c.title);
        assert.deepEqual(c.precinctsStatus.filter((p) => p.reported).map((p) => p.name).sort(), o.reported, c.title);
        assert.equal(c.precinctsReporting, Math.min(o.rep, 92), `${c.title} count`);
        assert.equal(c.precinctsTotal, Math.min(o.tot, 92));
        assert.deepEqual(c.precinctsStatusIndexed.filter(([, f]) => f).length, c.precinctsStatus.filter((p) => p.reported).length);
      }
    });
  }
});

test('D1: "5 of 92" publishes 5 named precincts, not 92 (legacy overstated it)', () => {
  const fixed = runCase('samples-92-03-5-reporting', FIXES);
  const legacy = runCase('samples-92-03-5-reporting', LEGACY);
  const gov = (r) => r.merged.contests.find((c) => c.title === 'Governor');
  assert.equal(gov(legacy).precinctsReporting, 92);
  assert.equal(gov(fixed).precinctsReporting, 5);
  assert.equal(fixed.merged.overallPrecinctsReporting, 5);
  assert.deepEqual(gov(fixed).precinctsStatus.filter((p) => p.reported).map((p) => p.name),
    ['SIGNAL MOUNTAIN A', 'SODDY DAISY A', 'SODDY DAISY B', 'ST ELMO', 'TYNER']);
});

test('D1: an ED file with no Early upload uses non-zero votes alone', () => {
  const r = runCase('testfiles-ed-only', FIXES);
  assert.deepEqual(r.diagnostics.reportingMismatches, []);
  assert.ok(r.merged.contests.every((c) => c.precinctsStatus.filter((p) => p.reported).length === c.precinctsReporting));
});

test('D1: a count the precincts cannot explain is reported as a mismatch, keeping the CSV count', () => {
  const { early, ed } = caseInputs('samples-92-03-5-reporting');
  const edited = ed.toString('utf8').replace(/,5 of 92 Precincts Reporting,/, ',6 of 92 Precincts Reporting,');
  const r = run({ early, ed: edited });
  const m = r.diagnostics.reportingMismatches;
  assert.equal(m.length, 1);
  assert.equal(m[0].contest, 'Governor');
  assert.equal(m[0].csvReporting, 6);
  assert.equal(m[0].inferred.length, 5);
  assert.equal(r.merged.contests.find((c) => c.title === 'Governor').precinctsReporting, 6);
});

test('D1 off: the legacy overrides still apply (parity mode)', () => {
  const r = runCase('samples-92-03-5-reporting', LEGACY);
  assert.ok(r.merged.contests.every((c) => c.precinctsReporting === c.precinctsTotal));
});

test('D2: county and status come from the last header cell (8-column export)', () => {
  const { early, ed } = caseInputs('testfiles-ev-ed');
  const relabel = (buf) => buf.toString('utf8')
    .replace(/^Custom Table Report,,,,,,,UNOFFICIAL RESULTS/, 'Custom Table Report,,,,,,,OFFICIAL RESULTS')
    .replace(/^("August 6, 2026",,,,,,,)Hamilton/m, '$1Marion');
  const fixed = run({ early, ed: relabel(ed) }, only('d2'));
  const legacy = run({ early, ed: relabel(ed) }, LEGACY);
  assert.equal(fixed.merged.county, 'Marion');
  assert.equal(fixed.merged.statusLabel, 'OFFICIAL RESULTS');
  assert.equal(legacy.merged.county, 'Hamilton', 'legacy reads column 4 and falls back');
  assert.equal(legacy.merged.statusLabel, 'UNOFFICIAL RESULTS');
  const strip = (m) => ({ ...toPlain(m), county: null, statusLabel: null });
  assert.deepEqual(strip(fixed.merged), strip(legacy.merged), 'd2 changes nothing else');
  assert.ok(fixed.verify.every((c) => c.pass), 'verify agrees');
});

test('D2: 5-column export and a header with no county keep their values / the default', () => {
  assert.equal(runCase('samples-92-02-ev', only('d2')).merged.county, 'Hamilton');
  const { ed } = caseInputs('samples-92-06-ed-only');
  const noCounty = ed.toString('utf8').replace(/^("November 3, 2026",,,,)Hamilton/m, '$1');
  assert.equal(run({ early: null, ed: noCounty }).merged.county, 'Hamilton');
});

test('D3: 5-column exports now carry per-precinct turnout, matching the CSV', async (t) => {
  for (const caseId of goldenCases().filter((c) => c.startsWith('samples-'))) {
    await t.test(caseId, () => {
      const { early, ed } = caseInputs(caseId);
      const fixed = run({ early, ed }, only('d3'));
      const legacy = run({ early, ed }, LEGACY);
      assert.equal(legacy.merged.precinctStats.size, 0, 'legacy reads no narrow stats');

      // Independent read of the STATISTICS block: rows between the first STATISTICS and Totals.
      const rows = csvParse(ed ?? early, { bom: true, relax_column_count: true });
      const expected = new Map();
      for (const row of rows.slice(rows.findIndex((r) => r.includes('STATISTICS')) + 1, rows.findIndex((r) => r[0] === 'Totals'))) {
        const k = row[0] ? 0 : 1;
        const [name, voters, ballots] = [row[k], Number(row[k + 1].replace(/,/g, '')), Number(row[k + 2]?.replace(/,/g, ''))];
        if (name && name !== 'STATISTICS' && name !== 'Registered Voters - Total' && (voters > 0 || ballots > 0)) {
          expected.set(name, { voters, ballots });
        }
      }
      assert.ok(expected.size >= 90);
      assert.deepEqual([...fixed.merged.precinctStats].map(([n, s]) => [n, { voters: s.voters, ballots: s.ballots }]), [...expected]);
      const { precinctStats: _a, ...a } = toPlain(fixed.merged);
      const { precinctStats: _b, ...b } = toPlain(legacy.merged);
      assert.deepEqual(a, b, 'd3 changes nothing else (masterPrecincts already listed every precinct)');
    });
  }
});

test('D3: 8-column stats are unchanged (still identical to legacy)', () => {
  const a = runCase('testfiles-ev-ed', only('d3'));
  const b = runCase('testfiles-ev-ed', LEGACY);
  assert.deepEqual(toPlain(a.merged.precinctStats), toPlain(b.merged.precinctStats));
});

test('D4: lastUpdated is the real time in America/New_York, in the placeholder format', () => {
  assert.equal(formatLastUpdated(new Date('2026-11-04T01:45:00Z')), 'November 3, 2026 08:45 PM'); // EST
  assert.equal(formatLastUpdated(new Date('2026-08-07T04:05:00Z')), 'August 7, 2026 12:05 AM'); // EDT
  assert.equal(formatLastUpdated(new Date('2026-08-06T16:30:00Z')), 'August 6, 2026 12:30 PM');
  const { early, ed } = caseInputs('samples-92-03-5-reporting');
  const before = Date.now();
  const r = buildResults({ early, ed });
  const meta = JSON.parse(r.outputs.files['summary.json']).metadata;
  assert.notEqual(meta.lastUpdated, LEGACY_LAST_UPDATED);
  assert.ok([before, Date.now()].map((t) => formatLastUpdated(new Date(t))).includes(meta.lastUpdated));
});

test('dataVersion ignores lastUpdated (same inputs, same version and bytes)', () => {
  const { early, ed } = caseInputs('samples-92-04-10-reporting');
  const a = buildResults({ early, ed }, { lastUpdated: 'A' });
  const b = buildResults({ early, ed }, { lastUpdated: 'B' });
  assert.equal(a.merged.dataVersion, b.merged.dataVersion);
  assert.equal(a.outputs.files['data.js'].replace('"A"', '"B"'), b.outputs.files['data.js']);
});

test('fixed pipeline passes its own verify on every golden case', async (t) => {
  for (const caseId of goldenCases()) {
    await t.test(caseId, () => {
      const failed = runCase(caseId, FIXES).verify.filter((c) => !c.pass);
      assert.deepEqual(failed, []);
    });
  }
});

test('precinctCap: max precincts comes from the election, and is published in config', () => {
  const { early, ed } = caseInputs('samples-94-03-5-reporting');
  const r = buildResults({ early, ed }, { precinctCap: 94 });
  assert.equal(r.merged.overallPrecinctsTotal, 94);
  assert.equal(r.merged.overallPrecinctsReporting, 5);
  assert.deepEqual(JSON.parse(r.outputs.files['summary.json']).config, { enablePrecinctResults: true, precinctCap: 94 });
  assert.ok(r.verify.every((c) => c.pass));
  const capped = buildResults({ early, ed }, { precinctCap: 92 });
  assert.equal(capped.merged.overallPrecinctsTotal, 92);
});
