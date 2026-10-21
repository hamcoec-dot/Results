'use strict';
/**
 * Cloud Functions entry point: Firebase wiring only. All logic is in service.js (tested with
 * in-memory fakes in service.test.js, and against the emulators in test/emulator/).
 */
const admin = require('firebase-admin');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineInt, defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { createService, ServiceError } = require('./service');

admin.initializeApp();
setGlobalOptions({ region: 'us-east1', maxInstances: 10 });

// Warm instances for election night (README runbook: 1 on the night, 0 otherwise).
const ELECTION_NIGHT_MIN_INSTANCES = defineInt('ELECTION_NIGHT_MIN_INSTANCES', { default: 0 });
// The public results bucket (allUsers: legacyObjectReader); the default bucket stays private.
const PUBLIC_BUCKET = defineString('PUBLIC_BUCKET', { default: `${process.env.GCLOUD_PROJECT}-results` });

const db = admin.firestore();
const EMULATED = Boolean(process.env.FUNCTIONS_EMULATOR);

function firestoreAdapter(fs) {
  const doc = (p) => fs.doc(p);
  const data = (snap) => (snap.exists ? snap.data() : null);
  return {
    get: async (p) => data(await doc(p).get()),
    set: (p, d) => doc(p).set(d),
    update: (p, d) => doc(p).update(d),
    add: async (c, d) => (await fs.collection(c).add(d)).id,
    list: async (c) => (await fs.collection(c).get()).docs.map((x) => ({ id: x.id, data: x.data() })),
    transaction: (fn) => fs.runTransaction((t) => fn({
      get: async (p) => data(await t.get(doc(p))),
      set: (p, d) => t.set(doc(p), d),
      update: (p, d) => t.update(doc(p), d),
    })),
  };
}

function bucketAdapter(bucket) {
  return {
    write: (p, d, { contentType, cacheControl, gzip } = {}) => bucket.file(p).save(d, {
      resumable: false, gzip: Boolean(gzip), contentType, metadata: cacheControl ? { cacheControl } : undefined,
    }),
    // download() undoes gzip content-encoding, so hashes are of the bytes that were written.
    read: async (p) => {
      const f = bucket.file(p);
      const [exists] = await f.exists();
      return exists ? (await f.download())[0] : null;
    },
    // Copy keeps the source's metadata (content type, gzip encoding); then patch cache-control only.
    copy: async (from, to, { cacheControl } = {}) => {
      await bucket.file(from).copy(bucket.file(to));
      if (cacheControl) await bucket.file(to).setMetadata({ cacheControl });
    },
    deletePrefix: (prefix) => bucket.deleteFiles({ prefix }),
  };
}

/** The bytes the public URL serves right now (cache-busted), or null. */
async function fetchLive(path) {
  const name = PUBLIC_BUCKET.value();
  // Emulator: the GCS-API download path (IAM-like, as storage.googleapis.com), not the Firebase
  // path, which applies storage.rules (deny-all for the private bucket's clients).
  const url = EMULATED
    ? `http://${process.env.FIREBASE_STORAGE_EMULATOR_HOST}/download/storage/v1/b/${name}/o/${encodeURIComponent(path)}?alt=media`
    : `https://storage.googleapis.com/${name}/${path.split('/').map(encodeURIComponent).join('/')}?t=${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch (e) {
    logger.warn('live fetch failed', { path, error: e.message });
    return null;
  }
}

let service;
const svc = () => {
  service ??= createService({
    db: firestoreAdapter(db),
    publicBucket: bucketAdapter(admin.storage().bucket(PUBLIC_BUCKET.value())),
    privateBucket: bucketAdapter(admin.storage().bucket()),
    fetchLive,
  });
  return service;
};

async function requireAdmin(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await db.doc(`admins/${req.auth.uid}`).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Admin only.');
  return { uid: req.auth.uid, email: req.auth.token?.email ?? req.auth.uid };
}

/** An admin-only callable around a service method; ServiceErrors keep their code and details. */
function adminCall(method, options = {}) {
  return onCall(options, async (req) => {
    const actor = await requireAdmin(req);
    try {
      return await svc()[method](actor, req.data ?? {});
    } catch (e) {
      if (e instanceof ServiceError) throw new HttpsError(e.code, e.message, e.details);
      logger.error(`${method} failed`, { error: e.stack });
      throw new HttpsError('internal', 'Something went wrong; nothing was published. Try again.');
    }
  });
}

const warm = { minInstances: ELECTION_NIGHT_MIN_INSTANCES };

exports.ping = onCall(warm, async (req) => ({ ok: true, admin: Boolean((await requireAdmin(req)).uid) }));
exports.upsertElection = adminCall('upsertElection');
exports.createDraft = adminCall('createDraft', { ...warm, memory: '1GiB', timeoutSeconds: 120 });
exports.createSettingsDraft = adminCall('createSettingsDraft', { ...warm, memory: '1GiB', timeoutSeconds: 120 });
exports.createRollbackDraft = adminCall('createRollbackDraft', { memory: '512MiB' });
exports.publishDraft = adminCall('publishDraft', warm);
exports.extendDraft = adminCall('extendDraft', warm);
exports.discardDraft = adminCall('discardDraft');
exports.auditLiveNow = adminCall('auditLive');

// Every minute: re-verify what the public is served for the active election (audit + alert log).
exports.auditLive = onSchedule({ schedule: 'every 1 minutes', timeZone: 'America/New_York' }, async () => {
  const active = (await db.collection('elections').where('active', '==', true).limit(1).get()).docs[0];
  if (!active) return;
  const r = await svc().auditLive({ uid: 'system', email: 'auditLive' }, { electionId: active.id });
  // Cloud Monitoring alert policy matches this log line (README › Election-night monitoring).
  if (!r.ok) logger.error('AUDIT_LIVE_MISMATCH', { election: active.id, problems: r.problems });
});

exports._test = { firestoreAdapter, bucketAdapter };
