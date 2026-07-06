import { enforceModelEcho, configuredFeeAtomic, boundServe } from '../lib.mjs';
import { createRedemptionStore } from './redemption.mjs';
import { createOnchainVerifier } from '../core/onchain.js';
import { httpUpstream } from '../bridge/bridge.mjs';
import { send } from './http.mjs';
import { rpcUrlsFor } from './rpc.mjs';
import crypto from 'node:crypto';

const BALANCE_EPSILON = 1e-6;
const hash32 = (v) => '0x' + crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex');

export async function createRelayRuntime(config) {
  // Durable redemption (#495): a paid draw serves exactly once and an honest retry
  // replays the stored completion, across restarts. verifyDrawPaid is a permanent
  // chain read that consumes nothing, so this store -- NOT a TTL cache -- is the
  // one-serve-per-payment guard. See src/redemption.mjs for the durability model.
  const served = createRedemptionStore({ file: config.redemptionFile });
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
  // behavior is unchanged until a seller configures one.
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

  const handleDraw = async (body, res) => {
    const { bookingId, n, buyerId, request, drawPaidTxHash } = body;
    if (!bookingId) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs bookingId' });
    if (n == null) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs a delivery index n (per-booking idempotency key)' });

    return withBookingLock(bookingId, async () => {
      const requestHash = hash32(request);
      // The cache key BINDS the request preimage (requestHash), not just the
      // public bookingId + n. bookingId and n are emitted in plaintext in the
      // on-chain DrawPaid event, so keying on them alone would return a buyer's
      // paid, private completion to any stranger who read the chain and replayed
      // those two fields. requestHash is a hash of the exact prompt: an honest
      // retry sends the same request and hits the same entry, but a caller who
      // does not have the prompt cannot produce a key that hits (and a forged
      // request would miss, then fail verifyDrawPaid's own requestHash check).
      const cacheKey = `${bookingId}:${n}:${requestHash}`;
      if (served.has(cacheKey)) return send(res, 200, served.get(cacheKey));

      // Contract mode is the ONLY mode (#487): the legacy direct-transfer FUND
      // lane and its /api/bookings/:id balance read are gone. If the platform is
      // not running the drip contract, REFUSE the draw with a clear error rather
      // than fall back to a lane that no longer exists.
      if (!platform.dripContractAddress) {
        return send(res, 402, { error: 'contract_mode_required', detail: 'this relay only serves contract-mode draws; the platform is not reporting a dripContractAddress' });
      }
      if (!drawPaidTxHash) return send(res, 402, { error: 'draw_payment_required', detail: 'contract mode requires drawPaidTxHash before upstream delivery' });
      let paid;
      try {
        paid = await verifier.verifyDrawPaid(drawPaidTxHash, {
          contractAddress: platform.dripContractAddress,
          buyerAgentId: buyerId,
          sellerAgentId: config.sellerAgentId, // when set, enforces the offer-owner match (#codex review)
          bookingId,
          offerId: config.offerId,
          model: config.model,
          n,
          requestHash,
          sellerWallet: config.settlementAddr,
          feeRecipient: platform.feeAddress,
        });
      } catch (e) {
        return send(res, 402, { error: 'payment_unverified', detail: e.message });
      }
      if (!paid?.ok) return send(res, 402, { error: 'payment_unverified', detail: paid?.reason || 'unknown' });
      const expectedFee = configuredFeeAtomic({
        sellerUsdAtomic: paid.event.sellerUsdAtomic,
        feeAddress: platform.feeAddress,
        feeBps: platform.feeBps,
      });
      if (BigInt(paid.event.feeUsdAtomic || 0) < expectedFee) {
        return send(res, 402, { error: 'payment_unverified', detail: 'fee_amount_too_low' });
      }
      // Screen the verified payer before spending upstream capacity. The
      // payment already settled on-chain (that money is the buyer's loss);
      // this refuses the SERVICE, which is the only refusal an edge can
      // still make in contract mode.
      try {
        if (await payerDenied(String(paid.from || '').toLowerCase())) {
          return send(res, 403, { error: 'payer_denied', detail: 'the verified payer wallet is denylisted by this relay' });
        }
      } catch (e) {
        // A broken screen hook fails CLOSED: do not serve on an unscreenable payer.
        return send(res, 403, { error: 'payer_denied', detail: 'payer screening failed: ' + e.message });
      }
      const paidEvent = paid.event;
      const remainingUsd = Number(paid.event.sellerUsdAtomic || 0) / 1e6;
      if (remainingUsd <= BALANCE_EPSILON) {
        return send(res, 402, { error: 'balance_exhausted', detail: `remainingUsd=${remainingUsd}`, _bookingId: bookingId, remainingUsd });
      }

      // Bound BOTH legs against what the draw paid for (#495/#460). The relay used
      // to cap only OUTPUT, so a dust draw + a huge prompt got its output capped but
      // the whole prompt forwarded => the seller ate unbounded upstream INPUT compute.
      // Now: REFUSE before any upstream call if the estimated input cost alone meets
      // the payment, else cap output over the budget LEFT after input. Input is priced
      // at the higher of our offer price and the buyer's committed event price, so the
      // buyer can't zero the input leg to sneak a big prompt.
      const eventInPriceUsd = Number(paidEvent.inputPricePerMTokAtomic || 0) / 1e6;
      const inPrice = Math.max(Number(config.inPrice) || 0, eventInPriceUsd);
      const bound = boundServe({ messages: request?.messages, budgetUsd: remainingUsd, inPrice, outPrice: config.outPrice, reqMax: Number(request?.max_tokens) });
      if (bound.refuse) {
        return send(res, 402, { error: 'input_too_large', detail: `estimated input (~${bound.estIn} tokens, $${bound.estInCostUsd.toFixed(6)}) meets or exceeds the paid amount ($${remainingUsd}); send a shorter prompt or pay for more`, _bookingId: bookingId, remainingUsd });
      }
      const safeRequest = { ...request, max_tokens: bound.maxTok };

      let completion;
      try {
        completion = await upstream(safeRequest);
      } catch (e) {
        return send(res, 502, { error: 'upstream_error', detail: e.message });
      }

      try { enforceModelEcho(completion.model, config.model); }
      catch (e) { return send(res, 502, { error: 'model_mismatch', detail: e.message }); }

      // ── Contract mode is REPORT-FREE (chain-native phase 2 stage 3, #387) ──
      // The verified DrawPaid event IS the record: the platform indexes the
      // draw from MtokDripLedger logs, so there is nothing to report (the
      // platform deleted POST /api/chunks/report in #487). The flow is
      // verify => cap => serve => cache, and the relay holds no platform
      // secret. remainingUsd echoes what is left of THIS draw's paid amount
      // after metering at the event's committed per-MTok prices.
      const usage = completion.usage ?? {};
      const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
      const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
      // price is atomic USD per MTok (1e6 tokens): usd = tokens * priceAtomic / 1e12
      const usedUsd = (inTok * Number(paidEvent.inputPricePerMTokAtomic || 0) + outTok * Number(paidEvent.outputPricePerMTokAtomic || 0)) / 1e12;
      const payload = { ...completion, _bookingId: bookingId, remainingUsd: Math.max(0, Math.round((remainingUsd - usedUsd) * 1e6) / 1e6) };
      served.set(cacheKey, payload); // bounded by count + bytes + TTL inside the cache
      return send(res, 200, payload);
    });
  };

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
