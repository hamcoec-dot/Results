'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The repo root holds Test_Files/. Found by walking up, so the suite also runs from a copy of
// functions/ (Stryker's sandbox, functions/.stryker-tmp/sandbox-*/).
const REPO = (() => {
  for (let d = __dirname; d !== path.dirname(d); d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'Test_Files')) && fs.existsSync(path.join(d, 'tools'))) return d;
  }
  throw new Error('repo root (with Test_Files/) not found');
})();
const GEN_FIXTURE = path.join(REPO, 'tools', 'gen-fixture');
const GOLDEN_DIR = path.join(REPO, 'functions', 'test', 'golden');
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function goldenCases() {
  if (!fs.existsSync(GOLDEN_DIR)) return [];
  return fs.readdirSync(GOLDEN_DIR).filter((d) => fs.existsSync(path.join(GOLDEN_DIR, d, 'case.json'))).sort();
}

function readGolden(caseId, file) {
  const p = path.join(GOLDEN_DIR, caseId, file);
  if (!fs.existsSync(p)) return undefined;
  const text = fs.readFileSync(p, 'utf8');
  if (file === 'data.js') {
    const m = /^\/\/ Auto-generated Election Night Results Data\nwindow\.ELECTION_DATA = (.*);\n$/s.exec(text);
    if (!m) throw new Error(`${caseId}/data.js has an unexpected wrapper`);
    return JSON.parse(m[1]);
  }
  return JSON.parse(text);
}

function pythonAvailable() {
  return spawnSync(PYTHON, ['--version'], { encoding: 'utf8' }).status === 0;
}

/** Legacy parse_election_csv over [{file, isEd}] via tools/py_parse.py. */
function pyParse(inputs) {
  const args = [path.join(REPO, 'tools', 'py_parse.py')];
  for (const { file, isEd } of inputs) args.push(file, isEd ? '1' : '0');
  const res = spawnSync(PYTHON, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`py_parse failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/** Batch call into tools/py_bridge.py: one result ({ok} or {error}) per input. */
function pyBridge(op, inputs) {
  const res = spawnSync(PYTHON, [path.join(REPO, 'tools', 'py_bridge.py')], {
    input: JSON.stringify({ op, inputs }), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`py_bridge ${op} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/** Maps -> plain objects (recursively), for comparing with JSON. */
function toPlain(v) {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, toPlain(x)]));
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
  return v;
}

/** A golden case's input CSVs as bytes ({early, ed}, null where the slot is empty). */
function caseInputs(caseId) {
  const c = readGolden(caseId, 'case.json');
  const read = (rel) => (rel ? fs.readFileSync(path.join(REPO, rel)) : null);
  return { meta: c, early: read(c.early), ed: read(c.ed) };
}

module.exports = {
  REPO, GEN_FIXTURE, GOLDEN_DIR, goldenCases, readGolden, pythonAvailable, pyParse, pyBridge, toPlain, caseInputs,
};
