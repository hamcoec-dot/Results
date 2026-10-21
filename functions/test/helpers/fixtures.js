'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const GOLDEN_DIR = path.join(__dirname, '..', 'golden');
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

module.exports = { REPO, GOLDEN_DIR, goldenCases, readGolden, pythonAvailable, pyParse };
