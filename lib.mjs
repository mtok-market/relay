// packages/relay/lib.mjs, pure helpers for a chain-only direct-tier seller relay. The
// serve-money guards (estimateInputTokens, boundServe, enforceModelEcho, configuredFeeAtomic)
// moved into mtok-bridge's serve core (#603) so the node relay and the workers-ai house seller
// run ONE code path; they are re-exported here for back-compat. What remains below is pure,
// dependency-free, no I/O.

export {
  MESSAGE_OVERHEAD_TOKENS,
  estimateInputTokens,
  boundServe,
  enforceModelEcho,
  configuredFeeAtomic,
} from './bridge/serve-core.mjs';

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

// NOTE: the legacy report builders (buildFundReport / buildDrawReport / requiresFeeLeg)
// were removed with the chain-only collapse (#487): the platform deleted
// POST /api/chunks/report, so the reference relay reports NOTHING. A buyer pays per
// draw on-chain (MtokDripLedger) and the relay serves against the verified DrawPaid.
// The fee is checked on-chain against the event, via configuredFeeAtomic above.
