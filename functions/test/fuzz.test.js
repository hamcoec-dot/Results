'use strict';
// Layer 4 — malformed input. Real exports are mutated (truncated, lines dropped / duplicated /
// swapped, junk and stray quotes inserted, bytes corrupted) and fed to the pipeline:
//   - it returns a result or throws only CsvError / ParseError (which createDraft turns into a
//     block check) — never an uncaught TypeError and never a hang (2 s per case);
//   - the raw parse equals the Python parser's on the same bytes, errors included.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fc, fcParams } = require('./helpers/fc-config');
const { REPO, pythonAvailable, pyBridge, toPlain } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { parseElectionCsv, LEGACY } = require('../src/parse');
const { readCsv, CsvError } = require('../src/csv');
const { generateElection, toCsv } = require(require('./helpers/fixtures').GEN_FIXTURE);

const SAMPLES = path.join(REPO, 'Test_Files', 'Web Results Samples');
const SEEDS = [
  path.join(SAMPLES, '03-After 5 Reporting (92).csv'),
  path.join(SAMPLES, '00-Zero File (94).csv'),
  path.join(REPO, 'Test_Files', 'ED test.csv'),
].map((f) => fs.readFileSync(f));
const N = Math.min(fcParams().numRuns, 500); // each case parses a full export

const EXPECTED_ERRORS = new Set(['CsvError', 'ParseError']);
const junk = fc.oneof(
  fc.constantFrom('"', '""', ',', ',,,,', '\n', '\r', '\r\n', 'Totals', 'Totals,1,2', 'STATISTICS',
    '1 of 2 Precincts Reporting', 'Precincts Reporting', 'VOTE FOR 2', 'REP ', 'Write-in Totals', '﻿', '\x00', '-1', '1.5', '9'.repeat(25)),
  fc.string({ maxLength: 12 }),
);

/** One mutation of a byte buffer (applied to its lines where that makes sense). */
const mutation = fc.oneof(
  fc.record({ op: fc.constant('truncate'), at: fc.double({ min: 0, max: 1, noNaN: true }) }),
  fc.record({ op: fc.constantFrom('dropLine', 'dupLine', 'swapLines', 'blankLine'), at: fc.nat(), at2: fc.nat() }),
  fc.record({ op: fc.constant('insert'), at: fc.nat(), text: junk }),
  fc.record({ op: fc.constant('byte'), at: fc.nat(), value: fc.integer({ min: 0, max: 255 }) }),
);

function mutate(buf, muts) {
  let b = Buffer.from(buf);
  for (const m of muts) {
    if (m.op === 'truncate') { b = b.subarray(0, Math.floor(b.length * m.at)); continue; }
    if (m.op === 'byte') { if (b.length) { b = Buffer.from(b); b[m.at % b.length] = m.value; } continue; }
    if (m.op === 'insert') {
      const at = b.length ? m.at % b.length : 0;
      b = Buffer.concat([b.subarray(0, at), Buffer.from(m.text), b.subarray(at)]);
      continue;
    }
    const lines = b.toString('latin1').split('\n');
    const i = m.at % lines.length;
    const j = m.at2 % lines.length;
    if (m.op === 'dropLine') lines.splice(i, 1);
    else if (m.op === 'dupLine') lines.splice(i, 0, lines[i]);
    else if (m.op === 'blankLine') lines[i] = '';
    else [lines[i], lines[j]] = [lines[j], lines[i]];
    b = Buffer.from(lines.join('\n'), 'latin1');
  }
  return b;
}

const caseArb = fc.record({
  seed: fc.nat({ max: SEEDS.length - 1 }),
  muts: fc.array(mutation, { minLength: 1, maxLength: 6 }),
  isEd: fc.boolean(),
}).map(({ seed, muts, isEd }) => ({ bytes: mutate(SEEDS[seed], muts), isEd }));

function timed(fn, limitMs = 2000) {
  const t0 = performance.now();
  try { return { value: fn() }; } catch (e) { return { error: e }; } finally {
    const ms = performance.now() - t0;
    assert.ok(ms < limitMs, `took ${Math.round(ms)} ms (limit ${limitMs})`);
  }
}

test('mutated exports: pipeline never crashes or hangs', () => {
  for (const { bytes, isEd } of fc.sample(caseArb, N)) {
    const r = timed(() => buildResults(isEd ? { early: SEEDS[0], ed: bytes } : { early: bytes, ed: null }, { lastUpdated: 'x' }));
    if (r.error) {
      assert.ok(EXPECTED_ERRORS.has(r.error.name), `unexpected ${r.error.name}: ${r.error.message}\n${r.error.stack}`);
      continue;
    }
    if (r.value === null) continue;
    for (const text of Object.values(r.value.outputs.files)) assert.equal(typeof text, 'string');
    JSON.parse(r.value.outputs.files['summary.json']);
    assert.ok(Array.isArray(r.value.verify));
  }
});

test('mutated exports: raw parse equals the Python parser (errors included)', { skip: !pythonAvailable() && 'python not found' }, () => {
  const cases = fc.sample(caseArb, N);
  const py = pyBridge('parse', cases.map(({ bytes, isEd }) => [bytes.toString('base64'), isEd]));
  cases.forEach(({ bytes, isEd }, i) => {
    const js = timed(() => parseElectionCsv(bytes, { isEd, fixes: LEGACY }));
    const label = `case ${i} (${bytes.length} bytes, isEd=${isEd})`;
    if (py[i].error) {
      assert.ok(js.error, `${label}: Python raised ${py[i].error}, JS returned a result`);
      return;
    }
    if (js.error && /longer than/.test(js.error.message)) return; // title guard: Python would grind on
    assert.ok(!js.error, `${label}: JS raised ${js.error?.message}`);
    if (py[i].ok === null) { assert.equal(js.value, null, label); return; }
    const { isEd: e, contestsRaw, ...rest } = toPlain(js.value);
    const { is_ed: pe, contests_raw: pcr, ...prest } = py[i].ok;
    assert.equal(e, pe);
    assert.deepEqual(rest, prest, label);
    assert.deepEqual(contestsRaw, pcr, label);
  });
});

test('arbitrary bytes and text never crash the pipeline', () => {
  const anyInput = fc.oneof(
    fc.uint8Array({ maxLength: 2000 }).map((u) => Buffer.from(u)),
    fc.string({ maxLength: 2000 }),
    fc.array(fc.array(junk, { maxLength: 8 }).map((r) => r.join(',')), { maxLength: 40 }).map((rows) => rows.join('\n')),
  );
  for (const input of fc.sample(anyInput, N * 4)) {
    const r = timed(() => buildResults({ early: null, ed: input }, { lastUpdated: 'x' }));
    if (r.error) assert.ok(EXPECTED_ERRORS.has(r.error.name), `unexpected ${r.error.name}: ${r.error.message}`);
  }
});

test('size limits: a 5 MB export parses in time; an oversized field is a CsvError', () => {
  const big = toCsv(generateElection({ seed: 9, kind: 'ed', precincts: 150, contests: 60, maxCandidates: 12, layout: 'wide' }));
  const reps = Math.ceil(5_000_000 / big.length);
  // Many elections back to back: still a well-formed sequence of contest blocks.
  const five = big + big.split('\n').slice(3).join('\n').repeat(reps - 1);
  assert.ok(five.length >= 5_000_000);
  // Budget: createDraft on the largest upload, p95 < 5 s (plan: Performance requirements). Under
  // c8 (NODE_V8_COVERAGE) the code is instrumented and ~2-3x slower, so there it only proves no hang.
  const r = timed(() => buildResults({ early: null, ed: five }, { lastUpdated: 'x' }), process.env.NODE_V8_COVERAGE ? 15000 : 5000);
  assert.ok(r.value, r.error?.message);
  assert.throws(() => readCsv(`"${'x'.repeat(131073)}"`), CsvError);
  assert.doesNotThrow(() => readCsv(`"${'x'.repeat(131072)}"`));
});
