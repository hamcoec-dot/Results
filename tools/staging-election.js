'use strict';
/**
 * Publishes a hidden TEST election through the real deployed callables (plan: Implementation phases 5,
 * "a dry run with the Web Results Samples 00→06 sequence"; layers 13–15 need something published).
 * For each sample step it does what an admin does in admin.html + review.html:
 *   createDraft (00 = zero, 01–02 = early, 03+ = ed) → the draft must be `ready` → acknowledge every warn
 *   check by key → publishDraft with the precincts-reporting count → print the live check.
 * The "open all four draft pages" gate is enforced in review.js only (publishRefusals has no view rule),
 * so there is nothing to satisfy server side.
 *
 * !! PUBLISHING ANY ELECTION OVERWRITES THE BUCKET'S current/ FILES !!
 * current/* is one set per public bucket, not per election: publishDraft copies to current/ whether or
 * not the election is `active` (that flag only picks which election auditLive watches). So after a run
 * the public pages pointed at this bucket show the test results, and auditLive on a real active election
 * reports a mismatch until that election is published again. On staging that is the point. On production
 * it replaces what voters see, so the tool refuses hcec-election-results unless --allow-production.
 *
 * Signs in as a bot admin (uid staging-bot): makes the Auth user and admins/{uid} with the Admin SDK,
 * mints a custom token and signs in with the client SDK, as a browser would. admins/{uid} is deleted at
 * the end unless --keep-admin. Credentials are Google application-default credentials (in Actions:
 * google-github-actions/auth as github-deploy@<project>). createCustomToken on those credentials calls
 * IAM signBlob as --service-account, which needs roles/iam.serviceAccountTokenCreator on that account
 * (granted to itself; docs/DEPLOY.md › Staging test election).
 *
 * Usage:
 *   FIREBASE_WEB_API_KEY=… node tools/staging-election.js [--project hcec-election-results-staging]
 *       [--api-key KEY] [--election test-staging-dryrun] [--steps 00,01,02,03,04,05,06] [--publish false]
 *       [--set 92|94] [--service-account EMAIL] [--keep-admin] [--allow-production]
 * The election id must start with "test-". A run that starts at 00 clears the test election's selected
 * uploads first, so it can be repeated.
 *   node tools/staging-election.js --emulator   the running emulators (project demo-hcec, no key or IAM needed)
 * Exits 1 if any step is refused, blocked or fails its live check.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'Test_Files', 'Web Results Samples');
const PRODUCTION = 'hcec-election-results';
const BOT_UID = 'staging-bot';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1).length > 0 : false; };
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const emulator = flag('--emulator');
const keepAdmin = flag('--keep-admin');
const allowProduction = flag('--allow-production');
const project = opt('--project', emulator ? 'demo-hcec' : 'hcec-election-results-staging');
const apiKey = opt('--api-key', process.env.FIREBASE_WEB_API_KEY || (emulator ? 'demo-key' : ''));
const electionId = opt('--election', 'test-staging-dryrun');
const steps = opt('--steps', '00,01,02,03,04,05,06').split(',').map((s) => s.trim()).filter(Boolean);
const publish = !/^(false|no|0)$/i.test(opt('--publish', 'true'));
const set = opt('--set', '92');
const serviceAccount = opt('--service-account', process.env.STAGING_BOT_SIGNER || `github-deploy@${project}.iam.gserviceaccount.com`);

function usage(msg) {
  console.error(`${msg}\nUsage: node tools/staging-election.js [--project ID] [--api-key KEY] [--election ID] [--steps 00,…,06] [--publish false] [--set 92|94] [--service-account EMAIL] [--keep-admin] [--allow-production] [--emulator]`);
  process.exit(2);
}
if (args.length) usage(`Unknown arguments: ${args.join(' ')}`);
if (project === PRODUCTION && !allowProduction) {
  usage(`Refusing to publish a test election to ${PRODUCTION}: it would replace the public current/ files voters see. Pass --allow-production only for a rehearsal (docs/REHEARSAL.md).`);
}
if (!apiKey) usage('No Firebase web API key: pass --api-key or set FIREBASE_WEB_API_KEY.');
// Only test-* elections: the tool resets their file slots (below), which must never happen to a real one.
if (!/^test-[a-z0-9-]{1,57}$/.test(electionId)) usage(`The election id must start with "test-" (got ${electionId}).`);
if (!['92', '94'].includes(set)) usage('--set is 92 or 94 (the sample file suffix, and the max precincts).');
if (!steps.every((s) => /^\d\d$/.test(s))) usage('--steps are two-digit sample prefixes, e.g. 00,01,02.');

if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
}
const nm = (m) => require(path.join(ROOT, 'functions', 'node_modules', m));
const admin = nm('firebase-admin');
const { initializeApp, deleteApp } = nm('firebase/app');
const { getAuth, connectAuthEmulator, signInWithCustomToken } = nm('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = nm('firebase/functions');

/** The sample file for a step, and its upload kind (as emulator-drafts.js, plus 00 = Zero). */
function sample(prefix) {
  const name = fs.readdirSync(SAMPLES).find((f) => f.startsWith(`${prefix}-`) && f.endsWith(`(${set}).csv`));
  if (!name) throw new Error(`No sample "${prefix}-… (${set}).csv" in ${SAMPLES}`);
  const n = Number(prefix);
  return { name, csv: fs.readFileSync(path.join(SAMPLES, name), 'utf8'), kind: n === 0 ? 'zero' : n <= 2 ? 'early' : 'ed' };
}

async function ensureBot(db) {
  const email = `${BOT_UID}@${project}.invalid`;
  try {
    await admin.auth().getUser(BOT_UID);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    await admin.auth().createUser({ uid: BOT_UID, email, displayName: 'Staging test-election bot' });
  }
  await db.doc(`admins/${BOT_UID}`).set({ email, added: new Date().toISOString(), note: 'tools/staging-election.js' });
}

async function main() {
  // serviceAccountId: with ADC from Workload Identity Federation the SDK cannot discover which account
  // signs custom tokens, so name it (IAM signBlob, roles/iam.serviceAccountTokenCreator).
  admin.initializeApp(emulator ? { projectId: project } : { projectId: project, serviceAccountId: serviceAccount });
  const db = admin.firestore();
  const app = initializeApp({ projectId: project, apiKey, authDomain: `${project}.firebaseapp.com` }, 'staging-bot');
  const auth = getAuth(app);
  const fns = getFunctions(app, 'us-east1');
  if (emulator) {
    connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
    const [fh, fp] = (process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001').split(':');
    connectFunctionsEmulator(fns, fh, Number(fp));
  }
  const call = (name, data) => httpsCallable(fns, name, { timeout: 180000 })(data).then((r) => r.data);
  let failed = false;

  try {
    await ensureBot(db);
    await signInWithCustomToken(auth, await admin.auth().createCustomToken(BOT_UID));
    await call('ping', {});
    console.log(`${project}: signed in as ${BOT_UID}; election ${electionId}; ${publish ? 'publishing' : 'drafts only'} ${steps.join(' ')} (${set})`);

    // Never makeActive: a test election must not displace the real one auditLive watches.
    await call('upsertElection', {
      id: electionId, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: Number(set),
      enablePrecinctResults: true, makeActive: false,
    });
    // A run from 00 starts from an empty election, as on the night: a Zero file merged with a previous
    // run's selected ED file would be blocked (zero-file-has-votes). currentVersion is kept, so publishes
    // still chain on the live version.
    const existing = (await db.doc(`elections/${electionId}`).get()).data();
    if (steps[0] === '00' && (existing.selectedEarlyUploadId || existing.selectedEdUploadId)) {
      await db.doc(`elections/${electionId}`).update({ selectedEarlyUploadId: null, selectedEdUploadId: null });
      console.log(`Cleared ${electionId}'s selected uploads from a previous run.`);
    }
    const others = (await db.collection('elections').where('active', '==', true).get()).docs.filter((d) => d.id !== electionId);
    for (const d of others) {
      if (publish && d.data().currentVersion) {
        console.log(`WARNING: ${d.id} is active and published (${d.data().currentVersion}); this run replaces the current/ files its pages read, and its auditLive will report a mismatch until it is published again.`);
      }
    }

    for (const prefix of steps) {
      const s = sample(prefix);
      const t0 = Date.now();
      const d = await call('createDraft', { electionId, kind: s.kind, filename: s.name, csv: s.csv });
      const doc = (await db.doc(`elections/${electionId}/drafts/${d.draftId}`).get()).data();
      const warns = doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key);
      const head = `${prefix} ${s.kind.padEnd(5)} ${s.name}: draft ${d.draftId.slice(0, 8)} ${d.status}, ${warns.length} warn${warns.length ? ` [${[...new Set(warns)].join(', ')}]` : ''}, ${doc.confirmCount} reporting`;
      if (d.status !== 'ready') {
        const blocks = doc.checks.filter((c) => c.severity === 'block').map((c) => `${c.key}: ${c.detail}`);
        console.log(`${head}\n  FAIL: not ready\n  ${blocks.join('\n  ')}`);
        failed = true;
        break;
      }
      if (!publish) { console.log(head); continue; }
      // publishDraft checks baseVersion from the draft doc; sent too, as the plan's contract names it.
      const r = await call('publishDraft', {
        electionId, draftId: d.draftId, acknowledged: warns, confirmCount: doc.confirmCount, baseVersion: doc.baseVersion,
      });
      const ok = r.liveCheck.ok && r.dataVersion === doc.dataVersion;
      console.log(`${head} -> ${r.dataVersion}, live check ${r.liveCheck.ok ? 'ok' : 'FAILED'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (!ok) { failed = true; break; }
    }
  } catch (e) {
    const refusals = e.details?.refusals?.map((x) => x.code).join(', ');
    console.error(`FAIL: ${e.code ?? ''} ${e.message}${refusals ? ` (refusals: ${refusals})` : ''}`);
    failed = true;
  } finally {
    if (!keepAdmin) await db.doc(`admins/${BOT_UID}`).delete().catch((e) => console.error(`Could not remove admins/${BOT_UID}: ${e.message}`));
    await deleteApp(app);
    await admin.app().delete();
  }
  console.log(failed ? 'FAIL' : `OK: ${electionId} ${publish ? 'published' : 'drafted'} through ${steps.at(-1)}.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
