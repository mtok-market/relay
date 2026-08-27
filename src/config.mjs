import { privateKeyToAccount } from 'viem/accounts';

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};

export function readRelayConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const offerId = flag(argv, '--offer');
  const model = flag(argv, '--model');
  const upstream = (flag(argv, '--upstream') ?? '').replace(/\/$/, '');
  const apiBase = (flag(argv, '--api') ?? 'https://mtok.market').replace(/\/$/, '');
  const port = Number(flag(argv, '--port') ?? 8788);
  const rpcFlag = flag(argv, '--rpc');
  const settlementPubkeyFlag = flag(argv, '--settlement-pubkey');
  // The seller agent-id that OWNS this offer (#(codex review)). When set, the relay makes
  // verifyDrawPaid enforce that the DrawPaid event's sellerAgentId matches, so a sibling
  // agent bound to the same wallet cannot be paid against this offer and served without the
  // fold attributing (and draining) the real offer. Optional for back-compat; recommended.
  const sellerAgentId = flag(argv, '--seller-agent');
  const outPrice = Number(flag(argv, '--out-price'));
  // Input (prompt) price for the input-leg bound (#495/#460). Defaults to --out-price
  // so a seller who prices only output still bounds the input leg at a sane rate; the
  // serve also floors input at the buyer's committed event price so it can't be zeroed.
  const inPrice = Number(flag(argv, '--in-price') ?? outPrice);
  // Durable redemption log path (#495/#459/#568): a paid draw serves exactly once and an
  // honest retry replays across restarts. DURABLE BY DEFAULT (#568): with no flag we still
  // point at a file in the working dir, so `npx mtok-relay` is safe out of the box instead of
  // the old in-memory footgun (a restart could re-serve a paid draw). Override with
  // --redemption-file / RELAY_REDEMPTION_FILE. An unwritable path fails closed
  // before upstream spend; an explicitly empty path is rejected at startup.
  const redemptionFlag = flag(argv, '--redemption-file') ?? env.RELAY_REDEMPTION_FILE;
  if (redemptionFlag === '') throw new Error('--redemption-file cannot be empty; paid serves require durable redemption');
  const redemptionFile = redemptionFlag === undefined ? './.mtok-redemption.jsonl' : redemptionFlag;
  // Optional payer screen for the contract-mode serve path (gates-to-classifiers
  // groundwork, #387): a comma-separated list of wallet
  // addresses this relay refuses to serve, checked against the VERIFIED DrawPaid
  // payer before any upstream call. Default empty = OFF = today's behavior.
  const denylistRaw = flag(argv, '--payer-denylist') ?? env.RELAY_PAYER_DENYLIST ?? '';
  const payerDenylist = String(denylistRaw)
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  // #654: per-relay output-token sanity ceiling. The paid budget already bounds
  // output, so this only caps a single generation (e.g. a no-max_tokens request on
  // a large budget). Operators serving large-context upstreams raise it; unset =>
  // the shared generous default in mtok-bridge's boundServe.
  const maxOutputRaw = flag(argv, '--max-output-tokens') ?? env.RELAY_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = maxOutputRaw != null ? Number(maxOutputRaw) : undefined;
  if (maxOutputTokens != null && (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 1)) {
    throw new Error('--max-output-tokens must be a positive integer');
  }

  if (!offerId) throw new Error('--offer <id> is required');
  if (!model) throw new Error('--model <id> is required (the offer model you serve)');
  if (!upstream) throw new Error('--upstream <url> is required');
  if (!Number.isFinite(outPrice) || outPrice <= 0) {
    throw new Error('--out-price <usd/MTok> is required and must be finite and positive');
  }
  if (!Number.isFinite(inPrice) || inPrice <= 0) {
    throw new Error('--in-price <usd/MTok> must be finite and positive');
  }

  // MTOK_API_KEY is retained ONLY for backward compat (#487): the chain-only relay
  // holds no platform secret. It no longer reports to the platform (POST /api/chunks/report
  // is deleted) and no longer reads /api/bookings/:id, so this key is unused. It is
  // accepted-if-present but no longer required.
  const mtokApiKey = env.MTOK_API_KEY;
  const upstreamKey = env.UPSTREAM_KEY;
  const relayWalletKey = env.RELAY_WALLET_KEY;

  if (!upstreamKey) throw new Error('UPSTREAM_KEY env var is required');
  if (!relayWalletKey && !settlementPubkeyFlag) {
    throw new Error('RELAY_WALLET_KEY env var (or --settlement-pubkey) is required');
  }

  let settlementAddr = settlementPubkeyFlag;
  if (!settlementAddr) {
    try {
      settlementAddr = privateKeyToAccount(relayWalletKey.startsWith('0x') ? relayWalletKey : '0x' + relayWalletKey).address;
    } catch (e) {
      throw new Error(`invalid RELAY_WALLET_KEY: ${e.message}`);
    }
  }

  return {
    offerId,
    model,
    sellerAgentId,
    upstream,
    apiBase,
    port,
    rpcFlag,
    outPrice,
    inPrice,
    redemptionFile,
    mtokApiKey,
    upstreamKey,
    settlementAddr,
    payerDenylist,
    maxOutputTokens,
  };
}
