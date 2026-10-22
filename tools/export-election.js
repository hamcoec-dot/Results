'use strict';
/**
 * Post-election records export: writes one ZIP with the election's audit log, every published
 * version's files and record (checks, acknowledgements, live check), every draft record and every
 * raw upload. Layout: functions/src/records.js. Keep the ZIP with the election's records.
 *
 * Usage (Application Default Credentials with read access to Firestore and both buckets,
 * e.g. `gcloud auth application-default login`):
 *   node tools/export-election.js <electionId> [--project hcec-election-results] [--out <file.zip>]
 *        [--private-bucket <name>]   default <project>.firebasestorage.app (the Firebase default bucket;
 *                                    <project>.appspot.com with --emulator)
 *   node tools/export-election.js <electionId> --emulator   the local emulators (demo-hcec)
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1).length > 0 : false; };
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const emulator = flag('--emulator');
const project = opt('--project', emulator ? 'demo-hcec' : 'hcec-election-results');
const privateBucketName = opt('--private-bucket', emulator ? `${project}.appspot.com` : `${project}.firebasestorage.app`);
const eid = args[0];
const out = opt('--out', null) ?? `${eid}-records-${new Date().toISOString().slice(0, 10)}.zip`;
if (!eid) {
  console.error('Usage: node tools/export-election.js <electionId> [--project id] [--out file.zip] [--private-bucket name] [--emulator]');
  process.exit(2);
}

if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
}

/** The public bucket name from the committed per-project params (functions/.env.<project>, .env.local). */
function publicBucketName() {
  const file = path.join(ROOT, 'functions', emulator ? '.env.local' : `.env.${project}`);
  const m = fs.existsSync(file) && /^PUBLIC_BUCKET=(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
  if (!m) throw new Error(`PUBLIC_BUCKET not found in ${path.relative(ROOT, file)}`);
  return m[1].trim();
}

async function main() {
  const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  const { exportElectionRecords } = require(path.join(ROOT, 'functions', 'src', 'records'));
  admin.initializeApp({ projectId: project });
  const fsdb = admin.firestore();
  const bucket = (name) => {
    const b = admin.storage().bucket(name);
    return {
      read: async (object) => {
        try {
          return (await b.file(object).download())[0];
        } catch (e) {
          if (e.code === 404) return null;
          throw e;
        }
      },
    };
  };
  const db = {
    get: async (p) => { const s = await fsdb.doc(p).get(); return s.exists ? s.data() : null; },
    list: async (c) => (await fsdb.collection(c).get()).docs.map((d) => ({ id: d.id, data: d.data() })),
  };
  const by = process.env.USER || process.env.USERNAME || 'unknown';
  const { zip, entries, missing } = await exportElectionRecords(
    { db, publicBucket: bucket(publicBucketName()), privateBucket: bucket(privateBucketName) }, eid, { by });
  fs.writeFileSync(out, zip);
  console.log(`Wrote ${out}: ${entries.length} entries, ${(zip.length / 1024).toFixed(0)} KB.`);
  if (missing.length) {
    console.log(`WARNING: ${missing.length} object(s) named by a record were not found (listed in README.txt):`);
    for (const m of missing) console.log(`  ${m}`);
    process.exitCode = 1;
  }
  await admin.app().delete();
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
