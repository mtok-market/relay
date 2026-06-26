// relay/lib.mjs — pure, dependency-free helpers for building a direct-tier seller relay.
// No I/O. No imports. Conforms to the mtok.market chunk-report contract.
// Use these to protect yourself before spending your inference key.

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

// NOTE: the legacy single-call buildReport (a combined FUND+DRAW in one report) was
// removed (#129). The platform now rejects a report that carries BOTH a FUND
// (sellerTxHash) and a DRAW (token counts) — a combined report had a retry hole.
// Build a FUND with buildFundReport, then a DRAW with buildDrawReport.

/**
 * FUND report (#129): an on-chain top-up of the booking balance. Carries the
 * verified-payment tx hashes; no tokens delivered. The platform re-verifies on-chain
 * and credits paidUsd by the verified amount.
 */
export const buildFundReport = ({ offerId, buyerId, bookingId, n, priceUsd, sellerTxHash, feeTxHash }) => ({
  offerId,
  buyerId,
  ...(bookingId ? { bookingId } : {}),
  n,
  priceUsd,
  sellerTxHash,
  feeTxHash,
});

/**
 * DRAW report (#129): a metered delivery against the standing balance. Carries the
 * actual usage; no new payment. The platform deducts usedUsd and rejects an over-draw.
 */
export const buildDrawReport = ({ offerId, buyerId, bookingId, n, usage }) => ({
  offerId,
  buyerId,
  bookingId,
  n,
  inputTokens: usage?.prompt_tokens ?? 0,
  outputTokens: usage?.completion_tokens ?? 0,
});
