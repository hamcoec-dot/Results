'use strict';
// Layer 2 — reference parity. In LEGACY mode the Node port must reproduce the Python pipeline
// exactly on every golden case: the raw parse, every output file byte for byte (so dataVersion
// too), and verify.py's check list. The fixes are asserted separately in fixes.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { goldenCases, readGolden, caseInputs, toPlain, GOLDEN_DIR } = require('./helpers/fixtures');
const { buildResults } = require('../src/pipeline');
const { LEGACY } = require('../src/parse');
const { LEGACY_LAST_UPDATED } = require('../src/outputs');
const fs = require('node:fs');
const path = require('node:path');

const legacyRun = (caseId) => {
  const { meta, early, ed } = caseInputs(caseId);
  return buildResults({ early, ed }, {
    fixes: LEGACY,
    precinctCap: meta.precinctCap,
    config: { enablePrecinctResults: true },
    lastUpdated: LEGACY_LAST_UPDATED,
  });
};

const cases = goldenCases();
test('golden cases exist', () => assert.ok(cases.length >= 19, `${cases.length} cases`));

for (const caseId of cases) {
  test(`parity: ${caseId}`, async (t) => {
    const r = legacyRun(caseId);

    await t.test('raw parse equals parse_election_csv', () => {
      for (const slot of ['early', 'ed']) {
        const golden = readGolden(caseId, `parsed-${slot}.json`);
        if (golden === undefined) { assert.equal(r.parsed[slot], null); continue; }
        const { file_path: _f, is_ed: isEd, contests_raw: contestsRaw, ...rest } = golden;
        const { isEd: gotEd, contestsRaw: gotContests, ...gotRest } = toPlain(r.parsed[slot]);
        assert.equal(gotEd, isEd);
        assert.deepEqual(gotRest, rest);
        assert.deepEqual(gotContests, contestsRaw);
      }
    });

    await t.test('output files are byte-identical', () => {
      for (const [name, text] of Object.entries(r.outputs.files)) {
        const golden = fs.readFileSync(path.join(GOLDEN_DIR, caseId, name), 'utf8');
        assert.ok(text === golden, `${name} differs from the Python output`);
      }
    });

    await t.test('verify results equal verify.py', () => {
      const golden = readGolden(caseId, 'verify.json');
      const got = r.verify.map((c) => ({ pass: c.pass, detail: c.detail }))
        .sort((a, b) => (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : Number(a.pass) - Number(b.pass)));
      assert.deepEqual(got, golden.checks);
      assert.equal(got.filter((c) => c.pass).length, golden.passed);
      assert.equal(got.filter((c) => !c.pass).length, golden.failed);
    });
  });
}
