'use strict';
// Integrity of the Python golden outputs (tools/make_golden.py) that the Node port is held to.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, goldenCases, readGolden } = require('./helpers/fixtures');

const cases = goldenCases();
const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');

test('golden set covers every fixture family', () => {
  assert.ok(cases.length >= 19, `expected >= 19 golden cases, found ${cases.length}`);
  for (const family of ['samples-92-', 'samples-94-', 'testfiles-']) {
    assert.ok(cases.some((c) => c.startsWith(family)), `no golden case for ${family}`);
  }
  for (const step of ['00-zero', '01-nh-abs', '02-ev', '03-5-reporting', '04-10-reporting', '05-end-ed', '06-end-provisional']) {
    assert.ok(cases.includes(`samples-92-${step}`) && cases.includes(`samples-94-${step}`), `missing sample step ${step}`);
  }
});

test('every CSV in Test_Files/ is covered by a golden case (add new files to tools/make_golden.py)', () => {
  const used = new Set(cases.flatMap((id) => {
    const m = readGolden(id, 'case.json');
    return [m.early, m.ed].filter(Boolean);
  }));
  const walk = (dir) => fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.csv$/i.test(e.name) ? [`${dir}/${e.name}`] : []));
  const missing = walk('Test_Files').filter((f) => !used.has(f));
  assert.deepEqual(missing, []);
});

for (const id of cases) {
  test(`golden ${id}`, async (t) => {
    const meta = readGolden(id, 'case.json');

    await t.test('inputs exist and are unchanged since generation (else re-run npm run golden)', () => {
      assert.ok(meta.early || meta.ed, 'case has no input');
      if (meta.early) assert.equal(sha256(meta.early), meta.earlySha256, `${meta.early} changed`);
      if (meta.ed) assert.equal(sha256(meta.ed), meta.edSha256, `${meta.ed} changed`);
    });

    await t.test('legacy verify.py passed', () => {
      const v = readGolden(id, 'verify.json');
      assert.equal(v.failed, 0, v.checks.filter((c) => !c.pass).map((c) => c.detail).join('\n'));
      assert.ok(v.passed > 0);
    });

    await t.test('output files are mutually consistent', () => {
      const summary = readGolden(id, 'summary.json');
      const reporting = readGolden(id, 'reporting.json');
      const precincts = readGolden(id, 'precincts.json');
      const bundle = readGolden(id, 'data.js');

      for (const f of [reporting, precincts, bundle]) {
        assert.deepEqual(f.metadata, summary.metadata);
        assert.deepEqual(f.config, summary.config);
      }
      assert.equal(bundle.latest.dataVersion, summary.metadata.dataVersion);
      assert.match(summary.metadata.dataVersion, /^[0-9a-f]{12}$/);

      const titles = bundle.latest.contests.map((c) => c.title);
      assert.deepEqual(summary.latest.contests.map((c) => c.title), titles);
      assert.deepEqual(reporting.latest.contests.map((c) => c.title), titles);
      assert.deepEqual(precincts.contests.map((c) => c.title), titles);
      assert.deepEqual(reporting.masterPrecincts, bundle.latest.masterPrecincts);

      for (const c of bundle.latest.contests) {
        assert.equal(c.totalVotes, c.candidates.reduce((s, x) => s + x.votes, 0), `${c.title} total`);
        assert.ok(c.precinctsReporting <= c.precinctsTotal, `${c.title} reporting > total`);
      }
    });

    await t.test('parsed snapshots match the inputs', () => {
      if (meta.early) assert.ok(readGolden(id, 'parsed-early.json'), 'parsed-early.json missing');
      if (meta.ed) assert.ok(readGolden(id, 'parsed-ed.json'), 'parsed-ed.json missing');
    });
  });
}
