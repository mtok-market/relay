import { createRedemptionStore } from './redemption.mjs';
import { createOnchainVerifier } from '../core/onchain.js';
import { httpUpstream, createServeCore } from '../bridge/bridge.mjs';
import { send } from './http.mjs';
import { rpcUrlsFor } from './rpc.mjs';

export async function createRelayRuntime(config) {
  // Durable redemption (#495): a paid request attempts upstream at most once and
  // a completed honest retry replays the stored completion, across restarts. verifyDrawPaid is a permanent
  // chain read that consumes nothing, so this store -- NOT a TTL cache -- is the
  // one-serve-per-payment guard. See src/redemption.mjs for the durability model.
  const served = createRedemptionStore({ file: config.redemptionFile, log: config.log });
  const drawLocks = new Map();
  const platform = await fetchPlatformConfig(config);
  // Pin the chain (codex #566 review): the verifier supports expectedChainId + a wrong_chain
  // guard, but the relay was not passing it, so a relay pointed at a wrong or spoofed --rpc could
  // accept a receipt from another chain and spend upstream against a payment that never landed on
  // Base. platform.chainId is the /config-declared chain; pin to it and fail closed on mismatch.
  const verifier = createOnchainVerifier({ rpcUrls: rpcUrlsFor(platform.chainId, config.rpcFlag), usdcAddress: platform.usdcAddress, expectedChainId: platform.chainId });
  if (!verifier.configured) throw new Error('onchain verifier not configured (missing usdcAddress in /api/config)');

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
  const upstream = httpUpstream({ baseUrl: config.upstream + '/v1', key: config.upstreamKey });
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
    feeBps: platform.feeBps,
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

  const handleDraw = (body, res) =>
    withBookingLock(String(body?.bookingId ?? ''), async () => {
      const out = await core.serve(body);
      return send(res, out.status, out.body);
    });

  return { handleDraw };
}

async function fetchPlatformConfig(config) {
  const r = await fetch(config.apiBase + '/api/config');
  if (!r.ok) throw new Error('config fetch failed: ' + r.status);
  const body = await r.json();
  return {
    feeAddress: body.feeAddress,
    feeBps: body.feeBps,
    dustThresholdUsd: Number(body.dustThresholdUsd) || 0.001,
    chainId: Number(body.chainId ?? 8453),
    usdcAddress: body.usdcAddress,
    dripContractAddress: body.dripContractAddress,
  };
}
