# mtok-relay

Reference paid seller relay for [mtok.market](https://mtok.market).

`mtok-relay` sits in front of an OpenAI-compatible upstream you control. A buyer
pays one bounded draw on Base through MtokDripLedger, sends the confirmed
`drawPaidTxHash` to your `/chunk` endpoint, and the relay verifies the `DrawPaid`
event before it spends your upstream key. It caps the serve to the paid amount,
caches the completion for honest retries, and reports nothing back to the
platform. The market indexes the draw from Base events.

Before payment, the SDK posts `{ request }` to `/quote` to count the actual provider
input and reserve output at the offered prices. The reference CLI requires a
vLLM-compatible `POST {upstream}/tokenize` endpoint using the same model and chat
template as `{upstream}/v1/chat/completions`. An OpenAI-compatible inference endpoint
alone is insufficient. If tokenization is missing or fails, quotes and fresh paid
draws return 503 before inference; completed draws still replay. Other providers need
a programmatic `countInputTokens(request)` adapter in `createRelayRuntime(config)`.
Do not list a paid offer until its quote endpoint works with the actual provider.

The relay is dual-stack for rolling upgrades. Offers signed with
`requestHashScheme: "nonce-v1"` carry a buyer-generated 16-byte `requestNonce`;
their on-chain `requestHash` commits to
`JSON.stringify({ request, requestNonce })`, preventing chain observers from
guessing common prompts and reading cached completions. Offers without the
marker use the legacy request-only hash. Set the marker only after every relay
instance behind the advertised endpoint runs this dual-stack version. Legacy
text requests remain redeemable, but old optional fields such as `top_p`,
`stop`, tools, streaming, or multi-completion controls are ignored; the relay
still pins one non-streaming text completion to the listed model.

```sh
npx mtok-relay --offer <offerId> --model <id> --upstream <url> --out-price <usd/MTok>
```

Required environment:

- `UPSTREAM_KEY`: bearer token for the upstream model server.
- `RELAY_WALLET_KEY`: seller EVM key, used only to derive the settlement
  address, unless `--settlement-pubkey` is supplied.

Common flags:

- `--api <url>`: mtok market host, default `https://mtok.market`.
- `--port <n>`: relay port, default `8788`.
- `--rpc <url>`: Base RPC override.
- `--settlement-pubkey <0x...>`: seller payout wallet, if you do not want to
  derive it from `RELAY_WALLET_KEY`.
- `--seller-agent <id>`: seller agent id that owns the offer.
- `--out-price <usd/MTok>`: required positive local output cost used to bound the
  serve from the verified paid amount.
- `--in-price <usd/MTok>`: positive local input cost. Defaults to `--out-price`.
- `--max-input-tokens <n>` / `RELAY_MAX_INPUT_TOKENS`: hard input ceiling, default 131072.
- `--max-output-tokens <n>` / `RELAY_MAX_OUTPUT_TOKENS`: output ceiling, default 32768.
  Both ceilings must be positive safe integers; set them for the model you serve.
- `--redemption-file <path>`: durable at-most-one-upstream-attempt log for one host. The default is
  `./.mtok-redemption.jsonl`. An empty path is rejected; an unwritable path makes
  paid serves fail closed before upstream inference.
- `RELAY_REDEMPTION_DATABASE_URL`: PostgreSQL connection URL for replicas on
  separate hosts. Every replica serving the same offers must use the same
  database. Set it through your host's secret store. It cannot be combined with
  an explicit redemption file.
- `--payer-denylist <a,b,c>`: optional payer wallet denylist checked after
  `DrawPaid` verification.

Delivery is at-most-once by design. A paid draw is durably claimed before the
upstream call, and a failure after that claim (an upstream timeout, a model
echo mismatch) leaves the draw permanently unservable: every retry gets
`409 draw_pending`, and buyers should treat it as terminal. This protects the
seller's upstream from being re-run repeatedly against one payment; the cost is
that a transient upstream blip can consume a paid draw. That trade is
deliberate ([#601](https://github.com/mtok-market/mtok-market/issues/601)
tracks an optional bounded-retry mode).

### Shared redemption and migration

The default file protects processes sharing that file and its `.claims`
directory. Separate local files do not coordinate replicas. For replicas with
separate disks, set `RELAY_REDEMPTION_DATABASE_URL` on every instance to one
PostgreSQL database. The relay creates `mtok_redemptions`, its key-alias table,
and an expiry index;
its database role needs table/index creation and read/write access there. Use
TLS certificate verification for remote connections (`sslmode=verify-full` in
the URL), retain database backups, and use a database deployment that preserves
acknowledged commits during failover. A lagging read replica is not a claim
authority. The relay requests synchronous commits and never falls back to a
local file if PostgreSQL is unavailable.

Before moving existing file-backed relays:

1. Stop every old relay process and confirm its upstream requests have ended.
   Stop traffic to every route serving those offers during the migration.
2. Copy each process's JSONL file and adjacent `.claims` directory, preserving
   both. Do not delete the originals or import while old writers are running.
3. With the shared database URL supplied in the environment, run
   `npx mtok-relay import-redemptions /copy/first.jsonl /copy/second.jsonl`.
   Include every old writer, even if its log is empty: its marker directory may
   contain an interrupted claim. Pre-marker relay versions need only their log.
   Repeat the command safely after an interrupted import. A malformed record or
   conflicting saved completion exits unsuccessfully; resolve it before
   resuming traffic.
4. Start every replacement with the same database URL, then restore traffic.
   Keep that database when restarting, scaling or rolling back. Returning to
   the old files would forget the claims made after migration.

One unique row admits the first claim. An unresolved claim stays pending; a
saved completion can be replayed by any replica after payment verification.
Legacy unprefixed and `legacy-v0` keys share a row, while `nonce-v1` remains
separate. Cleanup retains claims beyond the seven-day payment-age window and
its clock allowance. Database or import failures never authorize inference.

The relay admits at most 64 requests at once, including body readers and booking
waiters, and 1,200 requests per minute in total. Excess work gets `503 relay_busy`
or `429 rate_limited` before verification. Bodies have a 10-second deadline;
configuration and each chain RPC have a 5-second deadline. Upstream HTTP calls
abort after 120 seconds, including response-body reads. Set
`RELAY_MAX_CONCURRENT_REQUESTS` and `RELAY_UPSTREAM_TIMEOUT_MS` for your upstream's
capacity and generation time. A post-claim timeout keeps its durable claim.
The SDK leaves temporary failures `paid_unresolved`; it never pays again or
automatically disputes those responses. A completed retry can still replay its
stored result after receipt verification. An unverifiable payment age returns
`503 payment_age_unavailable` before any new claim.

New claims check the platform fee schedule at the verified payment block time.
`GET /api/config` advertises the current `feeBps` and `feeSchedule` activation
history (`effectiveAtMs`, `feeBps`). A rate quoted in the minute before payment
remains valid, so a transaction mining across an increase has a bounded grace.
An older payment keeps its historical rate across relay restarts. The relay
refreshes policy at least once per minute before new claims; an unavailable or
invalid refresh returns `503 fee_policy_unavailable` without claiming the draw.
Retry the same payment. Completed and pending claims still require payment proof
but do not depend on another fee-policy fetch. The fee recipient remains pinned
at startup; a recipient migration requires coordinated relay restarts.

Caller limits allow 120 requests per minute per IPv4 address or IPv6 /64. When
running behind a reverse proxy, set `RELAY_TRUSTED_PROXIES` to its exact peer IPs
(comma-separated). Only those peers may supply a single client address in
`CF-Connecting-IP`, or the header named by `RELAY_CLIENT_IP_HEADER`. Configure the
proxy to overwrite that header and prevent direct clients from impersonating the
proxy. Untrusted, missing, malformed, or multi-address headers fall back to the
socket peer; forwarded headers are never trusted by default.

The transport core is `mtok-bridge`: the relay composes the bridge's
OpenAI-compatible upstream forwarding with settlement verification and
redemption. If you want free private access with no market, account, or payment,
run `npx mtok-bridge` instead.

## Release notes

0.2.2:

- Input-estimate fix (#626). The serve bound estimated one token per UTF-8 byte,
  a true worst case but roughly 4x pessimistic for real text. Because the bound
  refuses AFTER the buyer has paid on chain, an honest ~4KB prompt on a budget
  that covered it was refused and auto-disputed. The estimate is now bytes with
  a ~25% margin (`BYTES_PER_TOKEN_EST`). A prompt that genuinely cannot be paid
  for still refuses before any upstream spend.

0.2.1:

- boot-time compaction of redemption claim markers (#600), and the serve state
  machine now composes `createServeCore` from mtok-bridge (#603), behavior
  unchanged.

0.2.0 (breaking):

- `--out-price` is now required and must be positive; `--in-price` is validated
  the same way (it still defaults to `--out-price`). A 0.1.x command line
  without `--out-price` refuses to boot.
- An empty `--redemption-file` is rejected at startup, and an unwritable path
  fails closed before upstream spend (0.1.x fell back to in-memory with a
  warning).
- Paid draws are claimed durably before the upstream call; post-claim failures
  are terminal (`409 draw_pending`). See the delivery note above.
- The input estimator now upper-bounds tokens by UTF-8 bytes instead of
  chars/3.2, roughly 4x more conservative: a long prompt refuses earlier unless
  the draw funds the input leg accordingly.
- Requests are validated and rebuilt from a whitelist before forwarding. The
  model is pinned to the configured one, streaming and `n>1` are rejected, and
  legacy optional fields (`top_p`, `stop`, tools) are dropped rather than
  forwarded.
- `requestHashScheme: "nonce-v1"` support (see the dual-stack note above).


---

Read-only public mirror. The source of truth is the private mtok.market
monorepo; this repo is synced automatically. Do not open pull requests here.
Home: https://mtok.market
