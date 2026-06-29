#!/usr/bin/env node
// REFERENCE relay. You do NOT need this — any passthrough conforming to the contract
// in `sellingGuide().notes.directTierProtocol` works.
//
// Settlement model (#114, buyer-submits): the BUYER signs AND submits each chunk's
// on-chain payment (EIP-3009 transferWithAuthorization from their wallet) and sends us
// the CONFIRMED txHashes. This relay only VERIFIES those tx hashes on-chain (read-only)
// before spending its inference key — it NEVER submits anything and holds no spending
// authority over the seller's wallet. It reads RELAY_WALLET_KEY only to derive the
// seller's own settlement address (the `to` the seller leg must land in).
//
// Required env vars:
//   MTOK_API_KEY      — your seller API key (used to auth the chunk report)
//   UPSTREAM_KEY      — your inference provider API key (passed as Bearer to upstream)
//   RELAY_WALLET_KEY  — your seller wallet's EVM private key (0x…); used ONLY to derive
//                       your settlement address. The relay never spends it.
//                       (Alternatively pass --settlement-pubkey <0x…> to skip the key.)
//
// Usage:
//   npx mtok-relay --offer <offerId> --model <id> --upstream <url> [--api <base>] [--port <n>] [--rpc <url>] [--settlement-pubkey <0x…>]
//   e.g.: npx mtok-relay --offer abc123 --model llama-3.3-70b --upstream https://api.openai.com --port 8788
//
// All secrets are read from env, never argv.

import http from 'node:http';
import { enforceModelEcho, buildFundReport, buildDrawReport } from './lib.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { createOnchainVerifier, usdToAtomic } from './core/onchain.js';

const CONTEXT_CEIL = 4096;   // context-safe upper bound on output tokens
const BALANCE_EPSILON = 1e-6; // a balance at/under a millionth of a dollar is exhausted
// #314: per-(bookingId, n) completion cache. n is the buyer's idempotency key; a repeat MUST return
// the SAME completion (retry semantics), never a fresh inference -- else a buyer reusing an n meters
// once on the platform but gets served a new inference each call (unbounded free draws).
const served = new Map();
const SERVED_CAP = 50000; // FIFO bound so a long-lived relay's cache can't grow unbounded

// ---- parse flags ----
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };

const offerId          = flag('--offer');
const MODEL            = flag('--model');
const upstream         = (flag('--upstream') ?? '').replace(/\/$/, '');
const apiBase          = (flag('--api') ?? 'https://mtok.market').replace(/\/$/, '');
const port             = Number(flag('--port') ?? 8788);
const rpcFlag          = flag('--rpc');
const settlementPubkeyFlag = flag('--settlement-pubkey');
// The offer's output price (USD/MTok), used ONLY to cap a DRAW's output tokens to
// what the remaining balance funds (the booking read does not echo the offer price).
const outPrice         = Number(flag('--out-price') ?? 0);

if (!offerId)   { console.error('mtok-relay: --offer <id> is required'); process.exit(1); }
if (!MODEL)     { console.error('mtok-relay: --model <id> is required (the offer model you serve)'); process.exit(1); }
if (!upstream)  { console.error('mtok-relay: --upstream <url> is required'); process.exit(1); }

// ---- secrets from env, never argv ----
const MTOK_API_KEY     = process.env.MTOK_API_KEY;
const UPSTREAM_KEY     = process.env.UPSTREAM_KEY;
const RELAY_WALLET_KEY = process.env.RELAY_WALLET_KEY;

if (!MTOK_API_KEY)     { console.error('mtok-relay: MTOK_API_KEY env var is required'); process.exit(1); }
if (!UPSTREAM_KEY)     { console.error('mtok-relay: UPSTREAM_KEY env var is required'); process.exit(1); }
if (!RELAY_WALLET_KEY && !settlementPubkeyFlag) {
  console.error('mtok-relay: RELAY_WALLET_KEY env var (or --settlement-pubkey) is required');
  process.exit(1);
}

// ---- settlement address: derive from the seller key, or accept it directly ----
let SETTLEMENT_ADDR;
if (settlementPubkeyFlag) {
  SETTLEMENT_ADDR = settlementPubkeyFlag;
} else {
  try {
    SETTLEMENT_ADDR = privateKeyToAccount(RELAY_WALLET_KEY.startsWith('0x') ? RELAY_WALLET_KEY : '0x' + RELAY_WALLET_KEY).address;
  } catch (e) {
    console.error('mtok-relay: invalid RELAY_WALLET_KEY —', e.message);
    process.exit(1);
  }
}

// ---- helpers ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

// ---- boot: fetch platform config + build the read-only on-chain verifier ----
let feeAddress, feeBps, verifier;
async function boot() {
  const r = await fetch(apiBase + '/api/config');
  if (!r.ok) throw new Error('config fetch failed: ' + r.status);
  const config = await r.json();
  feeAddress = config.feeAddress;
  feeBps = config.feeBps;
  const chainId = Number(config.chainId ?? 8453);
  // Mirror the SDK's default RPC list per chain; --rpc overrides.
  const rpcUrls = rpcFlag ? [rpcFlag] : chainId === 8453
    ? ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']
    : ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'];
  verifier = createOnchainVerifier({ rpcUrls, usdcAddress: config.usdcAddress });
  if (!verifier.configured) throw new Error('onchain verifier not configured (missing usdcAddress in /api/config)');
}

// POST a report to the platform (authed by our api key). Returns the booking
// projection ({ id, paidUsd, usedUsd, remainingUsd, ... }) on success.
async function reportToPlatform(reportBody) {
  const rr = await fetch(apiBase + '/api/chunks/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': MTOK_API_KEY },
    body: JSON.stringify(reportBody),
  });
  const body = await rr.json().catch(() => ({}));
  return { ok: rr.status === 201, status: rr.status, body, booking: body?.booking ?? null };
}

// ── FUND: verify the on-chain top-up, report it, return the booking balance ──
async function handleFund(body, res) {
  const { bookingId, n, sellerTxHash, feeTxHash, priceUsd, buyerId } = body;

  // Fail-closed — VERIFY both on-chain payment legs (read-only) before crediting.
  try {
    const sellerOk = (await verifier.verifyTransfer(sellerTxHash, { to: SETTLEMENT_ADDR, minAtomic: usdToAtomic(priceUsd) })).ok;
    const feeAtomic = usdToAtomic((Number(priceUsd) || 0) * (Number(feeBps) || 0) / 10000);
    const feeOk = (await verifier.verifyTransfer(feeTxHash, { to: feeAddress, minAtomic: feeAtomic })).ok;
    if (!sellerOk || !feeOk) return send(res, 402, { error: 'payment_unverified', detail: `seller=${sellerOk} fee=${feeOk}` });
  } catch (e) {
    return send(res, 402, { error: 'payment_unverified', detail: e.message });
  }

  // Report the FUND to the platform (it re-verifies on-chain and credits paidUsd).
  let rep;
  try {
    rep = await reportToPlatform(buildFundReport({ offerId, buyerId, bookingId, n, priceUsd, sellerTxHash, feeTxHash }));
  } catch (e) {
    return send(res, 502, { error: 'report_failed', detail: e.message });
  }
  if (!rep.ok || !rep.booking) {
    console.error('mtok-relay: FUND report rejected (%d) for n=%d offerId=%s: %s', rep.status, n, offerId, JSON.stringify(rep.body));
    return send(res, 502, { error: 'report_failed', detail: rep.body?.error || rep.status });
  }

  // Return the booking balance. No inference on a FUND.
  return send(res, 200, { ...rep.booking, _bookingId: rep.booking.id, remainingUsd: rep.booking.remainingUsd });
}

// ── DRAW: spend against the standing balance, meter actual usage ─────────────
async function handleDraw(body, res) {
  const { bookingId, n, buyerId, request } = body;
  if (!bookingId) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs bookingId' });
  // #289: the platform requires a per-booking delivery index `n` (idempotency key) and
  // rejects a DRAW without it. Fail fast HERE — before spending a real upstream call —
  // so a client that omits n doesn't cost the seller an unmetered, unpaid inference.
  if (n == null) return send(res, 400, { error: 'bad_request', detail: 'DRAW needs a delivery index n (per-booking idempotency key)' });

  // #314: idempotency. If we already served this (bookingId, n), return the SAME completion -- do
  // NOT call upstream again. Correct for a genuine retry, AND it closes the abuse where a buyer
  // reuses an n with a NEW prompt: the platform meters a reused n only once (idempotent return),
  // so without this we would serve unlimited fresh inferences for one charge. n is the buyer's
  // idempotency key; a fresh delivery needs a fresh n.
  const cacheKey = `${bookingId}:${n}`;
  if (served.has(cacheKey)) return send(res, 200, served.get(cacheKey));

  // Step 1: read the booking balance; refuse to spend inference if exhausted (402).
  let booking;
  try {
    const r = await fetch(apiBase + `/api/bookings/${encodeURIComponent(bookingId)}`, { headers: { 'x-api-key': MTOK_API_KEY } });
    const rb = await r.json().catch(() => ({}));
    if (r.status !== 200 || !rb?.booking) return send(res, 502, { error: 'booking_read_failed', detail: rb?.error || r.status });
    booking = rb.booking;
  } catch (e) {
    return send(res, 502, { error: 'booking_read_failed', detail: e.message });
  }
  const remainingUsd = Number(booking.remainingUsd) || 0;
  if (remainingUsd <= BALANCE_EPSILON) {
    return send(res, 402, { error: 'balance_exhausted', detail: `remainingUsd=${remainingUsd}`, _bookingId: bookingId, remainingUsd });
  }

  // Step 2: cap output to min(requested, balance-worth-of-tokens, context ceiling).
  let maxTok = CONTEXT_CEIL;
  const reqMax = Number(request?.max_tokens);
  if (reqMax > 0) maxTok = Math.min(maxTok, Math.floor(reqMax));
  if (outPrice > 0) maxTok = Math.min(maxTok, Math.floor(remainingUsd / outPrice * 1e6));
  const safeRequest = { ...request, max_tokens: Math.max(1, maxTok) };

  // Step 3: call upstream.
  let completion;
  try {
    const upstreamRes = await fetch(upstream + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + UPSTREAM_KEY },
      body: JSON.stringify(safeRequest),
    });
    completion = await upstreamRes.json();
  } catch (e) {
    return send(res, 502, { error: 'upstream_error', detail: e.message });
  }

  // Step 4: enforce model echo (cheap-swap defense).
  try { enforceModelEcho(completion.model, MODEL); }
  catch (e) { return send(res, 502, { error: 'model_mismatch', detail: e.message }); }

  // Step 5: report the DRAW (meter actual usage; platform deducts usedUsd).
  let rep;
  try {
    rep = await reportToPlatform(buildDrawReport({ offerId, buyerId, bookingId, n, usage: completion.usage }));
  } catch (e) {
    console.error('mtok-relay: DRAW report failed (network) for n=%d offerId=%s: %s', n, offerId, e.message);
    return send(res, 502, { error: 'report_failed', detail: e.message, completion });
  }
  if (!rep.ok || !rep.booking) {
    console.error('mtok-relay: DRAW report rejected (%d) for n=%d offerId=%s: %s', rep.status, n, offerId, JSON.stringify(rep.body));
    return send(res, rep.status === 402 ? 402 : 502, { error: rep.body?.error?.code || rep.body?.error || 'report_failed', detail: rep.body?.error?.message || rep.status, completion, _bookingId: bookingId });
  }

  // Step 6: cache by (bookingId, n) for idempotency, then return the completion + balance.
  const payload = { ...completion, _bookingId: rep.booking.id, remainingUsd: rep.booking.remainingUsd };
  served.set(cacheKey, payload);
  if (served.size > SERVED_CAP) served.delete(served.keys().next().value); // FIFO bound
  return send(res, 200, payload);
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/chunk') {
    return send(res, 404, { error: 'not found' });
  }

  let body;
  try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad body' }); }

  // Discriminate the two intents by whether an on-chain payment is attached.
  const hasFund = body.sellerTxHash != null && body.sellerTxHash !== '';
  const hasDraw = body.request != null;
  if (hasFund && hasDraw) return send(res, 400, { error: 'bad_request', detail: 'send a FUND (sellerTxHash) or a DRAW (request), not both' });
  if (hasFund) return handleFund(body, res);
  if (hasDraw) return handleDraw(body, res);
  return send(res, 400, { error: 'bad_request', detail: 'need a FUND (sellerTxHash) or a DRAW (request)' });
});

boot().then(() => {
  server.listen(port, () => {
    console.log(`mtok-relay: listening on port ${port}  offer=${offerId}  model=${MODEL}  upstream=${upstream}  api=${apiBase}  settlement=${SETTLEMENT_ADDR}`);
  });
}).catch((e) => {
  console.error('mtok-relay: boot failed —', e.message);
  process.exit(1);
});
