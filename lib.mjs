// packages/relay/lib.mjs — pure, dependency-free helpers for a chain-only direct-tier
// seller relay. No I/O. No imports. Use these to protect yourself before spending your
// inference key: cap output to what the on-chain draw paid for, echo the real model,
// and check the committed platform fee against the verified DrawPaid event.

/**
 * Output-token budget a chunk's USD price pays for, given the offer's output price
 * per MTok. The buyer computes this (to cap what it pays for) and the seller can
 * recompute it identically (to know the cap it agreed to deliver). Pure — no I/O.
 */
export const paidBudgetTokensFor = ({ chunkUsd, outputPricePerMTok }) =>
  Math.floor((Number(chunkUsd) || 0) / (Number(outputPricePerMTok) || 1) * 1e6);

/**
 * Returns the safe max output tokens to request from your inference backend:
 * the minimum of what the buyer requested and what the chunk budget paid for.
 * Never generate more than the buyer paid for.
 */
export const capOutput = (requestedMax, paidBudgetTokens) =>
  Math.min(Number(requestedMax) || 0, Number(paidBudgetTokens) || 0);

/**
 * Throws if the upstream model doesn't match the offer model.
 * Protects against cheap-swap accusations: echo the real model you delivered.
 */
export function enforceModelEcho(upstreamModel, offerModel) {
  if (String(upstreamModel) !== String(offerModel))
    throw new Error(`model mismatch: upstream ${upstreamModel} != offer ${offerModel}`);
}

// NOTE: the legacy report builders (buildFundReport / buildDrawReport / requiresFeeLeg)
// were removed with the chain-only collapse (#487): the platform deleted
// POST /api/chunks/report, so the reference relay reports NOTHING. A buyer pays per
// draw on-chain (MtokDripLedger) and the relay serves against the verified DrawPaid.
// The fee is now checked on-chain against the event, via configuredFeeAtomic below.

export function configuredFeeAtomic({ sellerUsdAtomic, feeAddress, feeBps }) {
  const bps = BigInt(Math.trunc(Math.max(0, Number(feeBps) || 0)));
  if (!feeAddress || bps === 0n) return 0n;
  return (BigInt(sellerUsdAtomic || 0) * bps + 5000n) / 10000n;
}

// Estimate the input (prompt) token count from an OpenAI-style messages array.
// Lean ~25% HIGH (3.2 chars/token vs the ~4 English avg) so the seller is
// protected against under-counting the input leg. Pure, no I/O.
export const CHARS_PER_TOKEN_EST = 3.2;
export function estimateInputTokens(messages) {
  let chars = 0;
  for (const m of messages ?? []) {
    const c = m?.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) for (const part of c) chars += String(part?.text ?? '').length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_EST);
}

// Bound a serve against the paid budget in BOTH legs (#495/#460). The relay used
// to cap only OUTPUT, so a dust draw + a huge prompt got its output capped but the
// whole prompt forwarded, making the seller eat unbounded upstream INPUT compute.
// Estimate the input cost and REFUSE before any upstream call if it alone meets or
// exceeds the payment; otherwise cap output over the budget LEFT after input. inPrice
// and outPrice are USD per MTok. The estimate gates the refuse ONLY; real billing
// still meters the upstream's reported token counts, so this never over-charges.
export function boundServe({ messages, budgetUsd, inPrice, outPrice, reqMax, contextCeil = 4096 }) {
  const estIn = estimateInputTokens(messages);
  const estInCostUsd = estIn * (Number(inPrice) > 0 ? Number(inPrice) : 0) / 1e6;
  if (estInCostUsd >= budgetUsd) return { refuse: true, estIn, estInCostUsd };
  const outBudgetUsd = budgetUsd - estInCostUsd;
  let maxTok = contextCeil;
  if (Number(reqMax) > 0) maxTok = Math.min(maxTok, Math.floor(Number(reqMax)));
  if (Number(outPrice) > 0) maxTok = Math.min(maxTok, Math.floor(outBudgetUsd / Number(outPrice) * 1e6));
  return { refuse: false, maxTok: Math.max(1, maxTok), estIn, estInCostUsd };
}
