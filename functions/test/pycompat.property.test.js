'use strict';
// Layer 2/3 — the Python built-ins the port re-implements, checked against Python itself on random
// inputs (one Python process per property, batched). Python missing -> skipped locally; CI has it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fc, fcParams } = require('./helpers/fc-config');
const { pythonAvailable, pyBridge } = require('./helpers/fixtures');
const { pyRound2, pyFloatRepr, pyDumps } = require('../src/pycompat');
const { cleanNum, cleanContestName, statsTurnout } = require('../src/parse');
const { readCsv } = require('../src/csv');

const skip = !pythonAvailable() && 'python not found';
const N = Math.min(fcParams().numRuns, 5000);
const sample = (arb, n = N) => fc.sample(arb, { numRuns: n, ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}) });

/** The bridge sends non-finite floats as "inf" / "-inf" / "nan"; do the same to JS results. */
const nonFinite = (v) => (typeof v === 'number' && !Number.isFinite(v) ? (Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf')
  : Array.isArray(v) ? v.map(nonFinite)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nonFinite(x)])) : v);

/** Assert JS(x) equals Python(x) for every sampled x; Python errors must be JS errors too. */
function agree(op, inputs, js) {
  const py = pyBridge(op, inputs);
  inputs.forEach((x, i) => {
    let got;
    try { got = { ok: nonFinite(js(x)) }; } catch (e) { got = { error: e.name }; }
    if (py[i].error) assert.ok(got.error, `${op}(${JSON.stringify(x)}): Python raised ${py[i].error}, JS returned ${JSON.stringify(got.ok)}`);
    else assert.deepEqual(got, py[i], `${op}(${JSON.stringify(x)})`);
  });
}

// Characters that exercise whitespace, unicode digits, separators and case folding.
const tricky = fc.constantFrom(' ', '\t', ' ', ' ', '　', '\x85', '\x1c', '﻿', ',', '.', '_', '-', '+',
  '0', '7', '٣', '５', 'e', 'E', 'a', 'Z', 'é', 'É', 'ß', 'İ', 'ſ', 'K', 'K', '#', '"', "'", '\n', '😀');
const word = fc.constantFrom('District', 'district', 'DISTRICT', '28', 'East', 'Ridge', 'Mayor', 'Board', 'Référendum',
  'REFERENDUM', 'Council', 'of', 'Ōta', 'Σίσυφος', 'ΣΊΣΥΦΟΣ', '１２');
const mixed = fc.array(fc.oneof(tricky, word, fc.string({ maxLength: 3 })), { maxLength: 12 }).map((a) => a.join(''));
const sepWords = fc.array(fc.oneof(word, word, tricky), { maxLength: 10 }).map((a) => a.join(' '));

test('STATISTICS turnout matches Python, ints past 2^53 included (exact int division)', { skip }, () => {
  const digits = (min, max) => fc.integer({ min, max }).chain((n) => fc.array(fc.constantFrom(...'0123456789'), { minLength: n, maxLength: n }))
    .map((a) => a.join('').replace(/^0+(?=.)/, ''));
  const cell = fc.oneof(
    digits(1, 6),
    digits(15, 40),
    digits(16, 30).map((s) => BigInt(s).toLocaleString('en-US')),
    fc.tuple(digits(1, 20), digits(1, 3)).map(([a, b]) => `${a}.${b}`),
    fc.constantFrom('0', '-0', '', 'x', '9007199254740993', '-100000000000000000000000007'),
  );
  agree('stats_turnout', sample(fc.tuple(cell, cell)), ([b, v]) => pyFloatRepr(statsTurnout(b, v)));
  // A tie at the third decimal past 2^53 cents (pyRound2 used to lose the last digit there).
  assert.equal(pyFloatRepr(pyRound2(379441490032668.125)), '379441490032668.1');
  // The fuzz case that found it: 1e26 + 7 ballots over 1,923 voters.
  assert.equal(pyFloatRepr(statsTurnout('100000000000000000000000007', '1923')), '5.200208008320333e+24');
});

test('round(x, 2) on exact ties (x = n + k/8) at every magnitude up to 2^49 matches Python', { skip }, () => {
  const tie = fc.tuple(fc.integer({ min: 0, max: 48 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(1, 3, 5, 7), fc.boolean())
    .map(([e, f, k, neg]) => (neg ? -1 : 1) * (Math.floor(f * 2 ** e) + k / 8));
  agree('round2', sample(tie), (x) => pyFloatRepr(pyRound2(x)));
});

test('clean_num matches Python', { skip }, () => {
  const numLike = fc.oneof(
    fc.integer({ min: -1e15, max: 1e15 }).map((n) => n.toLocaleString('en-US')),
    fc.array(fc.constantFrom('1', '2', '0', '9', ',', '.', '_', ' ', '-', '+', 'e', '٣', ' '), { maxLength: 10 }).map((a) => a.join('')),
    mixed,
  );
  agree('clean_num', sample(numLike), cleanNum);
});

test('clean_contest_name matches Python', { skip }, () => {
  const titles = fc.oneof(sepWords, mixed, sepWords.map((s) => `${s} ${s}`), word.chain((w) => sepWords.map((s) => `${w} ${s} ${w}`)));
  agree('clean_contest_name', sample(titles), cleanContestName);
});

test('round(x, 2) and repr(float) match Python', { skip }, () => {
  const floats = fc.oneof(
    fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }),
    fc.tuple(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 1, max: 100000 })).map(([a, b]) => (a / b) * 100),
    fc.integer({ min: -800, max: 800 }).map((k) => k / 8), // exact ties
    fc.double({ noNaN: true }),
  );
  // JSON cannot carry inf/nan or -0 to Python; those three are unit-tested in pycompat.test.js.
  const xs = sample(floats).filter((x) => Number.isFinite(x) && !Object.is(x, -0));
  agree('round2', xs, (x) => pyFloatRepr(pyRound2(x)));
  agree('float_repr', xs, pyFloatRepr);
});

test('json.dumps(sort_keys=True) matches Python', { skip }, () => {
  const key = fc.oneof(fc.string({ maxLength: 4 }), fc.fullUnicodeString({ maxLength: 3 }), fc.constantFrom('12', '2', 'b', 'é', '😀', '￿'));
  const leaf = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.fullUnicodeString({ maxLength: 6 }));
  const value = fc.letrec((tie) => ({
    v: fc.oneof({ depthSize: 'small' }, leaf, fc.array(tie('v'), { maxLength: 4 }), fc.dictionary(key, tie('v'), { maxKeys: 5 })),
  })).v;
  agree('dumps', sample(value, Math.min(N, 2000)), (x) => pyDumps(x, { sortKeys: true }));
});

test('csv reader matches Python csv.reader on arbitrary bytes and text', { skip }, () => {
  const csvChar = fc.constantFrom('a', 'b', ' ', ',', ',', '"', '"', '\n', '\r', '\r\n', '\t', 'é', '😀', '﻿', ' ', '\x00');
  const text = fc.array(csvChar, { maxLength: 40 }).map((a) => a.join(''));
  const bytes = fc.oneof(
    text.map((t) => Buffer.from(t, 'utf8')),
    fc.uint8Array({ maxLength: 40 }).map((u) => Buffer.from(u)),
    fc.tuple(text, fc.uint8Array({ maxLength: 4 }), text).map(([a, b, c]) => Buffer.concat([Buffer.from(a), Buffer.from(b), Buffer.from(c)])),
    fc.tuple(fc.constantFrom('﻿', '﻿﻿', ''), text).map(([bom, t]) => Buffer.from(bom + t)),
  );
  const inputs = sample(bytes);
  agree('csv', inputs.map((b) => b.toString('base64')), (b64) => readCsv(Buffer.from(b64, 'base64')));
});
