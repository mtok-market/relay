import { enforceModelEcho, configuredFeeAtomic, boundServe } from '../lib.mjs';
import { createRedemptionStore } from './redemption.mjs';
import { createOnchainVerifier } from '../core/onchain.js';
import { httpUpstream } from '../bridge/bridge.mjs';
import { send } from './http.mjs';
import { rpcUrlsFor } from './rpc.mjs';
import crypto from 'node:crypto';

const BALANCE_EPSILON = 1e-6;
const hash32 = (v) => '0x' + crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex');
const REQUEST_NONCE_RE = /^0x[0-9a-fA-F]{32}$/;
const CHAT_ROLES = new Set(['developer', 'system', 'user', 'assistant']);
const REQUEST_KEYS = new Set(['model', 'messages', 'max_tokens', 'temperature', 'response_format', 'stream', 'n']);

function legacyContentText(content) {
  const render = (part) => {
    if (typeof part === 'string') return part;
    if (Array.isArray(part)) return part.map(render).filter(Boolean).join('\n');
    if (part == null) return '';
    if (typeof part !== 'object') return String(part);
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    const type = typeof part.type === 'string' && /^[a-z0-9_-]{1,32}$/i.test(part.type) ? part.type : 'non-text';
    return `[${type} omitted]`;
  };
  return render(content) || '[empty legacy content]';
}

function sanitizeLegacyMessage(message) {
  const source = message && typeof message === 'object' && !Array.isArray(message) ? message : { content: message };
  if (CHAT_ROLES.has(source.role)) return { role: source.role, content: legacyContentText(source.content) };
  const label = source.role === 'tool' || source.role === 'function' ? source.role : 'legacy';
  return { role: 'user', content: `[${label} message]\n${legacyContentText(source.content)}` };
}

function validateRequest(request, model, { legacy = false } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { error: 'request must be an object' };
  }
  const unknown = Object.keys(request).find((key) => !REQUEST_KEYS.has(key));
  if (unknown && !legacy) return { error: `unsupported request field: ${unknown}` };
  if (!legacy && request.model != null && String(request.model) !== String(model)) {
    return { error: `request model ${request.model} is not served here` };
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return { error: 'request.messages must be a nonempty array' };
  }
  if (!legacy) {
    for (const message of request.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return { error: 'each message must be an object' };
      }
      const extra = Object.keys(message).find((key) => key !== 'role' && key !== 'content');
      if (extra) return { error: `unsupported message field: ${extra}` };
      if (!CHAT_ROLES.has(message.role)) return { error: `unsupported message role: ${message.role}` };
      if (typeof message.content !== 'string') return { error: 'message content must be plain text' };
    }
  }
  if (!legacy && request.stream != null && request.stream !== false) return { error: 'streaming is not supported' };
  if (!legacy && request.n != null && request.n !== 1) return { error: 'request.n must be 1' };
  const validMaxTokens = Number.isInteger(request.max_tokens) && request.max_tokens > 0;
  if (!legacy && request.max_tokens != null && !validMaxTokens) {
    return { error: 'max_tokens must be a positive integer' };
  }
  const validTemperature = Number.isFinite(request.temperature) && request.temperature >= 0 && request.temperature <= 2;
  if (!legacy && request.temperature != null && !validTemperature) {
    return { error: 'temperature must be between 0 and 2' };
  }
  let validResponseFormat = false;
  if (request.response_format != null) {
    const format = request.response_format;
    validResponseFormat = !!format && typeof format === 'object' && !Array.isArray(format)
      && Object.keys(format).length === 1
      && ['json_object', 'text'].includes(format.type);
    if (!legacy && !validResponseFormat) {
      return { error: 'response_format must be exactly { type: "json_object" } or { type: "text" }' };
    }
  }
  return {
    safeRequest: {
      model,
      messages: legacy
        ? request.messages.map(sanitizeLegacyMessage)
        : request.messages.map(({ role, content }) => ({ role, content })),
      ...(validMaxTokens ? { max_tokens: request.max_tokens } : {}),
      ...(validTemperature ? { temperature: request.temperature } : {}),
      ...(validResponseFormat ? { response_format: { type: request.response_format.type } } : {}),
    },
  };
}

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
    const { bookingId, n, buyerId, request, requestNonce, drawPaidTxHash } = body;
    const hasRequestNonce = Object.hasOwn(body, 'requestNonce');
    if (!bookingId) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs bookingId' });
    if (n == null) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs a delivery index n (per-booking idempotency key)' });
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) {
      return send(res, 400, { error: 'bad_request', detail: 'DRAW delivery index n must be a nonnegative uint32 integer' });
    }
    if (hasRequestNonce && !REQUEST_NONCE_RE.test(requestNonce)) {
      return send(res, 400, { error: 'bad_request', detail: 'DRAW needs requestNonce as 16 random bytes encoded as 0x-prefixed hex' });
    }
    const checked = validateRequest(request, config.model, { legacy: !hasRequestNonce });
    if (checked.error) return send(res, 400, { error: 'bad_request', detail: checked.error });

    return withBookingLock(bookingId, async () => {
      // Legacy SDKs paid for sha256(JSON.stringify(request)) and sent no nonce.
      // Keep those already-paid draws redeemable while current offers advertise
      // nonce-v1 so current SDKs can require the private commitment before paying.
      const requestHashScheme = hasRequestNonce ? 'nonce-v1' : 'legacy-v0';
      const requestHash = hasRequestNonce ? hash32({ request, requestNonce }) : hash32(request);
      // Prefix the commitment scheme so legacy and nonce-v1 entries cannot alias.
      // nonce-v1 binds the request to a buyer-held random nonce, preventing a chain
      // observer from guessing a common prompt and deriving its completion key.
      // Legacy redemption remains only to honor draws already paid by old SDKs.
      const cacheKey = `${requestHashScheme}:${bookingId}:${n}:${requestHash}`;
      const oldLegacyKey = hasRequestNonce ? null : `${bookingId}:${n}:${requestHash}`;

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
          // #580: refuse a payment older than the redemption window. The JSONL
          // payload cache is compacted by age (exclusive claim markers remain
          // fail-closed), and an honest retry is seconds-to-minutes old, never days.
          maxPaidAgeMs: served.retentionMs,
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
      let storedKey = cacheKey;
      let redemptionState = served.state(storedKey);
      // Preserve an upgrade's pre-scheme redemption log; missing this alias
      // would let a legacy paid draw run upstream again after relay upgrade.
      if (!redemptionState && oldLegacyKey) {
        const oldLegacyState = served.state(oldLegacyKey);
        if (oldLegacyState) {
          storedKey = oldLegacyKey;
          redemptionState = oldLegacyState;
        } else {
          // Checking the legacy marker may have refreshed a prefixed record
          // appended by another upgraded process.
          redemptionState = served.state(cacheKey);
        }
      }
      if (redemptionState === 'complete') return send(res, 200, served.get(storedKey));
      if (redemptionState === 'pending') {
        return send(res, 409, { error: 'draw_pending', detail: 'this paid draw was already claimed; refusing to run upstream again', _bookingId: bookingId });
      }
      const paidEvent = paid.event;
      const remainingUsd = Number(paid.event.sellerUsdAtomic || 0) / 1e6;
      if (remainingUsd < BALANCE_EPSILON) {
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
      const eventOutPriceUsd = Number(paidEvent.outputPricePerMTokAtomic || 0) / 1e6;
      const inPrice = Math.max(Number(config.inPrice) || 0, eventInPriceUsd);
      const outPrice = Math.max(Number(config.outPrice) || 0, eventOutPriceUsd);
      const bound = boundServe({ messages: checked.safeRequest.messages, budgetUsd: remainingUsd, inPrice, outPrice, reqMax: checked.safeRequest.max_tokens });
      if (bound.refuse) {
        const error = bound.reason === 'input' ? 'input_too_large' : 'output_unfunded';
        return send(res, 402, { error, detail: `estimated input (~${bound.estIn} tokens, $${bound.estInCostUsd.toFixed(6)}) leaves no safely funded output in the paid amount ($${remainingUsd})`, _bookingId: bookingId, remainingUsd });
      }
      const safeRequest = { ...checked.safeRequest, model: config.model, max_tokens: bound.maxTok };

      try {
        // Legacy uses its old unprefixed identity only for the atomic marker so
        // parallel upgraded stores and an existing log converge on one claim.
        if (!served.claim(cacheKey, oldLegacyKey ?? cacheKey)) {
          return send(res, 409, { error: 'draw_pending', detail: 'this paid draw was already claimed; refusing to run upstream again', _bookingId: bookingId });
        }
      } catch (e) {
        return send(res, 503, { error: 'redemption_unavailable', detail: `could not durably claim the paid draw: ${e.message}`, _bookingId: bookingId });
      }

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
      // verify => cap => claim => serve => complete, and the relay holds no platform
      // secret. remainingUsd echoes what is left of THIS draw's paid amount
      // after metering at the event's committed per-MTok prices.
      const usage = completion.usage ?? {};
      const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
      const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
      // price is atomic USD per MTok (1e6 tokens): usd = tokens * priceAtomic / 1e12
      const usedUsd = (inTok * Number(paidEvent.inputPricePerMTokAtomic || 0) + outTok * Number(paidEvent.outputPricePerMTokAtomic || 0)) / 1e12;
      const payload = { ...completion, _bookingId: bookingId, remainingUsd: Math.max(0, Math.round((remainingUsd - usedUsd) * 1e6) / 1e6) };
      try {
        served.complete(cacheKey, payload);
      } catch (e) {
        // The caller is already here and inference already ran: return its result.
        // The durable pending claim remains authoritative, so every replay fails
        // closed instead of spending upstream again.
        (config.log ?? console).error?.(`mtok-relay: completion for ${cacheKey} could not be persisted (${e.message}); retries will remain pending`);
      }
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
