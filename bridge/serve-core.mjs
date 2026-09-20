// mtok-bridge serve core (#603): the PAID-serve state machine shared by every mtok seller host.
// validate request => verify DrawPaid (request-hash bound) => screen payer => bound both legs =>
// claim => upstream => complete, with the exact fail-closed semantics hardened in #597: a
// post-claim failure leaves the draw durably pending (409 terminal on retry), so one payment can
// never buy a second upstream spend. Host-agnostic and dependency-free (web crypto only): the
// node relay composes it with its fs redemption store; the workers-ai house seller composes the
// same core with a KV-backed store. The http shell, booking locks, platform config fetch, and
// payer-screen POLICY stay in the host.
//
// The redemption dependency is an INTERFACE the caller passes:
//   { state(key, { claimKey }), get(key, { claimKey }), claim(key, markerKey, { paidAtMs }), complete(key, payload), retentionMs }
// state(key) returns 'pending' | 'complete' | null. claim(key, markerKey) returns false when the
// draw is already claimed and THROWS when it cannot claim durably (the core then refuses before
// upstream spend). complete(key, payload) throws when the payload cannot be persisted; the claim
// then stays pending on purpose so every replay fails closed instead of spending upstream again.

const BALANCE_EPSILON = 1e-6;
const REQUEST_NONCE_RE = /^0x[0-9a-fA-F]{32}$/;
const CHAT_ROLES = new Set(['developer', 'system', 'user', 'assistant']);
const REQUEST_KEYS = new Set(['model', 'messages', 'max_tokens', 'temperature', 'response_format', 'stream', 'n']);

// sha256 over the request commitment, via web crypto so the identical bytes come out on node
// (>=20 has globalThis.crypto) and on workers. Same output as node's createHash('sha256').
async function hash32(v) {
  const bytes = new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v ?? null));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return '0x' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

/**
 * Normalize a model id for comparison: lowercase, drop any provider namespace
 * (everything through the last '/', e.g. `@cf/meta/`), and strip a leading '@'.
 * `@cf/meta/llama-3.1-8b-instruct-fp8` and `llama-3.1-8b-instruct-fp8` normalize
 * to the same stem.
 */
export function normalizeModelId(m) {
  return String(m ?? '').toLowerCase().split('/').pop().replace(/^@/, '');
}

/**
 * True when the upstream's echoed model is a legitimate variant of the offer
 * model. Legitimate variance is ONLY a resolved version/snapshot SUFFIX appended
 * to the same base (`gpt-4o` -> `gpt-4o-2024-08-06`, `gpt-4` -> `gpt-4-0613`): the
 * extra segment starts with a DIGIT. A raw prefix match is NOT enough -- model
 * families share alphabetic prefixes (`gpt-4` is a prefix of the CHEAPER
 * `gpt-4o-mini`; `claude-3` of `claude-3-haiku`), so accepting any prefix would
 * pass a cheap-swap. Require the appended segment to be version-like (digit-led),
 * which distinguishes a snapshot date/version from a different model qualifier
 * (mini, haiku, turbo, fp8, instruct).
 */
export function modelsCompatible(upstreamModel, offerModel) {
  const a = normalizeModelId(upstreamModel);
  const b = normalizeModelId(offerModel);
  if (!a || !b) return false;
  if (a === b) return true;
  // The longer must equal the shorter + a version/snapshot suffix made ONLY of
  // digit groups separated by -/./_ (a date like -2024-08-06, a build like -0613,
  // a point version like .1). Any alphabetic segment in the suffix means a
  // different model qualifier (mini, haiku, turbo, instruct, fp8), so e.g.
  // gpt-4.1-mini vs gpt-4 and claude-3.5-haiku vs claude-3 are rejected while a
  // real snapshot passes.
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  if (!longer.startsWith(shorter)) return false;
  const rest = longer.slice(shorter.length);
  return /^([-._]\d+)+$/.test(rest);
}

/**
 * Throws if the upstream model is NOT a legitimate variant of the offer model.
 * #651: the old check was an exact string compare, which false-refused honest
 * sellers whose OpenAI-compatible provider echoes a snapshot id or a namespace-
 * stripped name (the buyer's own accept-check is exact too, so the seller then
 * normalizes the delivered model to the offer id below). A real cheap-swap to a
 * different model family still fails this tolerant relation.
 */
export function enforceModelEcho(upstreamModel, offerModel) {
  if (!modelsCompatible(upstreamModel, offerModel))
    throw new Error(`model mismatch: upstream ${upstreamModel} != offer ${offerModel}`);
}

export function configuredFeeAtomic({ sellerUsdAtomic, feeAddress, feeBps }) {
  const bps = BigInt(Math.trunc(Math.max(0, Number(feeBps) || 0)));
  if (!feeAddress || bps === 0n) return 0n;
  return (BigInt(sellerUsdAtomic || 0) * bps + 5000n) / 10000n;
}

// Legacy buyer estimate. It is not an upper bound and must never authorize
// inference: digit-dense prompts can consume more than three times this count.
export const MESSAGE_OVERHEAD_TOKENS = 4;
export const BYTES_PER_TOKEN_EST = 3.2;
export function estimateInputTokens(messages) {
  const utf8 = new TextEncoder();
  let bytes = 0;
  let envelope = 3; // reply priming
  for (const m of messages ?? []) {
    envelope += MESSAGE_OVERHEAD_TOKENS;
    bytes += utf8.encode(String(m?.role ?? '')).length;
    bytes += utf8.encode(typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? null)).length;
  }
  return envelope + Math.ceil(bytes / BYTES_PER_TOKEN_EST);
}

// Reserve the counted input before output. Prices are atomic USD per million
// tokens; keeping that denominator until division avoids rounding a fractional
// input charge away or spending one atomic unit twice. Billing still uses usage.
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768;
export const DEFAULT_MAX_INPUT_TOKENS = 131072;
function withinInputLimit(inputTokens, inputCeil) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new TypeError('input token count must be a nonnegative safe integer');
  if (!Number.isSafeInteger(inputCeil) || inputCeil <= 0) throw new TypeError('input token ceiling must be a positive safe integer');
  return inputTokens <= inputCeil;
}
const offerPriceAtomic = value => BigInt(Math.ceil(Number(value) * 1e6));

export function boundServe({ inputTokens, budgetUsdAtomic, inPriceAtomic, outPriceAtomic, reqMax, inputCeil = DEFAULT_MAX_INPUT_TOKENS, contextCeil = DEFAULT_MAX_OUTPUT_TOKENS }) {
  const inputAllowed = withinInputLimit(inputTokens, inputCeil);
  if (!Number.isSafeInteger(contextCeil) || contextCeil <= 0) throw new TypeError('output token ceiling must be a positive safe integer');
  const budget = BigInt(budgetUsdAtomic);
  const inputPrice = BigInt(inPriceAtomic);
  const outputPrice = BigInt(outPriceAtomic);
  if (budget < 0n || inputPrice < 0n || outputPrice < 0n) throw new RangeError('token budget and prices must be nonnegative');
  const inputCost = BigInt(inputTokens) * inputPrice;
  const details = { inputTokens, inputCostUsd: Number(inputCost) / 1e12 };
  if (!inputAllowed) return { refuse: true, reason: 'input_limit', ...details };
  const outputBudget = budget * 1_000_000n - inputCost;
  if (outputBudget <= 0n) return { refuse: true, reason: 'input', ...details };
  if (outputPrice === 0n) return { refuse: true, reason: 'output_price', ...details };
  let maxTok = contextCeil;
  if (Number(reqMax) > 0) maxTok = Math.min(maxTok, Math.floor(Number(reqMax)));
  const fundedOutput = outputBudget / outputPrice;
  if (fundedOutput < BigInt(maxTok)) maxTok = Number(fundedOutput);
  if (maxTok < 1) return { refuse: true, reason: 'output', ...details };
  return { refuse: false, maxTok, ...details };
}

// The core factory. `verifier` is an mtok-verify createOnchainVerifier instance (or anything
// with the same verifyDrawPaid contract); `redemption` is the store interface documented at the
// top; `upstream(payload)` returns an OpenAI-shaped completion or throws (httpUpstream /
// workersAiUpstream from bridge.mjs both satisfy it); `screenPayer(payerLower)` is an optional
// async predicate the host composes (denylist, hook), truthy = refuse, throw = refuse (fail
// closed). serve(body) returns { status, body } for the host to serialize; the host owns
// per-booking serialization (locks) around it.
export function createServeCore({
  model, inPrice, outPrice,
  verifier, redemption, upstream, log,
  offerId, sellerAgentId, sellerWallet,
  dripContractAddress, feeRecipient, feeBps,
  screenPayer,
  // A retired payment domain may honor verified receipts without admitting
  // quotes or another inference attempt for an unrecorded payment.
  replayOnly = false,
  // The host counts its actual sanitized provider input. Missing or failed
  // accounting refuses a fresh claim; saved completions do not need recounting.
  countInputTokens,
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
  // #654: the output-token sanity ceiling for boundServe. The PAID budget already
  // bounds output (and metering is on real usage), so this is a defensive cap on a
  // single generation, not a money guard. It is a per-relay knob: the reference host
  // passes MTOK_MAX_OUTPUT_TOKENS / a config value; operators serving large-context
  // models raise it. Falls back to boundServe's own generous default when unset.
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}) {
  const quote = async (request) => {
    if (replayOnly) return { status: 503, body: { error: 'redemption_unavailable', detail: 'this relay only replays saved completions' } };
    const checked = validateRequest(request, model);
    if (checked.error) return { status: 400, body: { error: 'bad_request', detail: checked.error } };
    try {
      const inputTokens = await countInputTokens(checked.safeRequest);
      if (!withinInputLimit(inputTokens, maxInputTokens)) return { status: 413, body: { error: 'input_too_large', detail: `input (${inputTokens} tokens) exceeds this relay's input-token limit` } };
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new TypeError('output token ceiling must be a positive safe integer');
      const inputPrice = offerPriceAtomic(inPrice);
      const outputPrice = offerPriceAtomic(outPrice);
      if (inputPrice < 0n || outputPrice <= 0n) throw new RangeError('invalid offer prices');
      return { status: 200, body: {
        model, offerId, inputTokens, maxInputTokens, maxOutputTokens,
        inputPricePerMTokAtomic: inputPrice.toString(),
        outputPricePerMTokAtomic: outputPrice.toString(),
      } };
    } catch (e) {
      return { status: 503, body: { error: 'input_accounting_unavailable', detail: e.message } };
    }
  };

  const serve = async (body) => {
    const currentFeeRecipient = typeof feeRecipient === 'function' ? feeRecipient() : feeRecipient;
    const { bookingId, n, buyerId, request, requestNonce, drawPaidTxHash } = body;
    const hasRequestNonce = Object.hasOwn(body, 'requestNonce');
    if (!bookingId) return { status: 400, body: { error: 'bad_request', detail: 'DRAW needs bookingId' } };
    if (n == null) return { status: 400, body: { error: 'bad_request', detail: 'DRAW needs a delivery index n (per-booking idempotency key)' } };
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) {
      return { status: 400, body: { error: 'bad_request', detail: 'DRAW delivery index n must be a nonnegative uint32 integer' } };
    }
    if (hasRequestNonce && !REQUEST_NONCE_RE.test(requestNonce)) {
      return { status: 400, body: { error: 'bad_request', detail: 'DRAW needs requestNonce as 16 random bytes encoded as 0x-prefixed hex' } };
    }
    const checked = validateRequest(request, model, { legacy: !hasRequestNonce });
    if (checked.error) return { status: 400, body: { error: 'bad_request', detail: checked.error } };

    // Legacy SDKs paid for sha256(JSON.stringify(request)) and sent no nonce.
    // Keep those already-paid draws redeemable while current offers advertise
    // nonce-v1 so current SDKs can require the private commitment before paying.
    const requestHashScheme = hasRequestNonce ? 'nonce-v1' : 'legacy-v0';
    const requestHash = hasRequestNonce ? await hash32({ request, requestNonce }) : await hash32(request);
    // Prefix the commitment scheme so legacy and nonce-v1 entries cannot alias.
    // nonce-v1 binds the request to a buyer-held random nonce, preventing a chain
    // observer from guessing a common prompt and deriving its completion key.
    // Legacy redemption remains only to honor draws already paid by old SDKs.
    const cacheKey = `${requestHashScheme}:${bookingId}:${n}:${requestHash}`;
    const oldLegacyKey = hasRequestNonce ? null : `${bookingId}:${n}:${requestHash}`;
    const redemptionContext = { claimKey: cacheKey };

    // Contract mode is the ONLY mode (#487): the legacy direct-transfer FUND
    // lane and its /api/bookings/:id balance read are gone. If the platform is
    // not running the drip contract, REFUSE the draw with a clear error rather
    // than fall back to a lane that no longer exists.
    if (!dripContractAddress) {
      return { status: 402, body: { error: 'contract_mode_required', detail: 'this relay only serves contract-mode draws; the platform is not reporting a dripContractAddress' } };
    }
    if (!drawPaidTxHash) return { status: 402, body: { error: 'draw_payment_required', detail: 'contract mode requires drawPaidTxHash before upstream delivery' } };
    let storedKey = cacheKey;
    // The redemption interface may be sync (fs store) or async (a Workers KV
    // store): await normalizes both, and identity-awaits cost nothing under the
    // host's per-booking lock.
    let redemptionState = await redemption.state(storedKey, redemptionContext);
    // Preserve an upgrade's pre-scheme redemption log; missing this alias
    // would let a legacy paid draw run upstream again after relay upgrade.
    if (!redemptionState && oldLegacyKey) {
      const oldLegacyState = await redemption.state(oldLegacyKey, redemptionContext);
      if (oldLegacyState) {
        storedKey = oldLegacyKey;
        redemptionState = oldLegacyState;
      } else {
        // Checking the legacy marker may have refreshed a prefixed record
        // appended by another upgraded process.
        redemptionState = await redemption.state(cacheKey, redemptionContext);
      }
    }
    let paid;
    try {
      paid = await verifier.verifyDrawPaid(drawPaidTxHash, {
        contractAddress: dripContractAddress,
        buyerAgentId: buyerId,
        sellerAgentId, // when set, enforces the offer-owner match (#codex review)
        bookingId,
        offerId,
        model,
        n,
        requestHash,
        sellerWallet,
        feeRecipient: currentFeeRecipient,
        // A known claim spends no new inference. New claims need a verified
        // age because both payload and claim markers expire after retention.
        maxPaidAgeMs: redemptionState === 'complete' || redemptionState === 'pending' ? undefined : redemption.retentionMs,
      });
    } catch (e) {
      if (e.name === 'TimeoutError') return { status: 503, body: { error: 'relay_timeout', _bookingId: bookingId } };
      return { status: 402, body: { error: 'payment_unverified', detail: e.message } };
    }
    if (paid?.reason === 'payment_age_unavailable') return { status: 503, body: { error: 'payment_age_unavailable', detail: 'payment age could not be verified; retry this same paid draw', _bookingId: bookingId } };
    if (!paid?.ok) return { status: 402, body: { error: 'payment_unverified', detail: paid?.reason || 'unknown' } };
    // Screen the verified payer before spending upstream capacity. The
    // payment already settled on-chain (that money is the buyer's loss);
    // this refuses the SERVICE, which is the only refusal an edge can
    // still make in contract mode.
    if (screenPayer) {
      try {
        if (await screenPayer(String(paid.from || '').toLowerCase())) {
          return { status: 403, body: { error: 'payer_denied', detail: 'the verified payer wallet is denylisted by this relay' } };
        }
      } catch (e) {
        // A broken screen hook fails CLOSED: do not serve on an unscreenable payer.
        return { status: 403, body: { error: 'payer_denied', detail: 'payer screening failed: ' + e.message } };
      }
    }
    if (redemptionState === 'complete') {
      const payload = await redemption.get(storedKey, redemptionContext);
      if (payload == null) return { status: 503, body: { error: 'redemption_unavailable', detail: 'saved completion is no longer readable; retry this same paid draw', _bookingId: bookingId } };
      return { status: 200, body: payload };
    }
    if (redemptionState === 'pending') {
      return { status: 409, body: { error: 'draw_pending', detail: 'this paid draw was already claimed; refusing to run upstream again', _bookingId: bookingId } };
    }
    if (replayOnly) {
      return { status: 503, body: { error: 'redemption_unavailable', detail: 'this payment has no saved completion; retry this same paid draw after reconciliation', _bookingId: bookingId } };
    }
    // Completed/pending claims already crossed the fee gate and cannot spend
    // again. New claims use the policy at the verified payment time.
    let currentFeeBps;
    try {
      currentFeeBps = typeof feeBps === 'function' ? await feeBps(paid) : feeBps ?? 0;
      if (!Number.isSafeInteger(currentFeeBps) || currentFeeBps < 0 || currentFeeBps > 10_000) throw new TypeError('invalid fee rate');
    } catch {
      return { status: 503, body: { error: 'fee_policy_unavailable', detail: 'fee policy could not be verified; retry this same paid draw', _bookingId: bookingId } };
    }
    const expectedFee = configuredFeeAtomic({ sellerUsdAtomic: paid.event.sellerUsdAtomic, feeAddress: currentFeeRecipient, feeBps: currentFeeBps });
    if (BigInt(paid.event.feeUsdAtomic || 0) < expectedFee) {
      return { status: 402, body: { error: 'payment_unverified', detail: 'fee_amount_too_low' } };
    }
    const paidEvent = paid.event;
    const remainingUsd = Number(paid.event.sellerUsdAtomic || 0) / 1e6;
    if (remainingUsd < BALANCE_EPSILON) {
      return { status: 402, body: { error: 'balance_exhausted', detail: `remainingUsd=${remainingUsd}`, _bookingId: bookingId, remainingUsd } };
    }

    let bound;
    try {
      const inputTokens = await countInputTokens(checked.safeRequest);
      const price = (offered, committed) => {
        const local = offerPriceAtomic(offered);
        const paid = BigInt(committed);
        return local > paid ? local : paid;
      };
      bound = boundServe({
        inputTokens,
        budgetUsdAtomic: paidEvent.sellerUsdAtomic,
        inPriceAtomic: price(inPrice, paidEvent.inputPricePerMTokAtomic),
        outPriceAtomic: price(outPrice, paidEvent.outputPricePerMTokAtomic),
        reqMax: checked.safeRequest.max_tokens,
        inputCeil: maxInputTokens,
        contextCeil: maxOutputTokens,
      });
    } catch (e) {
      return { status: 503, body: { error: 'input_accounting_unavailable', detail: e.message, _bookingId: bookingId } };
    }
    if (bound.refuse) {
      const error = bound.reason === 'input' || bound.reason === 'input_limit' ? 'input_too_large' : 'output_unfunded';
      const detail = bound.reason === 'input_limit'
        ? `input (${bound.inputTokens} tokens) exceeds this relay's input-token limit`
        : `input (${bound.inputTokens} tokens, $${bound.inputCostUsd.toFixed(6)}) leaves no safely funded output in the paid amount ($${remainingUsd})`;
      return { status: 402, body: { error, detail, _bookingId: bookingId, remainingUsd } };
    }
    const safeRequest = { ...checked.safeRequest, model, max_tokens: bound.maxTok };

    try {
      // Legacy uses its old unprefixed identity only for the atomic marker so
      // parallel upgraded stores and an existing log converge on one claim.
      if (!(await redemption.claim(cacheKey, oldLegacyKey ?? cacheKey, { paidAtMs: paid.paidAtMs }))) {
        return { status: 409, body: { error: 'draw_pending', detail: 'this paid draw was already claimed; refusing to run upstream again', _bookingId: bookingId } };
      }
    } catch (e) {
      return { status: 503, body: { error: 'redemption_unavailable', detail: `could not durably claim the paid draw: ${e.message}`, _bookingId: bookingId } };
    }

    let completion;
    try {
      completion = await upstream(safeRequest);
    } catch (e) {
      if (e.name === 'TimeoutError') return { status: 503, body: { error: 'relay_timeout', _bookingId: bookingId } };
      return { status: 502, body: { error: 'upstream_error', detail: e.message } };
    }

    try { enforceModelEcho(completion.model, model); }
    catch (e) { return { status: 502, body: { error: 'model_mismatch', detail: e.message } }; }
    // #651: the upstream model passed the tolerant variant check; echo the OFFER
    // model id in the delivered completion. The buyer's accept-check is an exact
    // completion.model === offer.model compare, so a legitimate snapshot/namespace
    // variant must be normalized to the offer id or an honest paid draw is disputed.
    if (completion && typeof completion === 'object') completion.model = model;

    // ── Contract mode is REPORT-FREE (chain-native phase 2 stage 3, #387) ──
    // The verified DrawPaid event IS the record: the platform indexes the
    // draw from MtokDripLedger logs, so there is nothing to report (the
    // platform deleted POST /api/chunks/report in #487). The flow is
    // verify => cap => claim => serve => complete, and the seller holds no platform
    // secret. remainingUsd echoes what is left of THIS draw's paid amount
    // after metering at the event's committed per-MTok prices.
    const usage = completion.usage ?? {};
    const inTok = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    // price is atomic USD per MTok (1e6 tokens): usd = tokens * priceAtomic / 1e12
    const usedUsd = (inTok * Number(paidEvent.inputPricePerMTokAtomic || 0) + outTok * Number(paidEvent.outputPricePerMTokAtomic || 0)) / 1e12;
    const payload = { ...completion, _bookingId: bookingId, remainingUsd: Math.max(0, Math.round((remainingUsd - usedUsd) * 1e6) / 1e6) };
    try {
      await redemption.complete(cacheKey, payload);
    } catch (e) {
      // The caller is already here and inference already ran: return its result.
      // The durable pending claim remains authoritative, so every replay fails
      // closed instead of spending upstream again.
      (log ?? console).error?.(`mtok serve core: completion for ${cacheKey} could not be persisted (${e.message}); retries will remain pending`);
    }
    return { status: 200, body: payload };
  };

  return { serve, quote };
}
