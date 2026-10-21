'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, isTransient } = require('../src/retry');

const err = (props, message = 'x') => Object.assign(new Error(message), props);
const noSleep = { sleep: async () => {} };

test('isTransient: network drops and busy servers, not real answers', () => {
  for (const e of [err({ code: 'ECONNRESET' }), err({ code: 'ETIMEDOUT' }), err({ cause: { code: 'UND_ERR_SOCKET' } }),
    err({ code: 503 }), err({ code: 429 }), err({ response: { status: 502 } }), err({ status: 500 }),
    err({}, 'request to http://x failed, reason: read ECONNRESET'), err({}, 'socket hang up')]) {
    assert.equal(isTransient(e), true, e.message + JSON.stringify(e));
  }
  for (const e of [null, undefined, err({ code: 404 }), err({ code: 412 }), err({ code: 403 }), err({ code: 'ENOENT' }),
    err({ response: { status: 400 } }), err({}, 'No such object')]) {
    assert.equal(isTransient(e), false, String(e?.message));
  }
});

test('withRetry: returns the first success, after transient failures', async () => {
  let calls = 0;
  const slept = [];
  const seen = [];
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw err({ code: 'ECONNRESET' });
    return 'ok';
  }, { delays: [5, 7], sleep: async (ms) => slept.push(ms), onRetry: (e, n) => seen.push(n) });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [5, 7]);
  assert.deepEqual(seen, [1, 2]);
});

test('withRetry: gives up after the last delay and throws the real error', async () => {
  let calls = 0;
  const last = err({ code: 503 }, 'third');
  await assert.rejects(withRetry(async () => { calls++; throw calls < 3 ? err({ code: 503 }) : last; }, noSleep), (e) => e === last);
  assert.equal(calls, 3);
});

test('withRetry: a permanent error is thrown at once', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw err({ code: 404 }, 'gone'); }, noSleep), /gone/);
  assert.equal(calls, 1);
});

test('withRetry: default sleep waits between tries', async () => {
  let calls = 0;
  const t0 = Date.now();
  assert.equal(await withRetry(async () => { if (++calls === 1) throw err({ code: 'EPIPE' }); return 1; }, { delays: [20] }), 1);
  assert.ok(Date.now() - t0 >= 15);
});
