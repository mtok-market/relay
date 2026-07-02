import { enforceModelEcho, buildFundReport, buildDrawReport, requiresFeeLeg, configuredFeeAtomic, capOutput, paidBudgetTokensFor } from '../lib.mjs';
import { createOnchainVerifier, usdToAtomic } from '../core/onchain.js';
import { send } from './http.mjs';
import { rpcUrlsFor } from './rpc.mjs';
import crypto from 'node:crypto';

const CONTEXT_CEIL = 4096;
const BALANCE_EPSILON = 1e-6;
const SERVED_CAP = 50000;
const hash32 = (v) => '0x' + crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex');

export async function createRelayRuntime(config) {
  const served = new Map();
  const drawLocks = new Map();
  const platform = await fetchPlatformConfig(config);
  const verifier = createOnchainVerifier({ rpcUrls: rpcUrlsFor(platform.chainId, config.rpcFlag), usdcAddress: platform.usdcAddress });
  if (!verifier.configured) throw new Error('onchain verifier not configured (missing usdcAddress in /api/config)');

  // Payer screen for contract-mode draws (gates-to-classifiers groundwork,
  // docs/chain-native-phase2.md): the platform can no longer refuse money that
  // already moved on-chain, so refusal-at-serve moves to the relay edge. The
  // VERIFIED DrawPaid payer (the wallet that actually paid, off the USDC
  // transfer leg) is checked against a seller-configured denylist and an
  // optional async hook BEFORE any upstream call. Both default off/empty, so
  // behavior is unchanged until a seller configures one.
  const payerDenylist = new Set((config.payerDenylist ?? []).map((a) => String(a).trim().toLowerCase()).filter(Boolean));
  const screenPayer = typeof config.screenPayer === 'function' ? config.screenPayer : null;
  const payerDenied = async (payer) => {
    if (!payer) return false; // no verified payer surfaced: nothing to screen
    if (payerDenylist.has(payer)) return true;
    if (screenPayer && (await screenPayer(payer))) return true;
    return false;
  };

  const reportToPlatform = async (reportBody) => {
    const rr = await fetch(config.apiBase + '/api/chunks/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.mtokApiKey },
      body: JSON.stringify(reportBody),
    });
    const body = await rr.json().catch(() => ({}));
    return { ok: rr.status === 201, status: rr.status, body, booking: body?.booking ?? null };
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

  const handleFund = async (body, res) => {
    const { bookingId, n, sellerTxHash, feeTxHash, priceUsd, buyerId } = body;

    try {
      const sellerLeg = await verifier.verifyTransfer(sellerTxHash, { to: config.settlementAddr, minAtomic: usdToAtomic(priceUsd) });
      const sellerOk = Boolean(sellerLeg?.ok);
      const verifiedUsd = Number(sellerLeg?.amount ?? usdToAtomic(priceUsd)) / 1e6;
      let feeOk = true;
      if (requiresFeeLeg({ amountUsd: verifiedUsd, feeAddress: platform.feeAddress, feeBps: platform.feeBps, dustThresholdUsd: platform.dustThresholdUsd })) {
        const feeAtomic = usdToAtomic(verifiedUsd * (Number(platform.feeBps) || 0) / 10000);
        feeOk = (await verifier.verifyTransfer(feeTxHash, { to: platform.feeAddress, minAtomic: feeAtomic })).ok;
      }
      if (!sellerOk || !feeOk) return send(res, 402, { error: 'payment_unverified', detail: `seller=${sellerOk} fee=${feeOk}` });
    } catch (e) {
      return send(res, 402, { error: 'payment_unverified', detail: e.message });
    }

    let rep;
    try {
      rep = await reportToPlatform(buildFundReport({ offerId: config.offerId, buyerId, bookingId, n, priceUsd, sellerTxHash, feeTxHash }));
    } catch (e) {
      return send(res, 502, { error: 'report_failed', detail: e.message });
    }
    if (!rep.ok || !rep.booking) {
      console.error('mtok-relay: FUND report rejected (%d) for n=%d offerId=%s: %s', rep.status, n, config.offerId, JSON.stringify(rep.body));
      return send(res, 502, { error: 'report_failed', detail: rep.body?.error || rep.status });
    }

    return send(res, 200, { ...rep.booking, _bookingId: rep.booking.id, remainingUsd: rep.booking.remainingUsd });
  };

  const handleDraw = async (body, res) => {
    const { bookingId, n, buyerId, request, drawPaidTxHash } = body;
    if (!bookingId) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs bookingId' });
    if (n == null) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs a delivery index n (per-booking idempotency key)' });

    return withBookingLock(bookingId, async () => {
      const cacheKey = `${bookingId}:${n}`;
      if (served.has(cacheKey)) return send(res, 200, served.get(cacheKey));
      const requestHash = hash32(request);

      let remainingUsd;
      if (platform.dripContractAddress) {
        if (!drawPaidTxHash) return send(res, 402, { error: 'draw_payment_required', detail: 'contract mode requires drawPaidTxHash before upstream delivery' });
        let paid;
        try {
          paid = await verifier.verifyDrawPaid(drawPaidTxHash, {
            contractAddress: platform.dripContractAddress,
            buyerAgentId: buyerId,
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
        remainingUsd = Number(paid.event.sellerUsdAtomic || 0) / 1e6;
      } else {
        let booking;
        try {
          const r = await fetch(config.apiBase + `/api/bookings/${encodeURIComponent(bookingId)}`, { headers: { 'x-api-key': config.mtokApiKey } });
          const rb = await r.json().catch(() => ({}));
          if (r.status !== 200 || !rb?.booking) return send(res, 502, { error: 'booking_read_failed', detail: rb?.error || r.status });
          booking = rb.booking;
        } catch (e) {
          return send(res, 502, { error: 'booking_read_failed', detail: e.message });
        }
        remainingUsd = Number(booking.remainingUsd) || 0;
      }
      if (remainingUsd <= BALANCE_EPSILON) {
        return send(res, 402, { error: 'balance_exhausted', detail: `remainingUsd=${remainingUsd}`, _bookingId: bookingId, remainingUsd });
      }

      // Never generate more than (a) the context ceiling, (b) what the buyer asked
      // for, or (c) what the standing balance paid for at the offer's output price.
      let maxTok = CONTEXT_CEIL;
      const reqMax = Number(request?.max_tokens);
      if (reqMax > 0) maxTok = capOutput(maxTok, Math.floor(reqMax));
      if (config.outPrice > 0) {
        maxTok = capOutput(maxTok, paidBudgetTokensFor({ chunkUsd: remainingUsd, outputPricePerMTok: config.outPrice }));
      }
      const safeRequest = { ...request, max_tokens: Math.max(1, maxTok) };

      let completion;
      try {
        const upstreamRes = await fetch(config.upstream + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.upstreamKey },
          body: JSON.stringify(safeRequest),
        });
        completion = await upstreamRes.json();
      } catch (e) {
        return send(res, 502, { error: 'upstream_error', detail: e.message });
      }

      try { enforceModelEcho(completion.model, config.model); }
      catch (e) { return send(res, 502, { error: 'model_mismatch', detail: e.message }); }

      let rep;
      try {
        rep = await reportToPlatform({ ...buildDrawReport({ offerId: config.offerId, buyerId, bookingId, n, usage: completion.usage }), ...(drawPaidTxHash ? { drawPaidTxHash, requestHash } : {}) });
      } catch (e) {
        console.error('mtok-relay: DRAW report failed (network) for n=%d offerId=%s: %s', n, config.offerId, e.message);
        return send(res, 502, { error: 'report_failed', detail: e.message });
      }
      if (!rep.ok || !rep.booking) {
        console.error('mtok-relay: DRAW report rejected (%d) for n=%d offerId=%s: %s', rep.status, n, config.offerId, JSON.stringify(rep.body));
        return send(res, rep.status === 402 ? 402 : 502, { error: rep.body?.error?.code || rep.body?.error || 'report_failed', detail: rep.body?.error?.message || rep.status, _bookingId: bookingId });
      }

      const payload = { ...completion, _bookingId: rep.booking.id, remainingUsd: rep.booking.remainingUsd };
      served.set(cacheKey, payload);
      if (served.size > SERVED_CAP) served.delete(served.keys().next().value);
      return send(res, 200, payload);
    });
  };

  return { handleFund, handleDraw };
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
