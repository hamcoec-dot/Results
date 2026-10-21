'use strict';
/**
 * Seeds the running emulators for trying admin.html by hand:
 *   an admin user  admin@example.test / emulator-only-pw  (Auth emulator)
 *   its admins/{uid} doc, and the election 2026-11-03-general (Firestore emulator)
 *
 * Usage (emulators running): node tools/seed-emulator.js
 * Then open http://127.0.0.1:8123/admin.html?emulator
 */
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8181';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
const path = require('node:path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

const EMAIL = 'admin@example.test';
const PASSWORD = 'emulator-only-pw';

async function main() {
  admin.initializeApp({ projectId: 'demo-hcec' });
  let user;
  try {
    user = await admin.auth().getUserByEmail(EMAIL);
  } catch {
    user = await admin.auth().createUser({ email: EMAIL, password: PASSWORD });
  }
  const db = admin.firestore();
  await db.doc(`admins/${user.uid}`).set({ email: EMAIL, added: new Date().toISOString() });
  await db.doc('elections/2026-11-03-general').set({
    name: '2026-11-03 General', date: '2026-11-03', county: 'Hamilton', precinctCap: 92, enablePrecinctResults: true,
    active: true, currentVersion: null, selectedEarlyUploadId: null, selectedEdUploadId: null, publishLock: null,
    createdAt: new Date().toISOString(),
  }, { merge: true });
  console.log(`Seeded ${EMAIL} (uid ${user.uid}) and election 2026-11-03-general.`);
  await admin.app().delete();
}

main().catch((e) => { console.error(e); process.exit(1); });
