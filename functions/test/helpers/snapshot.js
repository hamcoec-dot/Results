'use strict';
// Snapshots of user-facing output (check titles and details, validation errors): the text a
// reviewer reads on election night is part of the contract. A missing or changed snapshot fails;
// after an intended wording change, refresh with:  UPDATE_SNAPSHOTS=1 npm test  and review the diff.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const DIR = path.join(__dirname, '..', 'snapshots');

function matchSnapshot(name, value) {
  const file = path.join(DIR, `${name}.json`);
  const text = `${JSON.stringify(value, null, 1)}\n`;
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `snapshot ${name}.json missing: run UPDATE_SNAPSHOTS=1 npm test and review it`);
  assert.deepEqual(value, JSON.parse(fs.readFileSync(file, 'utf8')), `${name} differs from its snapshot`);
}

module.exports = { matchSnapshot };
