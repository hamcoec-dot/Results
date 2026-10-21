'use strict';
/**
 * A minimal ZIP writer for the post-election records export (tools/export-election.js): deflated
 * entries, CRC-32, one central directory. No ZIP64, so the archive and each entry must stay under
 * 4 GiB (an election's files are a few MB). No dependencies beyond node:zlib.
 */
const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), as ZIP stores it. */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time fields for a Date (local time, 2-second resolution, 1980..2107). */
function dosDateTime(d) {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * @param {{name: string, data: Buffer|string}[]} entries  names use '/' and must be unique and relative
 * @param {{date?: Date}} [opts]  timestamp for every entry (default: now)
 * @returns {Buffer} the .zip file
 */
function buildZip(entries, { date = new Date() } = {}) {
  const { time, date: day } = dosDateTime(date);
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (typeof name !== 'string' || !name || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) {
      throw new TypeError(`bad entry name: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) throw new TypeError(`duplicate entry: ${name}`);
    seen.add(name);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const packed = zlib.deflateRawSync(raw, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    if (raw.length > 0xfffffffe || offset > 0xfffffffe) throw new RangeError('archive too large for a non-ZIP64 zip');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk start, internal attrs (30..37) stay 0; external attrs 0; then the offset
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  if (entries.length > 0xffff) throw new RangeError('too many entries for a non-ZIP64 zip');
  return Buffer.concat([...locals, dir, end]);
}

module.exports = { buildZip, crc32 };
