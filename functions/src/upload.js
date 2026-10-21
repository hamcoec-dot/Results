'use strict';
/**
 * Decoding of a createDraft upload (plan: Performance › Upload speed on mobile). The browser
 * gzips the CSV with CompressionStream and sends base64; browsers without it send the text.
 * The sha256 is always of the original text, so the same file has the same hash either way.
 */
const zlib = require('node:zlib');
const { sha256Hex } = require('./publish');

const MAX_CSV_CHARS = 5_000_000;
const MAX_GZIP_BASE64 = 4_000_000; // 3 MB compressed: ample for 5 M chars of CSV
const KINDS = new Set(['zero', 'early', 'ed']);

class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

/**
 * @param {{kind: string, filename: string, csv?: string, csvGzipBase64?: string, lastModified?: number}} data
 * @returns {{kind: string, filename: string, text: string, sha256: string, size: number, lastModified: number|null}}
 * @throws {UploadError} invalid-argument / too-large
 */
function decodeUpload(data) {
  if (!data || typeof data !== 'object') throw new UploadError('invalid-argument', 'No upload.');
  const { kind, filename, csv, csvGzipBase64, lastModified } = data;
  if (!KINDS.has(kind)) throw new UploadError('invalid-argument', 'Choose Zero, Early/ABS or Election Day.');
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 200) throw new UploadError('invalid-argument', 'Bad file name.');
  if (!/\.csv$/i.test(filename.trim())) throw new UploadError('invalid-argument', 'The file must be a .csv export.');
  if ((csv === undefined) === (csvGzipBase64 === undefined)) throw new UploadError('invalid-argument', 'Send the file once, as csv or csvGzipBase64.');

  let text;
  if (csv !== undefined) {
    if (typeof csv !== 'string') throw new UploadError('invalid-argument', 'csv must be text.');
    text = csv;
  } else {
    if (typeof csvGzipBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(csvGzipBase64)) throw new UploadError('invalid-argument', 'csvGzipBase64 is not base64.');
    if (csvGzipBase64.length > MAX_GZIP_BASE64) throw new UploadError('too-large', 'The file is too large.');
    try {
      // maxOutputLength bounds a gzip bomb: 4 bytes per char is the UTF-8 worst case.
      text = zlib.gunzipSync(Buffer.from(csvGzipBase64, 'base64'), { maxOutputLength: MAX_CSV_CHARS * 4 }).toString('utf8');
    } catch (e) {
      throw new UploadError(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'too-large' : 'invalid-argument',
        e.code === 'ERR_BUFFER_TOO_LARGE' ? 'The file is too large.' : 'The compressed upload could not be read.');
    }
  }
  if (text.length > MAX_CSV_CHARS) throw new UploadError('too-large', `The file is over ${MAX_CSV_CHARS.toLocaleString('en-US')} characters.`);
  if (text.length === 0) throw new UploadError('invalid-argument', 'The file is empty.');
  return {
    kind,
    filename: filename.trim(),
    text,
    sha256: sha256Hex(text),
    size: Buffer.byteLength(text, 'utf8'),
    lastModified: Number.isFinite(lastModified) && lastModified > 0 ? lastModified : null,
  };
}

module.exports = { decodeUpload, UploadError, MAX_CSV_CHARS, MAX_GZIP_BASE64 };
