import fs from 'node:fs';
import crypto from 'node:crypto';

// Durable per-draw redemption for the reference relay (#495 / #459). A paid draw
// may attempt upstream at most once, and an honest retry (a lost 200) replays the same
// completion without re-running upstream. The house relay does this with Cloudflare
// KV, but `npx mtok-relay` is a plain node process with no KV, so the money guard has
// to survive a restart on its own: a local append-only JSONL log (drawKey -> {at,
// state, payload?}), loaded + pruned-by-age on boot, appended on each serve. Without a
// writable path it fails closed before upstream spend. A pending claim is written
// before inference; completion appends a second record. A crash or post-spend error
// therefore leaves a durable pending record which cannot run upstream again.
//
// Retention (default 7d) bounds the JSONL log: an honest retry is seconds-to-minutes old,
// so a replay a week after payment is not a real retry. There is no mid-session
// eviction, the guard is authoritative for everything inside the window.
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createRedemptionStore({ file = null, retentionMs = DEFAULT_RETENTION_MS, now = () => Date.now(), log = console } = {}) {
  const map = new Map(); // drawKey -> { state: pending|complete, payload?, at }
  const claimsDir = file ? `${file}.claims` : null;
  let durable = false;
  let seenVersion = null;

  const recordFor = (key, entry) => ({
    k: key,
    at: entry.at,
    state: entry.state,
    ...(entry.state === 'complete' ? { payload: entry.payload } : {}),
  });

  const syncWrite = (target, flags, data) => {
    const fd = fs.openSync(target, flags);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };

  const readRecords = () => {
    const loaded = new Map();
    if (!fs.existsSync(file)) return loaded;
    const cutoff = now() - retentionMs;
    let lineNumber = 0;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch { throw new Error(`malformed redemption record at line ${lineNumber}`); }
      const { k, at } = parsed;
      if (typeof k !== 'string' || !k || !Number.isFinite(Number(at))) {
        throw new Error(`malformed redemption record at line ${lineNumber}`);
      }
      if (Number(at) < cutoff) continue;
      // Old records had only { k, at, payload }; they are completed draws.
      const state = parsed.state === 'pending' ? 'pending' : 'complete';
      loaded.set(k, { state, at: Number(at), ...(state === 'complete' ? { payload: parsed.payload } : {}) });
    }
    return loaded;
  };
  const fileVersion = () => {
    try {
      const stat = fs.statSync(file);
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  };

  if (file) {
    try {
      for (const [key, entry] of readRecords()) map.set(key, entry);
      // Compact through an atomic same-directory rename. A crash before rename
      // leaves the previous claims intact instead of truncating the live guard.
      const compact = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      try {
        syncWrite(compact, 'w', [...map].map(([k, e]) => JSON.stringify(recordFor(k, e))).join('\n') + (map.size ? '\n' : ''));
        fs.renameSync(compact, file);
      } finally {
        fs.rmSync(compact, { force: true });
      }
      fs.mkdirSync(claimsDir, { recursive: true });
      // ponytail: boot-only marker compaction; a long-lived process accumulates
      // markers until restart. Past the retention window the JSONL record has aged
      // out and the runtime's #580 maxPaidAgeMs bound refuses payments that old, so
      // the marker is normally redundant. Named residual (#600, accepted): the #580
      // age read SKIPS on an unreadable paid block (RPC blip), so a stale replay that
      // lands in that blip after a restart can buy ONE extra bounded serve per draw.
      // boundServe caps the damage; closing it would refuse honest fresh draws on the
      // same blip, which is worse. Anything younger than retention stays untouched.
      // Wall clock deliberately, not the injected now(): mtimes are wall clock.
      const markerCutoff = Date.now() - retentionMs;
      for (const name of fs.readdirSync(claimsDir)) {
        try {
          const marker = `${claimsDir}/${name}`;
          if (fs.statSync(marker).mtimeMs < markerCutoff) fs.unlinkSync(marker);
        } catch { /* a raced or unreadable marker just waits for the next boot */ }
      }
      durable = true;
      seenVersion = fileVersion();
      log.log?.(`mtok-relay: durable redemption at ${file} (${map.size} entries loaded)`);
    } catch (e) {
      map.clear();
      log.warn?.(`mtok-relay: redemption file ${file} not writable (${e.message}); paid serves will fail closed. Point --redemption-file at a durable path.`);
      durable = false;
    }
  } else {
    log.warn?.('mtok-relay: no --redemption-file; paid serves will fail closed because a claim cannot be persisted. Set --redemption-file to a durable path.');
  }

  const append = (key, entry) => {
    if (!durable) throw new Error('durable redemption unavailable');
    syncWrite(file, 'a', JSON.stringify(recordFor(key, entry)) + '\n');
    seenVersion = fileVersion();
  };

  const markerFor = (key) => `${claimsDir}/${crypto.createHash('sha256').update(String(key)).digest('hex')}`;
  const markClaimed = (key) => {
    if (!durable) throw new Error('durable redemption unavailable');
    const marker = markerFor(key);
    try {
      // ponytail: per-draw markers are a stdlib-only interprocess CAS; the boot
      // sweep above ages them out past retention. Replace with a transactional
      // store if scale requires it.
      syncWrite(marker, 'wx', String(key) + '\n');
      return true;
    } catch (e) {
      if (e?.code === 'EEXIST') return false;
      throw e;
    }
  };

  // Another process may append pending/complete records after this store boots.
  // Refresh missing or pending keys before answering so a load-balanced retry can
  // replay process A's completion through process B. Parse into a temporary map
  // first: a concurrent partial append or damaged line never leaks partial state.
  const refresh = () => {
    if (!durable) return;
    const version = fileVersion();
    if (!version || version === seenVersion) return;
    try {
      for (const [key, entry] of readRecords()) map.set(key, entry);
      seenVersion = version;
    } catch (e) {
      log.warn?.(`mtok-relay: could not refresh redemption file ${file} (${e.message}); keeping the existing fail-closed state`);
    }
  };
  const state = (key) => {
    const current = map.get(key)?.state;
    if (durable && (!current || current === 'pending')) refresh();
    return map.get(key)?.state ?? null;
  };

  return {
    durable,
    retentionMs, // the window this store is authoritative for; the runtime also uses it as the on-chain draw-age bound (#580).
    has(key) { return map.has(key); },
    state,
    get(key) { return state(key) === 'complete' ? map.get(key).payload : undefined; },
    claim(key, markerKey = key) {
      if (map.has(key)) return false;
      if (!markClaimed(markerKey)) return false;
      const entry = { state: 'pending', at: now() };
      append(key, entry); // persist before exposing the claim to the runtime
      map.set(key, entry);
      return true;
    },
    complete(key, payload) {
      if (map.get(key)?.state !== 'pending') throw new Error('redemption is not pending');
      const entry = { state: 'complete', payload, at: now() };
      append(key, entry); // a failed completion write deliberately leaves pending
      map.set(key, entry);
    },
    // Backward-compatible store API for callers which only persist completed
    // payloads. The relay runtime itself always uses claim() then complete().
    set(key, payload) {
      const entry = { state: 'complete', payload, at: now() };
      if (durable) append(key, entry);
      map.set(key, entry);
    },
  };
}
