/**
 * Firebase web configuration for the admin and review pages (never loaded by the public pages).
 *
 * PHASE 5 TODO: paste the web app config of project `hcec-election-results` (Console → Project
 * settings → Your apps) over PROD below. These values are public identifiers, not secrets.
 *
 * Local development: open the page on localhost / 127.0.0.1 with ?emulator to use the Firebase
 * Emulator Suite (npm run test:emulator, or emulators:start — see README).
 */
(function () {
  'use strict';

  var PROD = {
    apiKey: 'REPLACE_IN_PHASE_5',
    authDomain: 'hcec-election-results.firebaseapp.com',
    projectId: 'hcec-election-results',
    storageBucket: 'hcec-election-results.appspot.com',
    appId: 'REPLACE_IN_PHASE_5',
    publicBucket: 'hcec-election-results-results',
  };
  var EMULATOR = {
    apiKey: 'demo-key',
    authDomain: 'demo-hcec.firebaseapp.com',
    projectId: 'demo-hcec',
    storageBucket: 'demo-hcec.appspot.com',
    appId: 'demo-app',
    publicBucket: 'demo-hcec-results',
  };

  var local = ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;
  var emulator = local && /[?&]emulator\b/.test(location.search);
  var cfg = emulator ? EMULATOR : PROD;

  window.RESULTS_ADMIN = {
    emulator: emulator,
    publicBucket: cfg.publicBucket,
    /** Public URL of an object in the results bucket (drafts and current files). */
    publicUrl: function (path) {
      return emulator
        ? 'http://127.0.0.1:9199/download/storage/v1/b/' + cfg.publicBucket + '/o/' + encodeURIComponent(path) + '?alt=media'
        : 'https://storage.googleapis.com/' + cfg.publicBucket + '/' + path.split('/').map(encodeURIComponent).join('/');
    },
    /** Query string to carry the emulator switch onto linked admin pages. */
    carry: emulator ? 'emulator&' : '',
  };

  if (typeof firebase === 'undefined') return;
  firebase.initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, storageBucket: cfg.storageBucket, appId: cfg.appId });
  window.RESULTS_ADMIN.functions = firebase.app().functions('us-east1');
  if (emulator) {
    firebase.auth().useEmulator('http://127.0.0.1:9099');
    firebase.firestore().useEmulator('127.0.0.1', 8181);
    window.RESULTS_ADMIN.functions.useEmulator('127.0.0.1', 5001);
    console.info('Using Firebase emulators');
  }
}());
