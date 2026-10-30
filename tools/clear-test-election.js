'use strict';
/**
 * Removes a TEST election and everything it published, so a project is clean again after a
 * rehearsal (docs/REHEARSAL.md › After). Only ids that start with "test-" are accepted.
 *
 * Removes:
 *   - the public bucket's current/ files, but only while they are this election's (the manifest's
 *     dataVersion is one of its versions); another election's live files are never touched
 *   - the public bucket's elections/<id>/ archive and the drafts/<draftId>/ files of its drafts
 *   - the private bucket's uploads/<id>/ (the raw CSVs)
 *   - Firestore elections/<id> with its uploads, drafts and versions, and its audit entries
 *   - with --remove-bot: the staging-bot admin (admins/staging-bot and its Auth user) that
 *     tools/staging-election.js signs in as
 * Export the records first if they are wanted (tools/export-election.js; the rehearsal workflow does).
 *
 * Usage (Application Default Credentials; in Actions the github-deploy service account):
 *   node tools/clear-test-election.js <test-id> [--project hcec-election-results] [--remove-bot]   dry run: lists what would go
 *   node tools/clear-test-election.js <test-id> [--project …] [--remove-bot] --yes                  deletes it
 *   … --emulator   the local emulators (demo-hcec)
 * Ends by listing what is left (all zero after --yes), and exits 1 if anything is.
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const BOT_UID = 'staging-bot';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1).length > 0 : false; };
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const emulator = flag('--emulator');
const yes = flag('--yes');
const removeBot = flag('--remove-bot');
const project = opt('--project', emulator ? 'demo-hcec' : 'hcec-election-results');
const privateBucketName = opt('--private-bucket', emulator ? `${project}.appspot.com` : `${project}.firebasestorage.app`);
const [eid, ...rest] = args;
if (!eid || rest.length) {
  console.error('Usage: node tools/clear-test-election.js <test-id> [--project id] [--private-bucket name] [--remove-bot] [--yes] [--emulator]');
  process.exit(2);
}
// The same rule as tools/staging-election.js: a real election can never be named here.
if (!/^test-[a-z0-9-]{1,57}$/.test(eid)) {
  console.error(`Refusing: only test elections (ids starting "test-") can be cleared, not ${eid}.`);
  process.exit(2);
}
if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
}

/** The public bucket name from the committed per-project params (as tools/export-election.js). */
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
  const pub = admin.storage().bucket(publicBucketName());
  const priv = admin.storage().bucket(privateBucketName);
  const electionRef = db.doc(`elections/${eid}`);

  /** Everything of the election's that exists now. */
  async function inventory({ listCurrent = false } = {}) {
    const election = (await electionRef.get()).data() ?? null;
    const ids = async (c) => (await electionRef.collection(c).get()).docs.map((d) => d.id);
    const [versions, drafts, uploads] = await Promise.all([ids('versions'), ids('drafts'), ids('uploads')]);
    const audit = (await db.collection('audit').where('eid', '==', eid).get()).docs;
    const files = async (bucket, prefix) => (await bucket.getFiles({ prefix }))[0].map((f) => f.name);
    const archive = await files(pub, `elections/${eid}/`);
    const draftFiles = (await Promise.all(drafts.map((d) => files(pub, `drafts/${d}/`)))).flat();
    const raw = await files(priv, `uploads/${eid}/`);
    const live = pub.file('current/manifest.json');
    const manifest = (await live.exists())[0] ? JSON.parse((await live.download())[0].toString('utf8')) : null;
    // current/ is this election's only if its version is one of ours and no other election claims it.
    const others = (await db.collection('elections').get()).docs.filter((d) => d.id !== eid && d.data().currentVersion === manifest?.dataVersion);
    const ownsCurrent = Boolean(manifest && versions.includes(manifest.dataVersion) && !others.length);
    const current = ownsCurrent || listCurrent ? await files(pub, 'current/') : [];
    const bot = removeBot ? {
      doc: (await db.doc(`admins/${BOT_UID}`).get()).exists,
      user: await admin.auth().getUser(BOT_UID).then(() => true, () => false),
    } : { doc: false, user: false };
    return { election, versions, drafts, uploads, audit, archive, draftFiles, raw, manifest, ownsCurrent, current, bot };
  }

  const describe = (x) => [
    `election doc: ${x.election ? `yes (${x.election.active ? 'ACTIVE' : 'not active'}, version ${x.election.currentVersion ?? 'none'})` : 'no'}`,
    `${x.versions.length} version(s), ${x.drafts.length} draft(s), ${x.uploads.length} upload(s), ${x.audit.length} audit entr${x.audit.length === 1 ? 'y' : 'ies'}`,
    `public bucket: current/ ${x.ownsCurrent ? `${x.current.length} file(s), this election's (${x.manifest.dataVersion})` : x.manifest ? `left alone (serves ${x.manifest.dataVersion}, not this election's)` : `${x.current.length} file(s), no manifest`}; `
      + `${x.archive.length} archive file(s); ${x.draftFiles.length} draft file(s)`,
    `private bucket: ${x.raw.length} raw upload(s)`,
    ...(removeBot ? [`staging-bot admin: doc ${x.bot.doc ? 'yes' : 'no'}, Auth user ${x.bot.user ? 'yes' : 'no'}`] : []),
  ].map((l) => `  ${l}`).join('\n');

  const before = await inventory();
  console.log(`${project}: ${eid} now\n${describe(before)}`);
  if (!yes) {
    console.log('Dry run: nothing deleted. Add --yes to delete the above.');
    return;
  }

  // Take the election off the public pages first: inactive (auditLive stops), then the live manifest
  // (the pages stop seeing a version), then the rest of current/.
  if (before.election) await electionRef.update({ active: false });
  if (before.ownsCurrent) {
    await pub.file('current/manifest.json').delete({ ignoreNotFound: true });
    await Promise.all(before.current.filter((f) => f !== 'current/manifest.json').map((f) => pub.file(f).delete({ ignoreNotFound: true })));
  }
  await Promise.all([...before.archive, ...before.draftFiles].map((f) => pub.file(f).delete({ ignoreNotFound: true })));
  await Promise.all(before.raw.map((f) => priv.file(f).delete({ ignoreNotFound: true })));
  await db.recursiveDelete(electionRef);
  for (let i = 0; i < before.audit.length; i += 400) {
    const batch = db.batch();
    before.audit.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  if (removeBot) {
    await db.doc(`admins/${BOT_UID}`).delete();
    await admin.auth().deleteUser(BOT_UID).catch((e) => { if (e.code !== 'auth/user-not-found') throw e; });
  }

  const after = await inventory({ listCurrent: before.ownsCurrent });
  const left = Boolean(after.election) || after.versions.length + after.drafts.length + after.uploads.length + after.audit.length
    + after.archive.length + after.draftFiles.length + after.raw.length + after.current.length > 0 || after.bot.doc || after.bot.user;
  console.log(`${project}: ${eid} after clearing\n${describe(after)}`);
  console.log(left ? 'FAIL: something was left behind (above).' : `OK: ${eid} cleared from ${project}.`);
  process.exitCode = left ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => admin.apps.length && admin.app().delete());
