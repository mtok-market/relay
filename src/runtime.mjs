import { createRedemptionStore } from './redemption.mjs';
import { createPostgresRedemptionStore } from './postgres-redemption.mjs';
import { createOnchainVerifier } from '../core/onchain.js';
import { normalizeFeeSchedule, paymentFeeBpsAt } from '../core/fee-policy.js';
import { httpUpstream, httpInputCounter, createServeCore } from '../bridge/bridge.mjs';
import { send } from './http.mjs';
import { rpcUrlsFor } from './rpc.mjs';

export async function createRelayRuntime(config) {
  // Durable redemption (#495): a paid request attempts upstream at most once and
  // a completed honest retry replays the stored completion, across restarts. verifyDrawPaid is a permanent
  // chain read that consumes nothing, so this store -- NOT a TTL cache -- is the
  // one-serve-per-payment guard. Replicas on separate hosts use one PostgreSQL
  // database; the file store coordinates only processes sharing its filesystem.
  const drawLocks = new Map();
  const platform = await fetchPlatformConfig(config);
  // Refresh activation history at least once a minute for NEW claims. A failed
  // refresh cannot extend an obsolete rate indefinitely. Known claims replay
  // without another policy fetch after their payment proof is verified.
  //
  // The fee RECIPIENT is deliberately NOT refreshed (codex review): the verifier
  // matches the fee transfer against an EXACT address, so tracking a live address
  // change would refuse draws whose fee went to the address the buyer read at
  // payment time. A recipient change is a rare, coordinated treasury migration that
  // rides a relay restart; pinning the boot address is the safe status quo.
  const FEE_REFRESH_MS = 60_000;
  let lastConfigFetch = Date.now();
  let refreshing;
  const refreshPlatformFee = () => {
    if (!refreshing) refreshing = (async () => {
      try {
        const fresh = await fetchPlatformConfig(config);
        platform.feeSchedule = fresh.feeSchedule;
        lastConfigFetch = Date.now();
        return true;
      } catch (e) {
        (config.log ?? console).error?.(`mtok relay: platform config refresh failed (${e.message}); new claims require current policy`);
        return false;
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  // Pin the chain (codex #566 review): the verifier supports expectedChainId + a wrong_chain
  // guard, but the relay was not passing it, so a relay pointed at a wrong or spoofed --rpc could
  // accept a receipt from another chain and spend upstream against a payment that never landed on
  // Base. platform.chainId is the /config-declared chain; pin to it and fail closed on mismatch.
  const verifier = createOnchainVerifier({ rpcUrls: rpcUrlsFor(platform.chainId, config.rpcFlag), usdcAddress: platform.usdcAddress, expectedChainId: platform.chainId });
  if (!verifier.configured) throw new Error('onchain verifier not configured (missing usdcAddress in /api/config)');
  const served = config.redemptionDatabaseUrl
    ? await createPostgresRedemptionStore({ url: config.redemptionDatabaseUrl })
    : createRedemptionStore({ file: config.redemptionFile, log: config.log });

  // Payer screen for contract-mode draws (gates-to-classifiers groundwork,
  // #387): the platform can no longer refuse money that
  // already moved on-chain, so refusal-at-serve moves to the relay edge. The
  // VERIFIED DrawPaid payer (the wallet that actually paid, off the USDC
  // transfer leg) is checked against a seller-configured denylist and an
  // optional async hook BEFORE any upstream call. Both default off/empty, so
  // behavior is unchanged until a seller configures one. The POLICY (denylist +
  // hook composition) lives here; the serve core only calls the predicate.
  const payerDenylist = new Set((config.payerDenylist ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean));
  const screenPayer = typeof config.screenPayer === 'function' ? config.screenPayer : null;

  // The transport leg is mtok-bridge's httpUpstream (#566): the market layer here composes the
  // bridge's forward-to-OpenAI-compatible-upstream guts instead of reimplementing the fetch. The
  // relay's config.upstream is the API ROOT (no /v1); the bridge appends /chat/completions to its
  // baseUrl, so we hand it config.upstream + '/v1' to keep the delivered URL byte-identical.
  const upstream = httpUpstream({ baseUrl: config.upstream + '/v1', key: config.upstreamKey, timeoutMs: config.upstreamTimeoutMs ?? 120_000 });
  const countInputTokens = config.countInputTokens ?? httpInputCounter({ url: config.upstream + '/tokenize', key: config.upstreamKey });
  const payerDenied = async (payer) => {
    if (!payer) return false; // no verified payer surfaced: nothing to screen
    if (payerDenylist.has(payer)) return true;
    if (screenPayer && (await screenPayer(payer))) return true;
    return false;
  };

  // The paid-serve state machine itself (validate => verify => bound => claim => upstream =>
  // complete, with the #597 fail-closed semantics) is mtok-bridge's serve core (#603), shared
  // with the workers-ai house seller. This runtime keeps only the node-host concerns: the fs
  // redemption store, the platform config fetch, the payer-screen policy, and the booking locks.
  const core = createServeCore({
    model: config.model,
    inPrice: config.inPrice,
    outPrice: config.outPrice,
    verifier,
    redemption: served,
    upstream,
    log: config.log,
    offerId: config.offerId,
    sellerAgentId: config.sellerAgentId,
    sellerWallet: config.settlementAddr,
    dripContractAddress: platform.dripContractAddress,
    feeRecipient: platform.feeAddress,
    feeBps: async ({ paidAtMs }) => {
      if (Date.now() - lastConfigFetch >= FEE_REFRESH_MS && !(await refreshPlatformFee())) throw new Error('fee policy refresh failed');
      return paymentFeeBpsAt(platform.feeSchedule, paidAtMs);
    },
    // #654: per-relay output sanity ceiling (unset => the shared generous default).
    maxOutputTokens: config.maxOutputTokens,
    maxInputTokens: config.maxInputTokens,
    countInputTokens,
    screenPayer: payerDenied,
  });

  const withBookingLock = async (bookingId, fn) => {
    const previous = drawLocks.get(bookingId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    drawLocks.set(bookingId, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (drawLocks.get(bookingId) === tail) drawLocks.delete(bookingId);
    }
  };

  let active = 0;
  const handleDraw = async (body, res) => {
    // Bound both distinct booking locks and waiters, including non-HTTP callers.
    if (active >= (config.maxConcurrentRequests ?? 64)) return send(res, 503, { error: 'relay_busy' });
    active++;
    try {
      return await withBookingLock(String(body?.bookingId ?? ''), async () => {
      let out = await core.serve(body);
      // #654 (codex review): a fee DECREASE that landed inside the current TTL window
      // (before the periodic refresh picked it up) makes the fee-floor over-demand and
      // refuse an already-paid draw as fee_amount_too_low, which the SDK then DISPUTES.
      // The fee check runs before any claim or upstream spend, so on exactly that
      // refusal, force a config refresh and retry once -- closing the window so an
      // honest draw is never disputed over a stale fee rate.
      if (out.status === 402 && out.body?.detail === 'fee_amount_too_low') {
        out = await refreshPlatformFee()
          ? await core.serve(body)
          : { status: 503, body: { error: 'fee_policy_unavailable', _bookingId: body.bookingId } };
      }
      return send(res, out.status, out.body);
      });
    } finally {
      active--;
    }
  };

  const handleQuote = async (body, res) => {
    if (active >= (config.maxConcurrentRequests ?? 64)) return send(res, 503, { error: 'relay_busy' });
    active++;
    try {
      const out = await core.quote(body.request);
      return send(res, out.status, out.body);
    } finally {
      active--;
    }
  };

  return { handleDraw, handleQuote, close: () => served.close?.() };
}

async function fetchPlatformConfig(config) {
  const r = await fetch(config.apiBase + '/api/config', { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error('config fetch failed: ' + r.status);
  const body = await r.json();
  return {
    feeAddress: body.feeAddress,
    feeSchedule: normalizeFeeSchedule(body.feeSchedule ?? [{ effectiveAtMs: 0, feeBps: body.feeBps ?? (body.feeAddress ? undefined : 0) }]),
    dustThresholdUsd: Number(body.dustThresholdUsd) || 0.001,
    chainId: Number(body.chainId ?? 8453),
    usdcAddress: body.usdcAddress,
    dripContractAddress: body.dripContractAddress,
  };
}
