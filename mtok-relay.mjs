#!/usr/bin/env node
// Reference seller relay for mtok.market.
//
// Chain-only (#487): the buyer pays per draw on-chain via the drip contract
// (MtokDripLedger), then sends the confirmed drawPaidTxHash here. This relay
// verifies the DrawPaid event on-chain before spending the seller's inference
// key, serves against it, and reports NOTHING to the platform (the platform
// indexes the draw from Base). It never submits transactions, never holds
// money, and holds no platform secret. The legacy direct-transfer FUND lane
// is gone.
//
// Required env:
//   UPSTREAM_KEY      inference provider API key
//   RELAY_WALLET_KEY  seller EVM key, only to derive settlement address
// Optional env:
//   MTOK_API_KEY      unused since #487 (accepted for backward compat only)
//
// Usage:
//   npx mtok-relay --offer <offerId> --model <id> --upstream <url> --out-price <usd/MTok> [--in-price <usd/MTok>] [--api <base>] [--port <n>] [--rpc <url>] [--settlement-pubkey <0x...>]
//     [--out-price <usd/MTok>] [--in-price <usd/MTok>] [--redemption-file <path>] [--payer-denylist <a,b,c>]
//   Redemption is DURABLE BY DEFAULT (#568): a paid draw attempts upstream at most once across
//   restarts, with no flag needed (the default is ./.mtok-redemption.jsonl in the working dir).
//   Override the path with --redemption-file / RELAY_REDEMPTION_FILE. An empty or unwritable
//   path is rejected or fails closed before upstream spend.

import { readRelayConfig } from './src/config.mjs';
import { startRelayServer } from './src/http.mjs';
import { createRelayRuntime } from './src/runtime.mjs';

try {
  const config = readRelayConfig();
  const runtime = await createRelayRuntime(config);
  startRelayServer({ config, ...runtime });
} catch (e) {
  console.error('mtok-relay: boot failed -', e.message);
  process.exit(1);
}
