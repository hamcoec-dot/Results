'use strict';
/**
 * Retry for bucket calls that fail on a dropped connection or a busy server. The storage client
 * only retries calls it can prove idempotent (with generation preconditions), so a plain save()
 * that hits ECONNRESET fails the whole upload. Every bucket call the service makes is safe to
 * repeat: it writes the same bytes to the same path, copies, reads or deletes.
 */
const NETWORK = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ESOCKETTIMEDOUT', 'UND_ERR_SOCKET']);
const STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** True for errors worth another try: network drops and 408/429/5xx; never 4xx answers such as 404. */
function isTransient(e) {
  if (!e) return false;
  if (NETWORK.has(e.code) || NETWORK.has(e.cause?.code)) return true;
  const status = typeof e.code === 'number' ? e.code : e.response?.status ?? e.status;
  if (STATUS.has(status)) return true;
  // A server's answer (any HTTP status) is final even if its text quotes a network error.
  if (typeof status === 'number') return false;
  return /\b(ECONNRESET|socket hang up)\b/.test(e.message ?? '');
}

/**
 * Run fn, retrying transient failures after delays[i] ms (default 3 tries in all). The last error
 * is thrown as is, so callers see the real cause.
 */
async function withRetry(fn, { delays = [200, 800], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= delays.length || !isTransient(e)) throw e;
      onRetry?.(e, attempt + 1);
      await sleep(delays[attempt]);
    }
  }
}

module.exports = { withRetry, isTransient };
