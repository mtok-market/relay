// On-chain payment verifier for non-custodial settlement. Given a buyer-supplied
// transaction hash, confirm — by reading the chain over plain JSON-RPC (no SDK,
// so core stays dependency-free + node --test testable with a mocked fetch) —
// that a USDC transfer of at least the owed amount landed in the right wallet.
// The platform never touches the money; it only OBSERVES that it moved, then
// records the chunk. Used by the seller-hosted chunk path (chunks.js) behind
// live config; in the sandbox the provider stub-accepts instead.
//
// The buyer submits the payment (a plain USDC transfer, or an EIP-3009
// transferWithAuthorization they sign + submit) — either way it emits a USDC
// Transfer event, which verifyTransfer confirms. The platform observes the
// result; it never submits the payment, so there is no platform-side
// authorization/escrow verification here.
import { apiError } from './errors.js';

// keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const DRAW_PAID_TOPIC = '0xb0243f80521d0dccd159389597aba96047e60ba5d7a9df12b67e5cb75230ac41';

const topicToAddress = (topic) => '0x' + String(topic).slice(-40).toLowerCase();
const lc = (a) => String(a || '').toLowerCase();
const strip0x = (v) => String(v || '').replace(/^0x/i, '');
const wordAt = (hex, i) => strip0x(hex).slice(i * 64, i * 64 + 64);
const uintWord = (hex, i) => BigInt('0x' + (wordAt(hex, i) || '0'));
const asciiFromHex = (hex) => {
  const bytes = strip0x(hex);
  const out = [];
  for (let i = 0; i < bytes.length; i += 2) {
    const b = parseInt(bytes.slice(i, i + 2), 16);
    if (!Number.isFinite(b)) break;
    out.push(b);
  }
  return new TextDecoder().decode(new Uint8Array(out));
};

function decodeAbiString(dataHex, offsetBytes) {
  const body = strip0x(dataHex);
  const start = Number(offsetBytes) * 2;
  if (!Number.isFinite(start) || start < 0 || start + 64 > body.length) throw new Error('bad_string_offset');
  const len = Number(BigInt('0x' + body.slice(start, start + 64)));
  const textStart = start + 64;
  const textEnd = textStart + len * 2;
  if (!Number.isFinite(len) || len < 0 || textEnd > body.length) throw new Error('bad_string_length');
  return asciiFromHex(body.slice(textStart, textEnd));
}

export function decodeDrawPaidLog(log) {
  const data = log?.data || '0x';
  return {
    drawId: log?.topics?.[1],
    sellerAgentKey: log?.topics?.[2],
    buyerAgentKey: log?.topics?.[3],
    sellerAgentId: decodeAbiString(data, uintWord(data, 0)),
    buyerAgentId: decodeAbiString(data, uintWord(data, 1)),
    bookingId: decodeAbiString(data, uintWord(data, 2)),
    offerId: decodeAbiString(data, uintWord(data, 3)),
    model: decodeAbiString(data, uintWord(data, 4)),
    n: Number(uintWord(data, 5)),
    sellerUsdAtomic: uintWord(data, 6).toString(),
    feeUsdAtomic: uintWord(data, 7).toString(),
    inputPricePerMTokAtomic: uintWord(data, 8).toString(),
    outputPricePerMTokAtomic: uintWord(data, 9).toString(),
    requestHash: '0x' + wordAt(data, 10),
  };
}

export function createOnchainVerifier({ rpcUrl, rpcUrls, usdcAddress, expectedChainId, fetchImpl = globalThis.fetch,
  // A just-submitted payment can be mined on the payer's RPC yet not YET indexed by
  // ours (cross-RPC propagation lag), so a single receipt lookup returns null and the
  // chunk/settlement is wrongly rejected as tx_not_found_or_pending. Retry the receipt
  // a few times before giving up. Bounded so a genuinely-missing tx still fails fast.
  receiptRetries = 3, receiptRetryMs = 700, sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  // Accept one URL, a comma-separated list, or an array — rpc() rotates across them
  // so a single rate-limited or down RPC can't strand a settlement verification (#108).
  const urls = (rpcUrls?.length ? rpcUrls : String(rpcUrl || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
  const configured = Boolean(urls.length && usdcAddress);
  const usdc = lc(usdcAddress);

  async function rpc(method, params) {
    let lastErr;
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!res.ok) { lastErr = apiError(502, 'rpc_error', `chain RPC returned ${res.status}`); continue; }
        const body = await res.json();
        if (body.error) { lastErr = apiError(502, 'rpc_error', `chain RPC: ${body.error.message ?? 'unknown'}`); continue; }
        return body.result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? apiError(502, 'rpc_error', 'no chain RPC configured');
  }

  // #287: confirm the RPC pool is on the EXPECTED chain before trusting any receipt.
  // Without this, a misconfigured / wrong-chain RPC (or a fallback answering for another
  // chain) could validate a worthless transfer at the same USDC address on a cheap chain
  // as if it were real Base-mainnet USDC. Cache only a SUCCESS, so a transient first-call
  // failure doesn't permanently wedge verification.
  let chainConfirmed = false;
  // #289: coerce up front so an empty/garbage chain id means "no pin" (skip the check),
  // NOT "expected chain 0" -- the latter would brick EVERY verification (no chain reports
  // id 0). Only a positive finite chain id activates the pin.
  const expChain = Number(expectedChainId);
  const chainPinned = Number.isFinite(expChain) && expChain > 0;
  async function assertChain() {
    if (!chainPinned) return true; // no (valid) expected chain configured -> today's behavior
    if (chainConfirmed) return true;
    try {
      const hex = await rpc('eth_chainId', []);
      if (typeof hex === 'string' && parseInt(hex, 16) === expChain) { chainConfirmed = true; return true; }
      return false; // wrong chain (don't cache -- config might be corrected)
    } catch { return false; } // transient -- don't cache, retry next call
  }

  async function fetchReceipt(txHash) {
    let receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    for (let i = 0; !receipt && i < receiptRetries; i++) {
      await sleepImpl(receiptRetryMs);
      receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    }
    if (!receipt) return { error: 'tx_not_found_or_pending' };
    if (lc(receipt.transactionHash) !== lc(txHash)) return { error: 'receipt_tx_mismatch' };
    if (receipt.status !== '0x1') return { error: 'tx_failed' };
    return { receipt };
  }

  function findUsdcTransfer(receipt, { to, minAtomic }) {
    const want = lc(to);
    const log = (receipt.logs || []).find(
      (l) => lc(l.address) === usdc
        && l.topics?.[0] === TRANSFER_TOPIC
        && topicToAddress(l.topics[2]) === want,
    );
    if (!log) return { ok: false, reason: 'no_matching_usdc_transfer' };
    let amount;
    try { amount = BigInt(log.data); } catch { return { ok: false, reason: 'malformed_transfer_log' }; }
    if (amount < BigInt(minAtomic)) return { ok: false, reason: 'amount_too_low' };
    return { ok: true, from: topicToAddress(log.topics[1]), amount: amount.toString() };
  }

  return {
    configured,

    // Confirm txHash is a successful USDC transfer of >= minAtomic to `to`.
    // Returns { ok, reason?, from?, amount? }; never throws on a bad payment
    // (only on an RPC transport failure).
    async verifyTransfer(txHash, { to, minAtomic }) {
      // #287: never trust a receipt from a wrong-chain RPC (a misconfigured / fallback
      // RPC answering for another chain could otherwise validate a worthless transfer).
      if (!(await assertChain())) return { ok: false, reason: 'wrong_chain' };
      const got = await fetchReceipt(txHash);
      if (got.error) return { ok: false, reason: got.error };
      return findUsdcTransfer(got.receipt, { to, minAtomic });
    },

    async verifyDrawPaid(txHash, {
      contractAddress,
      buyerAgentId,
      sellerAgentId,
      bookingId,
      offerId,
      model,
      n,
      sellerWallet,
      feeRecipient,
      minSellerAtomic = 0n,
    } = {}) {
      if (!(await assertChain())) return { ok: false, reason: 'wrong_chain' };
      const contract = lc(contractAddress);
      if (!contract) return { ok: false, reason: 'contract_not_configured' };
      const got = await fetchReceipt(txHash);
      if (got.error) return { ok: false, reason: got.error };

      const log = (got.receipt.logs || []).find((l) =>
        lc(l.address) === contract
        && l.topics?.[0] === DRAW_PAID_TOPIC
      );
      if (!log) return { ok: false, reason: 'no_draw_paid_event' };

      let event;
      try { event = decodeDrawPaidLog(log); } catch { return { ok: false, reason: 'malformed_draw_paid_event' }; }
      if (buyerAgentId != null && event.buyerAgentId !== String(buyerAgentId)) return { ok: false, reason: 'buyer_agent_mismatch' };
      if (sellerAgentId != null && event.sellerAgentId !== String(sellerAgentId)) return { ok: false, reason: 'seller_agent_mismatch' };
      if (bookingId != null && event.bookingId !== String(bookingId)) return { ok: false, reason: 'booking_mismatch' };
      if (offerId != null && event.offerId !== String(offerId)) return { ok: false, reason: 'offer_mismatch' };
      if (model != null && event.model !== String(model)) return { ok: false, reason: 'model_mismatch' };
      if (n != null && event.n !== Number(n)) return { ok: false, reason: 'draw_n_mismatch' };
      if (BigInt(event.sellerUsdAtomic) < BigInt(minSellerAtomic)) return { ok: false, reason: 'amount_too_low' };

      let sellerTransfer = null;
      if (sellerWallet) {
        sellerTransfer = findUsdcTransfer(got.receipt, { to: sellerWallet, minAtomic: BigInt(event.sellerUsdAtomic) });
        if (!sellerTransfer.ok) return { ok: false, reason: 'seller_transfer_' + sellerTransfer.reason };
      }
      let feeTransfer = null;
      if (feeRecipient && BigInt(event.feeUsdAtomic) > 0n) {
        feeTransfer = findUsdcTransfer(got.receipt, { to: feeRecipient, minAtomic: BigInt(event.feeUsdAtomic) });
        if (!feeTransfer.ok) return { ok: false, reason: 'fee_transfer_' + feeTransfer.reason };
      }

      return { ok: true, event, from: sellerTransfer?.from ?? feeTransfer?.from ?? null };
    },
  };
}

// USD (e.g. 0.02) -> USDC atomic units (6 decimals), as a BigInt.
export function usdToAtomic(usd) {
  return BigInt(Math.round(Number(usd) * 1e6));
}
