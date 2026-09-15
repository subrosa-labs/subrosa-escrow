# API reference

The relayer exposes a read API (answers from the chain) and a relay API (builds unsigned
transactions for a user to sign). It exposes **no endpoint that accepts a bid amount**, and
that is a design property rather than a current limitation — the browser computes both the
commitment and the ciphertext, and what it sends is a hash plus an encrypted blob the relayer
cannot read.

Base URL: `http://localhost:8080` in development, `NEXT_PUBLIC_SUBROSA_API_URL` in the browser.
Bodies are JSON. Request bodies are capped at 256 KiB.

---

## Errors

Every failure uses the same shape:

```json
{
  "error": "invalid_request",
  "message": "request failed validation",
  "issues": [{ "path": "commitment", "message": "must be 32 bytes of hex" }]
}
```

| `error` | Status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Schema validation failed. `issues` lists each field. |
| `auction_not_found` | 404 | No such auction, or no such envelope. |
| `envelope_not_found` | 404 | No envelope for that bidder on that auction. |
| `attestation_not_found` | 404 | The reveal round's beacon has not been attested yet. |
| `bulletin_rejected` | 4xx | The envelope was refused (size, hash mismatch, auction closed, cap reached). |
| `chain_error` | 502 | The contract rejected the call. `contractErrorCode` and `contractErrorName` carry the contract's own reason, e.g. `CommitmentMismatch` or `InvalidPhase`. |
| `chain_read_failed` | 502 | The simulation failed for a read. |
| `relayer_unavailable` | 503 | The orchestrator could not act — usually a missing key or an unreachable contract. |
| `sponsorship_unavailable` | 409 | `sponsor: true` was requested but no fee source is configured. |
| `unauthorized` | 401 | Missing or wrong `Authorization` on an admin route. |
| `internal_error` | 500 | A bug. |

`chain_error` is the one worth handling: it means the transaction was well-formed and the
*contract* said no, so the message names a real protocol rule.

---

## Health and metadata

### `GET /healthz`

```json
{
  "ok": true,
  "network": "testnet",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "contractId": "C...",
  "ledger": 1234567,
  "store": { "ok": true, "driver": "postgres" },
  "rpc": "ok",
  "chain": "quicknet",
  "preflight": []
}
```

`networkPassphrase` is what a wallet must be pointed at. The frontend compares it against
Freighter's network and warns before a user signs anything for the wrong network.

`preflight` lists boot-check failures — an unreachable RPC, a contract whose schema version this
build does not understand, or a relayer key set that cannot satisfy the on-chain quorum. A
non-empty `preflight` means the service is up but cannot do its job.

### `GET /v1/config`

The contract's live configuration:

```json
{
  "admin": "G...", "settlementToken": "C...", "treasury": "G...",
  "feeBps": 100, "tokenDecimals": 7,
  "relayerThreshold": 2, "relayerCommitteeSize": 3,
  "chainHash": "52db9ba7...", "drandGenesis": 1692803367, "drandPeriod": 3,
  "maxBids": 64, "assumedLedgerSeconds": 5, "marginRounds": 20,
  "minBond": "1000000", "minRevealLeadLedgers": 20, "paused": false
}
```

### `GET /v1/drand/info`

```json
{
  "beaconId": "quicknet",
  "chainHash": "52db9ba7...",
  "publicKey": "83cf0f28...",
  "schemeId": "bls-unchained-g1-rfc9380",
  "periodSeconds": 3,
  "genesisTime": 1692803367,
  "latestRound": 32000123,
  "nextRound": 32000124,
  "nextRoundInMs": 2100
}
```

Round timing is arithmetic, so a client can compute any auction's reveal time locally:
`round_time(r) = genesis + (r - 1) * period`.

---

## Auctions

### `GET /v1/auctions?limit=20&offset=0`

`limit` ≤ 50. Newest first.

```json
{
  "auctions": [ { "id": "7", "seller": "G...", "reservePrice": "10000000", "bond": "1000000",
                  "sellerBond": "1000000", "commitDeadline": 1234100, "revealDeadline": 1235800,
                  "fundingDeadline": 1237500, "revealRound": 32000123, "phase": "Sealed",
                  "sealedCount": 3, "revealedCount": 0, "escrowed": "3000000",
                  "claimed": "0", "slashed": "0", "cancelCompensation": "0",
                  "beacon": null, "winner": null, "hammerPrice": "0", "revealed": [] } ],
  "source": "chain"
}
```

`source` is `chain` when the list came from live simulations and `cache` when it fell back to
the relayer's own copy (older pages, or an RPC hiccup). `revealed` is populated only after the
commit deadline.

### `GET /v1/auctions/:id?claimant=G...`

```json
{
  "auction": { "...": "as above" },
  "envelopes": 3,
  "attestation": { "round": 32000123, "randomness": "...", "signers": [0, 2],
                   "committeeSize": 3, "threshold": 2, "createdAt": "2026-09-15T10:00:00.000Z" },
  "claimable": "0",
  "timing": {
    "now": 1789000000000,
    "currentLedger": 1234567,
    "commitClosesInMs": 900000,
    "revealRoundPublishesAt": 1789000900000,
    "revealRoundAvailable": false,
    "commitLedgersRemaining": 180,
    "revealLedgersRemaining": 180,
    "fundingLedgersRemaining": 1800,
    "terminal": false
  }
}
```

`currentLedger` and the `*LedgersRemaining` fields exist because auction deadlines are ledger
sequences. Without the current height a client cannot tell whether a window is open, and
guessing from a local clock produces transactions the contract rejects. `claimable` is only
present when `claimant` is supplied.

### `GET /v1/auctions/:id/bids?start=0&limit=50`

```json
{
  "auctionId": "7",
  "bids": [
    { "bidder": "G...", "commitment": "<64 hex>", "envelopeHash": "<64 hex>",
      "bond": "1000000", "funded": "0", "revealed": false, "revealedAmount": "0",
      "settled": false, "disqualified": false }
  ]
}
```

`disqualified` is derived (`revealed && funded < revealedAmount`) so every client applies the
slashing rule identically instead of re-implementing it.

### `GET /v1/auctions/:id/activity`

Submissions and queued jobs. This is the operational route: a job parked in `failed` explains
why an auction stopped advancing.

```json
{
  "auctionId": "7",
  "submissions": [ { "method": "attest_beacon", "status": "confirmed", "hash": "...", "ledger": 1234568 } ],
  "jobs": [ { "kind": "reveal", "status": "pending", "attempts": 0, "runAfter": "...", "lastError": null } ]
}
```

---

## The envelope bulletin

The relayer's only job here is availability: it stores ciphertexts so that a reveal does not
depend on the bidder being online. Integrity is anchored on-chain by `sha256(envelope)`, so the
relayer cannot substitute a different ciphertext, and reveal is permissionless, so it cannot
block one either.

### `POST /v1/auctions/:id/envelopes`

```json
{
  "bidder": "G...",
  "envelope": "-----BEGIN AGE ENCRYPTED FILE-----\n...\n-----END AGE ENCRYPTED FILE-----",
  "commitment": "<64 hex>",
  "envelopeHash": "<64 hex>"
}
```

`201`:

```json
{
  "auctionId": "7", "bidder": "G...", "envelopeHash": "<64 hex>", "commitment": "<64 hex>",
  "createdAt": "2026-09-15T10:00:00.000Z",
  "revealRound": 32000123,
  "revealRoundPublishesAt": 1789000900000
}
```

The relayer verifies that `sha256(envelope)` is the `envelopeHash` it was given, rejects
anything larger than `MAX_ENVELOPE_BYTES` (default 8192), enforces the per-auction cap
(`MAX_ENVELOPES_PER_AUCTION`, mirroring the contract's `max_bids`), refuses bids from the seller
and from an address that already sealed, and schedules the reveal job for the instant the round
publishes.

The client publishes **before** it seals on-chain. That ordering means a bid that is anchored
always has its envelope stored, so a failed upload can never strand a reveal. The reverse
failure — envelope stored, seal rejected — leaves an orphan ciphertext, which is harmless: the
orchestrator skips envelopes with no corresponding on-chain bid.

### `GET /v1/auctions/:id/envelopes`

All stored envelopes for an auction, ciphertexts included. Public by design: they are already
unreadable, and after the reveal round they are readable by anyone regardless.

### `GET /v1/auctions/:id/envelopes/:bidder`

One bidder's ciphertext. This is what the reveal flow fetches before opening it with the
now-public beacon.

### `GET /v1/auctions/:id/attestation`

```json
{
  "auctionId": "7", "round": 32000123, "randomness": "<64 hex>",
  "committeeSize": 3, "threshold": 2,
  "signers": [ { "signerIndex": 0, "signature": "<128 hex>" } ],
  "createdAt": "2026-09-15T10:00:00.000Z",
  "verify": "npm run drand:verify --workspace backend -- --round <round>"
}
```

`404` until the round publishes and a quorum has signed. The `verify` hint is the point: anyone
can re-check the beacon against quicknet's public key without trusting this service.

---

## Transaction relaying

### `POST /v1/tx/prepare`

Returns an unsigned invoke transaction, already simulated, with the resource fee filled in. The
body is a discriminated union on `action`.

```jsonc
// seal a bid — note what crosses the wire: two hashes and an auction id
{ "action": "seal_bid", "bidder": "G...", "auctionId": "7",
  "commitment": "<64 hex>", "envelopeHash": "<64 hex>" }

// create an auction (windows are in ledgers)
{ "action": "create_auction", "seller": "G...",
  "reservePrice": "10000000", "bond": "1000000", "sellerBond": "1000000",
  "commitWindowLedgers": 3456, "revealWindowLedgers": 1728, "fundingWindowLedgers": 1728 }

// reveal: the opening, which is public from the moment the round publishes
{ "action": "reveal_bid", "bidder": "G...", "auctionId": "7",
  "amount": "15000000", "salt": "<64 hex>", "envelope": "-----BEGIN AGE ENCRYPTED FILE-----..." }

{ "action": "fund_bid",  "bidder": "G...", "auctionId": "7", "amount": "15000000" }
{ "action": "settle",    "source": "G...", "auctionId": "7" }
{ "action": "claim",     "claimant": "G...", "auctionId": "7" }
{ "action": "cancel_auction", "seller": "G...", "auctionId": "7" }
```

```json
{
  "action": "seal_bid",
  "xdr": "AAAAAg...",
  "source": "G...",
  "contractId": "C...",
  "minResourceFee": "123456",
  "latestLedger": 1234567,
  "networkPassphrase": "Test SDF Network ; September 2015",
  "instructions": "sign with the actor account, then POST the signed envelope to /v1/tx/submit"
}
```

`settle` is offered to any account on purpose. Settlement is permissionless and the outcome is a
fixed function of on-chain state, so it does not matter who pays the fee — which is exactly why
a stalled relayer cannot strand anyone's funds.

### `POST /v1/tx/submit`

```json
{ "xdr": "<signed envelope XDR>", "sponsor": true }
```

```json
{
  "hash": "abc123...", "ledger": 1234568, "sponsored": true,
  "returnValueXdr": null,
  "explorerUrl": "https://stellar.expert/explorer/testnet/tx/abc123..."
}
```

With `sponsor: true` the relayer wraps the signed transaction in a fee bump and pays for it
itself. It cannot alter the inner transaction — a fee bump can only change the fee — so this
lets a brand-new bidder seal their first bid with no XLM, without giving the relayer any
authority over what the transaction does.

If the contract rejects the call the response is `502 chain_error` with the contract's own error
name, e.g.:

```json
{ "error": "chain_error", "message": "commitment does not match the sealed bid",
  "contractErrorCode": 15, "contractErrorName": "CommitmentMismatch" }
```

---

## Admin

Only registered when `ADMIN_TOKEN` is set, and required as `Authorization: Bearer <token>`.
Leave it unset in a public deployment: these routes can drive settlement.

| Route | Effect |
| --- | --- |
| `POST /v1/admin/observe` | Scan live auctions and report which jobs would be scheduled. |
| `POST /v1/admin/advance/:id` | Run the next queued step for one auction (`attest`, `reveal`, or `settle`, chosen from chain state). |
| `POST /v1/admin/selfcheck` | Validate that this process's key set can satisfy the on-chain quorum, and show the contract's pinned parameters. |
