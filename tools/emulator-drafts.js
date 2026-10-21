'use strict';
/**
 * Puts sample results on the running emulators for trying the public pages by hand:
 *   publishes the "02-After EV" sample to current/ (so ?emulator shows live results), then
 *   creates (does not publish) a draft of "03-After 5 Reporting" and prints its ?draft= links.
 *
 * Usage (emulators running, after node tools/seed-emulator.js):
 *   node tools/emulator-drafts.js            publish 02, draft 03
 *   node tools/emulator-drafts.js 04 05      publish 04, draft 05 (any two "NN-" sample prefixes)
 */
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const nm = (m) => require(path.join(ROOT, 'functions', 'node_modules', m));
const admin = nm('firebase-admin');
const { initializeApp, deleteApp } = nm('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = nm('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = nm('firebase/functions');

const PROJECT = 'demo-hcec';
const EID = '2026-11-03-general';
const SAMPLES = path.join(ROOT, 'Test_Files', 'Web Results Samples');

function sample(prefix) {
  const name = fs.readdirSync(SAMPLES).find((f) => f.startsWith(`${prefix}-`) && f.endsWith('(92).csv'));
  if (!name) throw new Error(`No sample "${prefix}-… (92).csv" in ${SAMPLES}`);
  return { name, csv: fs.readFileSync(path.join(SAMPLES, name), 'utf8') };
}

async function main() {
  const [livePrefix = '02', draftPrefix = '03'] = process.argv.slice(2);
  admin.initializeApp({ projectId: PROJECT });
  const db = admin.firestore();
  const app = initializeApp({ projectId: PROJECT, apiKey: 'demo-key', authDomain: `${PROJECT}.firebaseapp.com` }, 'client');
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const fns = getFunctions(app, 'us-east1');
  connectFunctionsEmulator(fns, '127.0.0.1', 5001);
  const call = (name, data) => httpsCallable(fns, name, { timeout: 120000 })(data).then((r) => r.data);

  await signInWithEmailAndPassword(auth, 'admin@example.test', 'emulator-only-pw');
  const kind = (prefix) => (Number(prefix) <= 2 ? 'early' : 'ed');

  const live = sample(livePrefix);
  const d1 = await call('createDraft', { electionId: EID, kind: kind(livePrefix), filename: live.name, csv: live.csv });
  const doc = (await db.doc(`elections/${EID}/drafts/${d1.draftId}`).get()).data();
  const acknowledged = doc.checks.filter((c) => c.severity === 'warn').map((c) => c.key);
  const r = await call('publishDraft', { electionId: EID, draftId: d1.draftId, acknowledged, confirmCount: doc.confirmCount });
  console.log(`Published ${live.name} as ${doc.dataVersion} (live check ${r.liveCheck.ok ? 'ok' : 'FAILED'}).`);

  const next = sample(draftPrefix);
  const d2 = await call('createDraft', { electionId: EID, kind: kind(draftPrefix), filename: next.name, csv: next.csv });
  console.log(`Draft of ${next.name}: ${d2.draftId}`);
  for (const page of ['index', 'reporting', 'precincts', 'scrolling']) {
    console.log(`  http://127.0.0.1:8123/${page}.html?emulator&draft=${d2.draftId}`);
  }
  console.log('Live: http://127.0.0.1:8123/index.html?emulator');

  await deleteApp(app);
  await admin.app().delete();
}

main().catch((e) => { console.error(e); process.exit(1); });
