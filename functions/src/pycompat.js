'use strict';
/**
 * Exact JavaScript equivalents of the Python built-ins the legacy pipeline relies on, so the
 * Node port reproduces convert_data.py / verify.py byte for byte (parity tests, layer 2).
 *
 *   PY_WS / pyStrip      str.isspace() / str.strip()
 *   pyRound2             round(x, 2) (correctly rounded, half-even on exact ties)
 *   pyFloatRepr          repr(float)
 *   pyInt / pyFloat      int(str) / float(str) for base-10 text, or null on ValueError
 *   pyCompare            default str ordering (code points, not UTF-16 units)
 *   pyDumps              json.dumps (ensure_ascii, sort_keys, separators); Maps keep insertion order
 */

// Every code point for which Python's str.isspace() is true (also what re's \s matches).
const PY_WS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'gu');

function pyStrip(s) {
  return s.replace(STRIP_RE, '');
}

/** Python round(x, 2): the decimal nearest the exact binary value, ties to even. */
function pyRound2(x) {
  // toFixed rounds the exact binary value; it differs from Python only on exact ties, where it
  // rounds away from zero. A value is an exact tie at 2 dp only if x * 8 is an integer
  // (x = n + k/8 with k odd at the third decimal), so those few cases are fixed up here.
  // (Above 2^49 every double is a multiple of 1/8 but none has a fractional part to round.)
  if (Math.abs(x) < 2 ** 49 && Number.isInteger(x * 8) && Math.abs(x).toFixed(3).endsWith('5')) {
    const s = Math.abs(x).toFixed(3);
    const cents = Number(s.slice(0, -1).replace('.', ''));
    const even = cents % 2 === 0 ? cents : cents + 1;
    return Math.sign(x) * (even / 100) || 0;
  }
  return Number(x.toFixed(2));
}

/** Python repr(float): shortest round-trip digits, exponent form when exp < -4 or >= 16. */
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mant, expStr] = Math.abs(x).toExponential().split('e');
  const exp = Number(expStr);
  const digits = mant.replace('.', '');
  let out;
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    out = `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  } else if (exp < 0) {
    out = `0.${'0'.repeat(-exp - 1)}${digits}`;
  } else if (digits.length > exp + 1) {
    out = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  } else {
    out = `${digits}${'0'.repeat(exp + 1 - digits.length)}.0`;
  }
  return x < 0 ? `-${out}` : out;
}

// Python int()/float() accept any Unicode decimal digit (category Nd). Nd digits come in
// contiguous runs of ten starting at zero, so a digit's value is its offset in its run mod 10.
const ND = /\p{Nd}/u;
const ndZero = new Map();
function digitValue(ch) {
  const cp = ch.codePointAt(0);
  let start = ndZero.get(cp);
  // Stryker disable next-line ConditionalExpression: a cache; recomputing gives the same value
  if (start === undefined) {
    start = cp;
    while (ND.test(String.fromCodePoint(start - 1))) start--;
    ndZero.set(cp, start); // Stryker disable-line all: cache only
  }
  return (cp - start) % 10;
}
const toAsciiDigits = (s) => s.replace(/\p{Nd}/gu, (d) => String(digitValue(d)));

const DIGITS = '\\p{Nd}(?:_?\\p{Nd})*';
const INT_RE = new RegExp(`^[${PY_WS}]*([+-]?${DIGITS})[${PY_WS}]*$`, 'u');
const FLOAT_RE = new RegExp(
  `^[${PY_WS}]*([+-]?(?:(?:${DIGITS})?\\.${DIGITS}|${DIGITS}\\.?)(?:[eE][+-]?${DIGITS})?)[${PY_WS}]*$`, 'u');

/** int(s) for a str, base 10; null where Python raises ValueError. */
function pyInt(s) {
  const m = INT_RE.exec(s);
  return m ? Number(toAsciiDigits(m[1]).replace(/_/g, '')) || 0 : null; // -0 -> 0, as int('-0')
}

/** float(s) for decimal text (no inf/nan spellings: callers only pass text containing '.'). */
function pyFloat(s) {
  const m = FLOAT_RE.exec(s);
  return m ? Number(toAsciiDigits(m[1]).replace(/_/g, '')) : null;
}

/**
 * Python's simple per-character lowercase (what re's IGNORECASE uses to compare backreferences).
 * Differs from case folding: 'ς' and 'σ' stay distinct, 'ſ' does not equal 's'. Keeps UTF-16
 * length: U+0130 is the only code point whose JS toLowerCase() is longer (units.test.js checks).
 */
function pyLowerChars(s) {
  let out = '';
  for (const ch of s) out += ch === 'İ' ? 'i' : ch.toLowerCase();
  return out;
}

/** Python's default str comparison: by code point. */
function pyCompare(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    if (x.value !== y.value) return x.value.codePointAt(0) - y.value.codePointAt(0);
  }
}

function escapeAscii(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += s[i];
  }
  return `${out}"`;
}

/**
 * json.dumps(value, ensure_ascii=True, sort_keys=sortKeys, separators=(itemSep, keySep)).
 * Numbers under a key in floatKeys print as Python floats (the legacy pipeline's round() results),
 * every other number as an int. A Map serializes as an object in insertion order, as a dict does.
 */
function pyDumps(value, { sortKeys = false, itemSep = ', ', keySep = ': ', floatKeys = FLOAT_KEYS } = {}) {
  const enc = (v, isFloat) => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return isFloat ? pyFloatRepr(v) : intRepr(v);
    if (typeof v === 'string') return escapeAscii(v);
    if (Array.isArray(v)) return `[${v.map((x) => enc(x, isFloat)).join(itemSep)}]`;
    let entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
    if (sortKeys) entries = entries.sort((a, b) => pyCompare(a[0], b[0]));
    return `{${entries.map(([k, x]) => `${escapeAscii(k)}${keySep}${enc(x, floatKeys.has(k))}`).join(itemSep)}}`;
  };
  return enc(value, false);
}

// Python prints a non-integral number as a float even under an int-typed key (a "12.5" vote cell).
const intRepr = (n) => (Number.isInteger(n) ? String(n) : pyFloatRepr(n)); // String(-0) is '0'

/** Keys whose values the legacy pipeline always produces as Python floats. */
const FLOAT_KEYS = new Set(['percentage', 'turnoutPercent']);

/** str(x) of a value the legacy code holds as float (f-string formatting in verify.py). */
const pyStrFloat = pyFloatRepr;

module.exports = {
  PY_WS, pyStrip, pyLowerChars, pyRound2, pyFloatRepr, pyStrFloat, pyInt, pyFloat, pyCompare, pyDumps, FLOAT_KEYS, toAsciiDigits,
};
