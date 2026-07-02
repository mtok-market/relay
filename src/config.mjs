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
  // Optional payer screen for the contract-mode serve path (gates-to-classifiers
  // groundwork, docs/chain-native-phase2.md): a comma-separated list of wallet
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

  const mtokApiKey = env.MTOK_API_KEY;
  const upstreamKey = env.UPSTREAM_KEY;
  const relayWalletKey = env.RELAY_WALLET_KEY;

  if (!mtokApiKey) throw new Error('MTOK_API_KEY env var is required');
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
    mtokApiKey,
    upstreamKey,
    settlementAddr,
    payerDenylist,
  };
}
