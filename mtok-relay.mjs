#!/usr/bin/env node
// Reference seller relay for mtok.market.
//
// The buyer signs and submits each on-chain payment, then sends confirmed tx
// hashes here. This relay only verifies those tx hashes before spending the
// seller's inference key. It never submits transactions and never holds money.
//
// Required env:
//   MTOK_API_KEY      seller API key
//   UPSTREAM_KEY      inference provider API key
//   RELAY_WALLET_KEY  seller EVM key, only to derive settlement address
//
// Usage:
//   npx mtok-relay --offer <offerId> --model <id> --upstream <url> [--api <base>] [--port <n>] [--rpc <url>] [--settlement-pubkey <0x...>]

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
