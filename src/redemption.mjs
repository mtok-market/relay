import fs from 'node:fs';

// Durable per-draw redemption for the reference relay (#495 / #459). A paid draw
// must serve EXACTLY once, and an honest retry (a lost 200) must replay the same
// completion without re-running upstream. The house relay does this with Cloudflare
// KV, but `npx mtok-relay` is a plain node process with no KV, so the money guard has
// to survive a restart on its own: a local append-only JSONL log (drawKey -> {at,
// payload}), loaded + pruned-by-age on boot, appended on each serve. Without a
// writable path it falls back to IN-MEMORY only and WARNS loudly (a restart or a
// long idle can then re-serve one payment for a fresh inference, the pre-#495 hole),
// so a seller running ephemeral or at scale wires --redemption-file to a durable path
// (or swaps in their own store: this exposes the same has/get/set the runtime uses).
//
// Retention (default 7d) bounds the file: an honest retry is seconds-to-minutes old,
// so a replay a week after payment is not a real retry. There is no mid-session
// eviction, the guard is authoritative for everything inside the window.
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function createRedemptionStore({ file = null, retentionMs = DEFAULT_RETENTION_MS, now = () => Date.now(), log = console } = {}) {
  const map = new Map(); // drawKey -> { payload, at }
  let durable = false;

  if (file) {
    try {
      if (fs.existsSync(file)) {
        const cutoff = now() - retentionMs;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const { k, at, payload } = JSON.parse(line);
            if (k && Number(at) >= cutoff) map.set(k, { payload, at: Number(at) });
          } catch { /* skip a corrupt/truncated line, keep the rest */ }
        }
      }
      // Compact on boot (also creates the file + proves writability): rewrite with
      // only the retained entries, dropping aged-out + corrupt lines so the file
      // can't grow forever.
      fs.writeFileSync(file, [...map].map(([k, e]) => JSON.stringify({ k, at: e.at, payload: e.payload })).join('\n') + (map.size ? '\n' : ''));
      durable = true;
      log.log?.(`mtok-relay: durable redemption at ${file} (${map.size} entries loaded)`);
    } catch (e) {
      log.warn?.(`mtok-relay: redemption file ${file} not writable (${e.message}); redemption is IN-MEMORY ONLY, a restart can re-serve a paid draw (#495). Point --redemption-file at a durable path.`);
      durable = false;
    }
  } else {
    log.warn?.('mtok-relay: no --redemption-file, redemption is IN-MEMORY ONLY, a restart or long idle can re-serve one payment for a fresh inference (#495). Set --redemption-file to a durable path.');
  }

  return {
    durable,
    has(key) { return map.has(key); },
    get(key) { return map.get(key)?.payload; },
    set(key, payload) {
      const at = now();
      map.set(key, { payload, at });
      // Synchronously durable: a crash between set() and a flush must NOT lose the
      // redemption (that would re-serve one payment). appendFileSync is small +
      // append-only; the boot compaction bounds the file.
      if (durable) { try { fs.appendFileSync(file, JSON.stringify({ k: key, at, payload }) + '\n'); } catch { /* best-effort durability */ } }
    },
  };
}
