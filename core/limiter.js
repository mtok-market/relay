// Fixed-window rate limiter, keyed by caller identity (agent key, gateway
// key, or source address for registration). In-memory like everything else;
// generous defaults — this is abuse protection, not capacity management.

import { apiError } from './errors.js';

export function createLimiter({ windowMs = 60_000, max = 120, maxKeys = 10_000, now = () => Date.now() } = {}) {
  const windows = new Map(); // key -> { start, count }

  return {
    check(key, scope = 'api') {
      const id = `${scope}:${key}`;
      const t = now();
      let w = windows.get(id);
      if (!w || t - w.start >= windowMs) {
        w = { start: t, count: 0 };
        windows.delete(id);
        if (windows.size >= maxKeys) windows.delete(windows.keys().next().value);
        windows.set(id, w);
      }
      w.count += 1;
      if (w.count > max) {
        const retryInSeconds = Math.ceil((w.start + windowMs - t) / 1000);
        // Surface the retry hint as structured details so the router can also set
        // a conventional `Retry-After` HTTP header (seconds) on the 429 — machine
        // clients read the header, humans read the message.
        throw apiError(429, 'rate_limited', `Rate limit exceeded (${max}/${windowMs / 1000}s). Retry in ~${retryInSeconds}s.`, { retryAfterSeconds: retryInSeconds });
      }
    },
    get size() { return windows.size; },
  };
}
