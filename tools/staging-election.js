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
 * not the election is `active`. The tool makes the test election the active one (only the active election
 * may publish), so after a run the pages pointed at this bucket show the test results. On staging that is
 * the point. On production it replaces what voters see, so the tool refuses hcec-election-results unless
 * --allow-production.
 *
 * Signs in as a bot admin (uid staging-bot): makes the Auth user and admins/{uid} with the Admin SDK,
 * gives the user a new random password for this run (and re-enables it; it is disabled again at the end) and signs in with email/password from the client
 * SDK, as a browser would (an Admin-SDK user can sign in with sign-up turned off). admins/{uid} is deleted
 * at the end unless --keep-admin. Credentials are Google application-default credentials (in Actions:
 * google-github-actions/auth as github-deploy@<project>); no token signing or extra IAM role is needed.
 * The web API key defaults to the project's one in firebase-config.js (it is not a secret).
 *
 * Usage:
 *   FIREBASE_WEB_API_KEY=… node tools/staging-election.js [--project hcec-election-results-staging]
 *       [--api-key KEY] [--election test-staging-dryrun] [--steps 00,01,02,03,04,05,06] [--publish false]
 *       [--set 92|94] [--pause S] [--rehearsal] [--check-pages] [--keep-admin] [--allow-production]
 * --pause waits S seconds after each publish, so pages polling every 60 s (and a load test) see each one.
 * --check-pages checks all four pages, as draft previews before every publish and live after it, against
 *   the CSV files behind them (tools/check-live-pages.js: every number, from the legacy Python converter).
 *   Needs `npm ci` at the root, Chromium and python3.
 * --rehearsal then does the rest of docs/REHEARSAL.md › Run, as the operator would: a rollback to the
 *   version before the latest, the latest file again, the Precinct Results page off and on with settings
 *   drafts, and the three deliberate mistakes (an ED file chosen as Zero is BLOCKED; an older file warns
 *   and cannot be published unticked; the older of two drafts is refused as stale once the newer one is
 *   published). After each publish it checks the public manifest, and it ends on the latest file.
 * The election id must start with "test-". A run that starts at 00 clears the test election's selected
 * uploads first, so it can be repeated.
 *   node tools/staging-election.js --emulator   the running emulators (project demo-hcec, no key or IAM needed)
 * Exits 1 if any step is refused, blocked or fails its live check.
 */
const crypto = require('node:crypto');
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
const apiKey = opt('--api-key', process.env.FIREBASE_WEB_API_KEY || (emulator ? 'demo-key' : configApiKey(project)));
const electionId = opt('--election', 'test-staging-dryrun');
const steps = opt('--steps', '00,01,02,03,04,05,06').split(',').map((s) => s.trim()).filter(Boolean);
const publish = !/^(false|no|0)$/i.test(opt('--publish', 'true'));
const set = opt('--set', '92');
const pause = Number(opt('--pause', '0'));
const rehearsal = flag('--rehearsal');
const checkPages = flag('--check-pages');
opt('--service-account'); // accepted and ignored: older docs passed the custom-token signer

/** The web apiKey firebase-config.js uses for a project (the admin pages' own config), or ''. */
function configApiKey(id) {
  const text = fs.readFileSync(path.join(ROOT, 'firebase-config.js'), 'utf8');
  const m = text.match(new RegExp(`apiKey: '([^']+)',[^}]*projectId: '${id}'`, 's'));
  return m ? m[1] : '';
}

function usage(msg) {
  console.error(`${msg}\nUsage: node tools/staging-election.js [--project ID] [--api-key KEY] [--election ID] [--steps 00,…,06] [--publish false] [--set 92|94] [--keep-admin] [--allow-production] [--emulator]`);
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
if (!(pause >= 0 && pause <= 600)) usage('--pause is 0 to 600 seconds.');
if (rehearsal && (!publish || steps.join(',') !== '00,01,02,03,04,05,06')) usage('--rehearsal needs the full 00→06 run, published.');

if (emulator) {
  process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
}
const nm = (m) => require(path.join(ROOT, 'functions', 'node_modules', m));
const admin = nm('firebase-admin');
const { initializeApp, deleteApp } = nm('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = nm('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = nm('firebase/functions');

/** The sample file for a step, and its upload kind (as emulator-drafts.js, plus 00 = Zero). */
function sample(prefix) {
  const name = fs.readdirSync(SAMPLES).find((f) => f.startsWith(`${prefix}-`) && f.endsWith(`(${set}).csv`));
  if (!name) throw new Error(`No sample "${prefix}-… (${set}).csv" in ${SAMPLES}`);
  const n = Number(prefix);
  const file = path.join(SAMPLES, name);
  return { name, file, csv: fs.readFileSync(file, 'utf8'), kind: n === 0 ? 'zero' : n <= 2 ? 'early' : 'ed' };
}

/** What the public bucket serves now (cache-busted), parsed, or null. */
async function served(file) {
  const res = await fetch(`https://storage.googleapis.com/${project}-results/current/${file}?t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } });
  return res.ok ? res.json() : null;
}

/**
 * The operator's actions, shared by the 00→06 run and the rehearsal. Remembers which files each
 * published version was built from (a Zero or Early file fills the early slot, an ED file the other;
 * a rollback or settings draft keeps the version's files), so the page check knows its CSVs.
 */
function makeContext({ call, db, checker }) {
  const versions = []; // every published dataVersion, in order
  const filesOf = new Map(); // dataVersion -> { early, ed } sample paths
  let slots = { early: null, ed: null }; // what the election has selected now
  let precinctPage = true;
  const ctx = { call, db, versions, pageProblems: 0 };
  ctx.fail = (msg) => { throw new Error(msg); };
  ctx.draftDoc = async (id) => (await db.doc(`elections/${electionId}/drafts/${id}`).get()).data();
  ctx.describe = (label, d, doc) => {
    const warns = doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key);
    return `${label}: draft ${d.draftId.slice(0, 8)} ${d.status}, ${warns.length} warn${warns.length ? ` [${[...new Set(warns)].join(', ')}]` : ''}, ${doc.confirmCount} reporting`;
  };
  /** Uploads a sample as `kind` (default: what the file is); the draft, not published. */
  ctx.upload = async (prefix, kind) => {
    const s = sample(prefix);
    const k = kind ?? s.kind;
    const d = await call('createDraft', { electionId, kind: k, filename: s.name, csv: s.csv });
    const doc = await ctx.draftDoc(d.draftId);
    const files = k === 'ed' ? { early: slots.early, ed: s.file } : { early: s.file, ed: slots.ed };
    return { d, doc, files, head: ctx.describe(`${prefix} ${k.padEnd(5)} ${s.name}`, d, doc) };
  };
  ctx.draft = async (d, label, files) => {
    const doc = await ctx.draftDoc(d.draftId);
    return { d, doc, files, head: ctx.describe(label, d, doc) };
  };
  ctx.requireReady = ({ d, doc, head }) => {
    if (d.status === 'ready') return;
    const blocks = doc.checks.filter((c) => c.severity === 'block').map((c) => `${c.key}: ${c.detail}`);
    console.log(`${head}\n  FAIL: not ready\n  ${blocks.join('\n  ')}`);
    ctx.fail(`draft ${d.draftId} is ${d.status}`);
  };
  ctx.setPrecinctPage = (on) => { precinctPage = on; };
  ctx.filesOf = (version) => filesOf.get(version);
  ctx.slots = () => slots;
  /** Publishes a ready draft as the operator does (tick every warning, type the count), then checks the pages. */
  ctx.publishIt = async ({ d, doc, files }, head, t0) => {
    // The operator opens the four previews before publishing; check them against the CSVs too.
    if (checker) ctx.pageProblems += (await checker.check({ ...files, cap: Number(set), precinctPage, draft: d.draftId, version: doc.dataVersion })).length;
    const warns = doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key);
    // publishDraft checks baseVersion from the draft doc; sent too, as the plan's contract names it.
    const r = await call('publishDraft', {
      electionId, draftId: d.draftId, acknowledged: warns, confirmCount: doc.confirmCount, baseVersion: doc.baseVersion,
    });
    console.log(`${head} -> ${r.dataVersion}, live check ${r.liveCheck.ok ? 'ok' : 'FAILED'} (${((Date.now() - t0) / 1000).toFixed(1)} s, ${new Date().toISOString()})`);
    if (!r.liveCheck.ok || r.dataVersion !== doc.dataVersion) ctx.fail('the publish did not go live as reviewed');
    versions.push(r.dataVersion);
    filesOf.set(r.dataVersion, files);
    slots = files;
    if (!emulator) {
      const m = await served('manifest.json');
      if (m?.dataVersion !== r.dataVersion) ctx.fail(`the public manifest says ${m?.dataVersion}, expected ${r.dataVersion}`);
    }
    if (checker) ctx.pageProblems += (await checker.check({ ...files, cap: Number(set), precinctPage })).length;
    if (pause) await new Promise((res) => setTimeout(res, pause * 1000));
    return r.dataVersion;
  };
  return ctx;
}

/** A refused publish: the refusal codes, or a failure if it went through. */
async function refused(call, data) {
  try {
    await call('publishDraft', data);
  } catch (e) {
    return e.details?.refusals?.map((x) => x.code) ?? [e.code];
  }
  throw new Error(`publishDraft ${data.draftId} should have been refused but was published`);
}

/** docs/REHEARSAL.md › Run, steps 4 to 7, after 00→06 are published. */
async function rehearse(ctx) {
  const { call, db, versions, fail } = ctx;
  const settings = (enablePrecinctResults) => call('upsertElection', {
    id: electionId, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: Number(set),
    enablePrecinctResults, makeActive: true,
  });
  const discard = (d) => call('discardDraft', { electionId, draftId: d.draftId });
  const ackAll = (doc) => doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key);

  // 4. Roll back to the version before the latest; the numbers go down. Then the latest file again.
  let t0 = Date.now();
  const back = versions.at(-2);
  const latestCount = (await ctx.draftDoc((await db.doc(`elections/${electionId}/versions/${versions.at(-1)}`).get()).data().draftId)).confirmCount;
  const rb = await ctx.draft(await call('createRollbackDraft', { electionId, version: back }), `4 rollback to ${back}`, ctx.filesOf(back));
  ctx.requireReady(rb);
  if (!rb.doc.checks.some((c) => c.id === 'rollback')) fail('4: the rollback draft has no "This is a rollback" warning');
  if (!(rb.doc.confirmCount <= latestCount)) fail(`4: the rollback shows ${rb.doc.confirmCount} reporting, up from ${latestCount}`);
  await ctx.publishIt(rb, rb.head, t0);
  t0 = Date.now();
  let u = await ctx.upload('06');
  ctx.requireReady(u);
  await ctx.publishIt(u, `4 again: ${u.head}`, t0);

  // 5. Settings change: the Precinct Results page off, then on again.
  for (const on of [false, true]) {
    t0 = Date.now();
    await settings(on);
    ctx.setPrecinctPage(on);
    const sd = await ctx.draft(await call('createSettingsDraft', { electionId }), `5 precinct page ${on ? 'on' : 'off'}`, ctx.slots());
    ctx.requireReady(sd);
    await ctx.publishIt(sd, sd.head, t0);
    if (!emulator) {
      const shown = (await served('summary.json'))?.config?.enablePrecinctResults;
      if (shown !== on) fail(`5: the public summary says enablePrecinctResults ${shown}, expected ${on}`);
    }
  }

  // 6a. An Election Day file chosen as "Zero report" is BLOCKED and cannot be published.
  u = await ctx.upload('05', 'zero');
  if (u.d.status !== 'blocked') fail(`6a ${u.head}: expected BLOCKED`);
  let codes = await refused(call, { electionId, draftId: u.d.draftId, acknowledged: [], confirmCount: u.doc.confirmCount });
  console.log(`6a ${u.head}; publish refused (${codes.join(', ')})`);
  await discard(u.d);

  // 6b. An older file after a later one warns, and cannot be published with its warnings unticked.
  u = await ctx.upload('04');
  ctx.requireReady(u);
  if (!ackAll(u.doc).length) fail(`6b ${u.head}: expected a warning for the lower totals`);
  codes = await refused(call, { electionId, draftId: u.d.draftId, acknowledged: [], confirmCount: u.doc.confirmCount });
  if (!codes.includes('unacknowledged')) fail(`6b: refused for ${codes.join(', ')}, expected unacknowledged`);
  console.log(`6b ${u.head}; publish with warnings unticked refused (${codes.join(', ')})`);
  await discard(u.d);

  // 6c. Two drafts, A then B: publish B, and A is refused as stale.
  const a = await ctx.upload('04');
  const b = await ctx.upload('05');
  ctx.requireReady(a);
  ctx.requireReady(b);
  t0 = Date.now();
  await ctx.publishIt(b, `6c B: ${b.head}`, t0);
  codes = await refused(call, { electionId, draftId: a.d.draftId, acknowledged: ackAll(a.doc), confirmCount: a.doc.confirmCount });
  if (!codes.includes('stale')) fail(`6c: draft A refused for ${codes.join(', ')}, expected stale`);
  if ((await ctx.draftDoc(a.d.draftId)).status !== 'stale') fail('6c: draft A is not marked stale');
  console.log(`6c A: ${a.head}; publish refused (${codes.join(', ')})`);
  await discard(a.d);

  // End on the latest file, as after the night's last upload.
  t0 = Date.now();
  u = await ctx.upload('06');
  ctx.requireReady(u);
  await ctx.publishIt(u, `end: ${u.head}`, t0);

  // 7. Discard anything left open.
  const open = (await db.collection(`elections/${electionId}/drafts`).where('status', 'in', ['ready', 'blocked', 'stale']).get()).docs;
  for (const x of open) await call('discardDraft', { electionId, draftId: x.id });
  console.log(`Rehearsal steps 4-7 passed: ${versions.length} publishes in all; ${open.length} leftover draft(s) discarded.`);
}

/** Makes (or resets) the bot's Auth user with a fresh random password and its admins doc; returns the sign-in. */
async function ensureBot(db) {
  const email = `${BOT_UID}@${project}.invalid`;
  const password = crypto.randomBytes(24).toString('base64url');
  try {
    await admin.auth().updateUser(BOT_UID, { email, password, disabled: false });
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    await admin.auth().createUser({ uid: BOT_UID, email, password, displayName: 'Staging test-election bot' });
  }
  await db.doc(`admins/${BOT_UID}`).set({ email, added: new Date().toISOString(), note: 'tools/staging-election.js' });
  return { email, password };
}

async function main() {
  admin.initializeApp({ projectId: project });
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
  const checker = checkPages ? await require('./check-live-pages').createChecker({ bucket: `${project}-results`, emulator }) : null;

  // makeActive (below) deactivates whichever election is active now; it is made active again at the end,
  // so a rehearsal in production leaves a real election that was set up beforehand as it was.
  const previous = (await db.collection('elections').where('active', '==', true).get()).docs.map((d) => d.id).find((id) => id !== electionId);
  if (previous) console.log(`${previous} is the active election now; it is made active again at the end.`);
  try {
    const bot = await ensureBot(db);
    await signInWithEmailAndPassword(auth, bot.email, bot.password);
    await call('ping', {});
    console.log(`${project}: signed in as ${BOT_UID}; election ${electionId}; ${publish ? 'publishing' : 'drafts only'} ${steps.join(' ')} (${set})`);

    // makeActive: only the active election may publish (current/ is one set per bucket). Staging has no
    // real election to displace; production gets here only with --allow-production, for a rehearsal.
    await call('upsertElection', {
      id: electionId, name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: Number(set),
      enablePrecinctResults: true, makeActive: true,
    });
    // A run from 00 starts from an empty election, as on the night: a Zero file merged with a previous
    // run's selected ED file would be blocked (zero-file-has-votes). currentVersion is kept, so publishes
    // still chain on the live version.
    const existing = (await db.doc(`elections/${electionId}`).get()).data();
    if (steps[0] === '00' && (existing.selectedEarlyUploadId || existing.selectedEdUploadId)) {
      await db.doc(`elections/${electionId}`).update({ selectedEarlyUploadId: null, selectedEdUploadId: null });
      console.log(`Cleared ${electionId}'s selected uploads from a previous run.`);
    }

    const ctx = makeContext({ call, db, checker });
    for (const prefix of steps) {
      const t0 = Date.now();
      const u = await ctx.upload(prefix);
      ctx.requireReady(u);
      if (!publish) { console.log(u.head); continue; }
      await ctx.publishIt(u, u.head, t0);
    }
    if (rehearsal) await rehearse(ctx);
    if (ctx.pageProblems) throw new Error(`${ctx.pageProblems} difference(s) between the public pages and the CSV files`);
  } catch (e) {
    const refusals = e.details?.refusals?.map((x) => x.code).join(', ');
    console.error(`FAIL: ${e.code ?? ''} ${e.message}${refusals ? ` (refusals: ${refusals})` : ''}`);
    failed = true;
  } finally {
    if (previous) {
      await db.doc(`elections/${electionId}`).update({ active: false });
      await db.doc(`elections/${previous}`).update({ active: true });
      console.log(`${previous} is the active election again.`);
    }
    if (!keepAdmin) {
      await db.doc(`admins/${BOT_UID}`).delete().catch((e) => console.error(`Could not remove admins/${BOT_UID}: ${e.message}`));
      await admin.auth().updateUser(BOT_UID, { disabled: true }).catch(() => { /* never created */ });
    }
    if (checker) await checker.close();
    await deleteApp(app);
    await admin.app().delete();
  }
  console.log(failed ? 'FAIL' : `OK: ${electionId} ${publish ? 'published' : 'drafted'} through ${steps.at(-1)}.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
