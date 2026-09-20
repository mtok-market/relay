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
//     [--max-output-tokens <n> | RELAY_MAX_OUTPUT_TOKENS] (per-relay output ceiling; default is generous)
//   Redemption is DURABLE BY DEFAULT (#568): a paid draw attempts upstream at most once across
//   restarts, with no flag needed (the default is ./.mtok-redemption.jsonl in the working dir).
//   Override the path with --redemption-file / RELAY_REDEMPTION_FILE. An empty or unwritable
//   path is rejected or fails closed before upstream spend.
//   Replicas on separate hosts use one RELAY_REDEMPTION_DATABASE_URL (PostgreSQL).
//   Migrate stopped file writers with `mtok-relay import-redemptions <file>...`.

import { readRelayConfig } from './src/config.mjs';
import { startRelayServer } from './src/http.mjs';
import { createRelayRuntime } from './src/runtime.mjs';
import { createPostgresRedemptionStore } from './src/postgres-redemption.mjs';
import { importRedemptionFiles } from './src/import-redemptions.mjs';

try {
  if (process.argv[2] === 'import-redemptions') {
    const files = process.argv.slice(3);
    if (!files.length || !process.env.RELAY_REDEMPTION_DATABASE_URL) {
      throw new Error('import-redemptions needs one or more JSONL paths and RELAY_REDEMPTION_DATABASE_URL');
    }
    const store = await createPostgresRedemptionStore({ url: process.env.RELAY_REDEMPTION_DATABASE_URL });
    try {
      const count = await importRedemptionFiles(store, files);
      console.log(`mtok-relay: imported ${count} redemption records and markers`);
    } finally { await store.close(); }
  } else {
    const config = readRelayConfig();
    const runtime = await createRelayRuntime(config);
    const server = startRelayServer({ config, ...runtime });
    server.on('close', () => runtime.close());
  }
} catch (e) {
  console.error('mtok-relay: boot failed -', e.message);
  process.exit(1);
}
