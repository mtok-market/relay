import { enforceModelEcho, buildFundReport, buildDrawReport, requiresFeeLeg } from '../lib.mjs';
import { createOnchainVerifier, usdToAtomic } from '../core/onchain.js';
import { send } from './http.mjs';

const CONTEXT_CEIL = 4096;
const BALANCE_EPSILON = 1e-6;
const SERVED_CAP = 50000;

const rpcUrlsFor = (chainId, rpcFlag) => rpcFlag ? [rpcFlag] : chainId === 8453
  ? ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']
  : ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];

export async function createRelayRuntime(config) {
  const served = new Map();
  const drawLocks = new Map();
  const platform = await fetchPlatformConfig(config);
  const verifier = createOnchainVerifier({ rpcUrls: rpcUrlsFor(platform.chainId, config.rpcFlag), usdcAddress: platform.usdcAddress });
  if (!verifier.configured) throw new Error('onchain verifier not configured (missing usdcAddress in /api/config)');

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
            sellerWallet: config.settlementAddr,
            feeRecipient: platform.feeAddress,
          });
        } catch (e) {
          return send(res, 402, { error: 'payment_unverified', detail: e.message });
        }
        if (!paid?.ok) return send(res, 402, { error: 'payment_unverified', detail: paid?.reason || 'unknown' });
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

      let maxTok = CONTEXT_CEIL;
      const reqMax = Number(request?.max_tokens);
      if (reqMax > 0) maxTok = Math.min(maxTok, Math.floor(reqMax));
      if (config.outPrice > 0) maxTok = Math.min(maxTok, Math.floor(remainingUsd / config.outPrice * 1e6));
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
        rep = await reportToPlatform({ ...buildDrawReport({ offerId: config.offerId, buyerId, bookingId, n, usage: completion.usage }), ...(drawPaidTxHash ? { drawPaidTxHash } : {}) });
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
