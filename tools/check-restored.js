'use strict';
/**
 * Test helper for tools/staging-election.js: after a run that displaced <id> as the active election,
 * checks that <id> is the active election again and that the public bucket's current/manifest.json
 * serves its currentVersion (what auditLive compares). Exits 1 if not.
 *
 *   node tools/check-restored.js <id> [--project id] [--emulator]
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1).length > 0 : false; };
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const emulator = flag('--emulator');
const project = opt('--project', emulator ? 'demo-hcec' : 'hcec-election-results-staging');
const [eid, ...rest] = args;
if (!eid || rest.length) {
  console.error('Usage: node tools/check-restored.js <id> [--project id] [--emulator]');
  process.exit(2);
}
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
}

/** The public bucket name from the committed per-project params (as tools/clear-test-election.js). */
function publicBucketName() {
  const file = path.join(ROOT, 'functions', emulator ? '.env.local' : `.env.${project}`);
  const m = fs.existsSync(file) && /^PUBLIC_BUCKET=(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
  if (!m) throw new Error(`PUBLIC_BUCKET not found in ${path.relative(ROOT, file)}`);
  return m[1].trim();
}

const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));

async function main() {
  admin.initializeApp({ projectId: project });
  const db = admin.firestore();
  const election = (await db.doc(`elections/${eid}`).get()).data();
  const active = (await db.collection('elections').where('active', '==', true).get()).docs.map((d) => d.id);
  const file = admin.storage().bucket(publicBucketName()).file('current/manifest.json');
  const manifest = (await file.exists())[0] ? JSON.parse((await file.download())[0].toString('utf8')) : null;
  const problems = [];
  if (!election) problems.push(`no election ${eid}`);
  if (active.join(',') !== eid) problems.push(`active election(s): ${active.join(', ') || 'none'}, expected ${eid}`);
  if (!election?.currentVersion) problems.push(`${eid} has no currentVersion`);
  if (manifest?.dataVersion !== election?.currentVersion) problems.push(`current/ serves ${manifest?.dataVersion ?? 'nothing'}, expected ${eid}'s ${election?.currentVersion}`);
  console.log(problems.length ? `FAIL: ${problems.join('; ')}` : `OK: ${eid} is active and current/ serves its ${election.currentVersion}.`);
  process.exitCode = problems.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => admin.apps.length && admin.app().delete());
