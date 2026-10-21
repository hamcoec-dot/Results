'use strict';
// Layer 2 on generated input: Node's LEGACY parse + merge equals Python's parse_election_csv +
// merge_parsed_data — every field and the dataVersion hash — on (a) random elections, Early -> ED
// pairs included, and (b) real exports with precinct rows dropped or repeated, which give the
// partial "precincts with entries" maps that drive legacy's reporting overrides.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fc, fcParams } = require('./helpers/fc-config');
const { electionArb, csvOptsArb } = require('./helpers/arbitraries');
const { REPO, GEN_FIXTURE, pythonAvailable, pyBridge, toPlain } = require('./helpers/fixtures');
const { parseElectionCsv, LEGACY } = require('../src/parse');
const { mergeParsedData } = require('../src/merge');

const { deriveEarly, toCsv } = require(GEN_FIXTURE);
const skip = !pythonAvailable() && 'python not found';
const N = Math.min(fcParams().numRuns, 300);
const seedOpt = process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {};

function nodeMerge(early, ed) {
  const p = (b, isEd) => (b === null ? null : parseElectionCsv(b, { isEd, fixes: LEGACY }));
  const r = mergeParsedData(p(early, false), p(ed, true), { fixes: LEGACY });
  return r && JSON.parse(JSON.stringify(toPlain(r.data)));
}

function agree(pairs) {
  const py = pyBridge('merge', pairs.map(([e, d]) => [e && e.toString('base64'), d && d.toString('base64')]));
  pairs.forEach(([e, d], i) => {
    assert.ok(!py[i].error, `case ${i}: Python raised ${py[i].error}`);
    const js = nodeMerge(e, d);
    if (py[i].ok === null) { assert.equal(js, null); return; }
    assert.equal(js.dataVersion, py[i].ok.dataVersion, `case ${i}: dataVersion`);
    assert.deepEqual(js, py[i].ok, `case ${i}`);
  });
}

test('legacy merge equals Python on generated elections (Early -> ED pairs)', { skip }, () => {
  const cases = fc.sample(fc.tuple(electionArb, csvOptsArb), { numRuns: N, ...seedOpt }).map(([{ model }, co]) => (model.kind === 'ed'
    ? [Buffer.from(toCsv(deriveEarly(model), co)), Buffer.from(toCsv(model, co))]
    : [Buffer.from(toCsv(model, co)), null]));
  agree(cases);
});

test('legacy merge equals Python on real exports with precinct rows dropped or repeated', { skip }, () => {
  const S = (n) => fs.readFileSync(path.join(REPO, 'Test_Files', 'Web Results Samples', n));
  const early = S('02-After EV (92).csv');
  const eds = [S('03-After 5 Reporting (92).csv'), S('05-End of Election Day (92).csv'), fs.readFileSync(path.join(REPO, 'Test_Files', 'ED test.csv'))];
  const edit = fc.record({
    src: fc.nat({ max: eds.length - 1 }),
    ops: fc.array(fc.tuple(fc.boolean(), fc.nat()), { maxLength: 40 }),
    gone: fc.array(fc.constantFrom('AIRPORT A', 'TYNER', 'WALDEN', 'ST ELMO', 'HIXSON A', 'SODDY DAISY A'), { maxLength: 3 }),
    withEarly: fc.boolean(),
  });
  const cases = fc.sample(edit, { numRuns: Math.min(N, 150), ...seedOpt }).map(({ src, ops, gone, withEarly }) => {
    // Dropping a precinct from every contest block leaves no contest complete (legacy's
    // "largest contest complete -> all complete" rule otherwise hides partial maps).
    let lines = eds[src].toString('utf8').split('\n');
    const body = lines.findIndex((l) => l.includes('Precincts Reporting')) + 2; // first precinct row
    lines = lines.slice(0, body).concat(lines.slice(body).filter((l) => !gone.some((p) => l.startsWith(`${p},`))));
    for (const [drop, at] of ops) {
      const i = body + (at % (lines.length - body - 1)); // contest blocks only
      if (!/^[A-Z]/.test(lines[i]) || lines[i].startsWith('Totals')) continue; // precinct rows only
      if (drop) lines.splice(i, 1);
      else lines.splice(i, 0, lines[i]);
    }
    return [withEarly ? early : null, Buffer.from(lines.join('\n'))];
  });
  agree(cases);
});
