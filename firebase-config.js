/**
 * Firebase web configuration for the admin and review pages (never loaded by the public pages).
 *
 * The "HCEC Results Admin" web app of each project (Console → Project settings → Your apps).
 * These values are public identifiers, not secrets.
 *
 * ?staging     use the staging project (hcec-election-results-staging) instead of production,
 *              carried onto the linked admin and draft pages.
 *
 * Local development: open the page on localhost / 127.0.0.1 with ?emulator to use the Firebase
 * Emulator Suite (npm run test:emulator, or emulators:start — see README).
 */
(function () {
  'use strict';

  var PROD = {
    apiKey: 'AIzaSyAZC_zyGEyJ79c7b7HDPbKrSMOrpUH8kOQ',
    authDomain: 'hcec-election-results.firebaseapp.com',
    projectId: 'hcec-election-results',
    storageBucket: 'hcec-election-results.firebasestorage.app',
    appId: '1:451148363848:web:d2b06c968393489ec0c07d',
    publicBucket: 'hcec-election-results-results',
  };
  var STAGING = {
    apiKey: 'AIzaSyCCAmob-dyxj5iAnuhwKZ1_1-Y-Z7V9EW4',
    authDomain: 'hcec-election-results-staging.firebaseapp.com',
    projectId: 'hcec-election-results-staging',
    storageBucket: 'hcec-election-results-staging.firebasestorage.app',
    appId: '1:579496488802:web:f95d66c5476ee08430c63b',
    publicBucket: 'hcec-election-results-staging-results',
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
  var staging = !emulator && /[?&]staging\b/.test(location.search);
  var cfg = emulator ? EMULATOR : staging ? STAGING : PROD;

  window.RESULTS_ADMIN = {
    emulator: emulator,
    staging: staging,
    publicBucket: cfg.publicBucket,
    /** Public URL of an object in the results bucket (drafts and current files). */
    publicUrl: function (path) {
      return emulator
        ? 'http://127.0.0.1:9199/download/storage/v1/b/' + cfg.publicBucket + '/o/' + encodeURIComponent(path) + '?alt=media'
        : 'https://storage.googleapis.com/' + cfg.publicBucket + '/' + path.split('/').map(encodeURIComponent).join('/');
    },
    /** Query string to carry the emulator or staging switch onto linked admin and draft pages. */
    carry: emulator ? 'emulator&' : staging ? 'staging&' : '',
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
