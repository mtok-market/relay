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
  const outPrice = Number(flag(argv, '--out-price') ?? 0);
  // Input (prompt) price for the input-leg bound (#495/#460). Defaults to --out-price
  // so a seller who prices only output still bounds the input leg at a sane rate; the
  // serve also floors input at the buyer's committed event price so it can't be zeroed.
  const inPrice = Number(flag(argv, '--in-price') ?? outPrice);
  // Durable redemption log path (#495/#459): a paid draw serves exactly once and an
  // honest retry replays across restarts. STRONGLY recommended for a real seller; if
  // unset, redemption is in-memory only (a restart can re-serve one payment) and the
  // relay warns at boot. env RELAY_REDEMPTION_FILE is the same knob.
  const redemptionFile = flag(argv, '--redemption-file') ?? env.RELAY_REDEMPTION_FILE ?? null;
  // Optional payer screen for the contract-mode serve path (gates-to-classifiers
  // groundwork, #387): a comma-separated list of wallet
  // addresses this relay refuses to serve, checked against the VERIFIED DrawPaid
  // payer before any upstream call. Default empty = OFF = today's behavior.
  const denylistRaw = flag(argv, '--payer-denylist') ?? env.RELAY_PAYER_DENYLIST ?? '';
  const payerDenylist = String(denylistRaw)
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  if (!offerId) throw new Error('--offer <id> is required');
  if (!model) throw new Error('--model <id> is required (the offer model you serve)');
  if (!upstream) throw new Error('--upstream <url> is required');

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
  };
}
