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

const topicToAddress = (topic) => '0x' + String(topic).slice(-40).toLowerCase();
const lc = (a) => String(a || '').toLowerCase();

export function createOnchainVerifier({ rpcUrl, rpcUrls, usdcAddress, fetchImpl = globalThis.fetch,
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

  return {
    configured,

    // Confirm txHash is a successful USDC transfer of >= minAtomic to `to`.
    // Returns { ok, reason?, from?, amount? }; never throws on a bad payment
    // (only on an RPC transport failure).
    async verifyTransfer(txHash, { to, minAtomic }) {
      let receipt = await rpc('eth_getTransactionReceipt', [txHash]);
      // Retry on a null receipt only — a fresh tx may not be indexed by our RPC yet.
      // A failed/wrong tx returns a non-null receipt and is judged immediately below.
      for (let i = 0; !receipt && i < receiptRetries; i++) {
        await sleepImpl(receiptRetryMs);
        receipt = await rpc('eth_getTransactionReceipt', [txHash]);
      }
      if (!receipt) return { ok: false, reason: 'tx_not_found_or_pending' };
      if (receipt.status !== '0x1') return { ok: false, reason: 'tx_failed' };
      const want = lc(to);
      const log = (receipt.logs || []).find(
        (l) => lc(l.address) === usdc
          && l.topics?.[0] === TRANSFER_TOPIC
          && topicToAddress(l.topics[2]) === want,
      );
      if (!log) return { ok: false, reason: 'no_matching_usdc_transfer' };
      const amount = BigInt(log.data);
      if (amount < BigInt(minAtomic)) return { ok: false, reason: 'amount_too_low' };
      return { ok: true, from: topicToAddress(log.topics[1]), amount: amount.toString() };
    },
  };
}

// USD (e.g. 0.02) -> USDC atomic units (6 decimals), as a BigInt.
export function usdToAtomic(usd) {
  return BigInt(Math.round(Number(usd) * 1e6));
}
