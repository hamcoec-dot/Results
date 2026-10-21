'use strict';
/**
 * CSV reader that returns exactly what the legacy read_csv_robust() returns:
 *   open(path, encoding='utf-8-sig', errors='ignore') + csv.reader (excel dialect).
 *
 * The record parser is a port of CPython's Modules/_csv.c state machine rather than a general CSV
 * library, because parity on malformed exports matters more than RFC 4180 strictness: Python keeps
 * text after a closing quote ("ab"c -> abc), returns [] for a blank line, and keeps an unterminated
 * quoted field at end of input. Text mode first turns \r\n and lone \r into \n (universal newlines).
 */

const FIELD_LIMIT = 131072; // csv.field_size_limit() default

class CsvError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = 'CsvError';
    this.line = line;
  }
}

const REPLACEMENT = '�';
const GENUINE_FFFD = Buffer.from([0xef, 0xbf, 0xbd]);

/** UTF-8 decode that drops invalid bytes (errors='ignore') and one leading BOM ('utf-8-sig'). */
function decodeUtf8Ignore(input) {
  // utf-8-sig looks for the BOM in the raw bytes, before any invalid byte is dropped.
  const buf = input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? input.subarray(3) : input;
  const decode = (b) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b).replaceAll(REPLACEMENT, '');
  // A real U+FFFD in the file must survive, so split on its encoding before stripping replacements.
  const parts = [];
  let at = 0;
  for (let i = buf.indexOf(GENUINE_FFFD); i !== -1; i = buf.indexOf(GENUINE_FFFD, at)) {
    parts.push(decode(buf.subarray(at, i)));
    at = i + 3;
  }
  parts.push(decode(buf.subarray(at)));
  return parts.join(REPLACEMENT);
}

// Parser states, named as in _csv.c.
const START_RECORD = 0, START_FIELD = 1, IN_FIELD = 2, IN_QUOTED_FIELD = 3, QUOTE_IN_QUOTED_FIELD = 4, EAT_CRNL = 5;
const EOL = null;

/**
 * Rows of a CSV export.
 * @param {string|Buffer|Uint8Array} input  raw bytes (decoded as above) or already-decoded text
 * @param {number[]} [lines]  if given, receives each row's 1-based starting line (quoted cells can span lines)
 * @returns {string[][]}
 * @throws {CsvError} where Python's csv module raises csv.Error
 */
function readCsv(input, lines) {
  let text = typeof input === 'string'
    ? (input.startsWith('﻿') ? input.slice(1) : input)
    : decodeUtf8Ignore(Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  text = text.replace(/\r\n?/g, '\n');

  const rows = [];
  let fields = [];
  let field = '';
  let fieldLen = 0; // in code points, as CPython counts
  let state = START_RECORD;
  let lineNo = 0;

  const saveField = () => { fields.push(field); field = ''; fieldLen = 0; };
  const addChar = (c) => {
    const low = c >= '\uDC00' && c <= '\uDFFF'; // second half of a surrogate pair: same code point
    if (!low && fieldLen++ >= FIELD_LIMIT) throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`, lineNo);
    field += c;
  };

  const step = (c) => {
    switch (state) {
      case START_RECORD:
        if (c === EOL) return;
        if (c === '\n') { state = EAT_CRNL; return; }
        state = START_FIELD;
      // falls through
      case START_FIELD:
        if (c === '\n' || c === EOL) { saveField(); state = c === EOL ? START_RECORD : EAT_CRNL; }
        else if (c === '"') state = IN_QUOTED_FIELD;
        else if (c === ',') saveField();
        else { addChar(c); state = IN_FIELD; }
        return;
      case IN_FIELD:
        if (c === '\n' || c === EOL) { saveField(); state = c === EOL ? START_RECORD : EAT_CRNL; }
        else if (c === ',') { saveField(); state = START_FIELD; }
        else addChar(c);
        return;
      case IN_QUOTED_FIELD:
        if (c === EOL) return;
        if (c === '"') state = QUOTE_IN_QUOTED_FIELD;
        else addChar(c);
        return;
      case QUOTE_IN_QUOTED_FIELD:
        if (c === '"') { addChar('"'); state = IN_QUOTED_FIELD; }
        else if (c === ',') { saveField(); state = START_FIELD; }
        else if (c === '\n' || c === EOL) { saveField(); state = c === EOL ? START_RECORD : EAT_CRNL; }
        else { addChar(c); state = IN_FIELD; } // strict=False keeps the stray text
        return;
      default: // EAT_CRNL: universal newlines guarantee '\n' only ends a line, so only EOL follows
        state = START_RECORD;
    }
  };

  // The csv module pulls one line at a time ('\n' included) and feeds EOL after each.
  let pos = 0;
  let rowStart = 1;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    end = end === -1 ? text.length : end + 1;
    lineNo++;
    if (state === START_RECORD) rowStart = lineNo;
    for (let i = pos; i < end; i++) step(text[i]);
    step(EOL);
    pos = end;
    if (state === START_RECORD) { rows.push(fields); fields = []; lines?.push(rowStart); }
  }
  // End of input inside a quoted field: strict=False returns what was read.
  if (state !== START_RECORD && (fieldLen > 0 || state === IN_QUOTED_FIELD)) {
    saveField();
    rows.push(fields);
    lines?.push(rowStart);
  }
  return rows;
}

module.exports = { readCsv, decodeUtf8Ignore, CsvError, FIELD_LIMIT };
