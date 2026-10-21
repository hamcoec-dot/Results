'use strict';
// In-memory stand-ins for Firestore and Cloud Storage with the same semantics the service relies
// on: deep-copied documents, serialised transactions that commit atomically or not at all, and
// object stores whose reads return exactly the bytes written (gzip transcoding is transparent).
const crypto = require('node:crypto');

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

class MemoryDb {
  constructor() {
    this.docs = new Map();
    this.queue = Promise.resolve();
  }

  async get(path) { return clone(this.docs.get(path)) ?? null; }

  async set(path, data) { this.docs.set(path, clone(data)); }

  async update(path, partial) {
    if (!this.docs.has(path)) throw new Error(`update of missing doc ${path}`);
    this.docs.set(path, { ...this.docs.get(path), ...clone(partial) });
  }

  async add(collection, data) {
    const id = crypto.randomBytes(10).toString('hex');
    await this.set(`${collection}/${id}`, data);
    return id;
  }

  async list(collection) {
    const prefix = `${collection}/`;
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, data]) => ({ id: p.slice(prefix.length), data: clone(data) }));
  }

  /** Transactions run one at a time; writes are buffered and applied only if fn resolves. */
  transaction(fn) {
    const run = this.queue.then(async () => {
      const writes = [];
      const tx = {
        get: async (path) => {
          const pending = writes.filter((w) => w.path === path);
          let doc = clone(this.docs.get(path)) ?? null;
          for (const w of pending) doc = w.kind === 'set' ? clone(w.data) : { ...doc, ...clone(w.data) };
          return doc;
        },
        set: (path, data) => writes.push({ kind: 'set', path, data: clone(data) }),
        update: (path, data) => writes.push({ kind: 'update', path, data: clone(data) }),
      };
      const result = await fn(tx);
      for (const w of writes) {
        if (w.kind === 'set') this.docs.set(w.path, w.data);
        else {
          if (!this.docs.has(w.path)) throw new Error(`update of missing doc ${w.path}`);
          this.docs.set(w.path, { ...this.docs.get(w.path), ...w.data });
        }
      }
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

class MemoryBucket {
  constructor() { this.objects = new Map(); }

  async write(path, data, meta = {}) { this.objects.set(path, { data: Buffer.from(data), meta: { ...meta } }); }

  async read(path) {
    const o = this.objects.get(path);
    return o ? Buffer.from(o.data) : null;
  }

  async copy(from, to, meta = {}) {
    const o = this.objects.get(from);
    if (!o) throw new Error(`copy of missing object ${from}`);
    this.objects.set(to, { data: Buffer.from(o.data), meta: { ...o.meta, ...meta } });
  }

  async deletePrefix(prefix) {
    for (const p of [...this.objects.keys()]) if (p.startsWith(prefix)) this.objects.delete(p);
  }

  meta(path) { return this.objects.get(path)?.meta; }

  text(path) { return this.objects.get(path)?.data.toString('utf8') ?? null; }

  list(prefix = '') { return [...this.objects.keys()].filter((p) => p.startsWith(prefix)).sort(); }
}

/** A controllable clock (ms). */
function clock(start = Date.UTC(2026, 10, 4, 0, 30)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

module.exports = { MemoryDb, MemoryBucket, clock };
