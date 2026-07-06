// packages/relay/src/rpc.mjs — the relay's own Base RPC fallback lists, in ONE place.
// Both src/runtime.mjs (the verifier transport) and smoke.mjs (the manual testnet
// harness) import from here so the endpoint lists never drift apart.
// NOTE: packages/sdk/settle-mainnet.mjs keeps its own copy (out of this package's
// scope); keep this in sync with it by hand if the SDK list changes.

export const BASE_MAINNET_RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
];

export const BASE_SEPOLIA_RPCS = [
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
];

// Resolve the RPC url list for a chain, honoring an explicit override (single url).
export const rpcUrlsFor = (chainId, override) =>
  override ? [override] : Number(chainId) === 8453 ? BASE_MAINNET_RPCS : BASE_SEPOLIA_RPCS;
