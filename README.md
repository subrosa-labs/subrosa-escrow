# SubRosa Escrow

**A sealed-bid auction and escrow engine on Stellar.** Bids are encrypted in the bidder's
browser to a *future* drand round, so no plaintext bid exists anywhere — not on the ledger,
not in the relayer's database, not in its memory — until that round's threshold signature is
published. Once published, the key is public to everybody at the same instant.

The contract, the relayer, and the UI all live in one repository and all three are checked
against the same byte-level fixtures.

```
subrosa-escrow/
├── contracts/                 Soroban (Rust) escrow + auction engine
│   └── subrosa_escrow/
├── backend/                   Node/TypeScript relayer, drand listener, read API
├── frontend/                  Next.js 14 App Router, Tailwind, @stellar/stellar-sdk
└── FUNDING.json               Protocol validation metadata
```

---

## The problem this solves

A commit-reveal auction on a public ledger hides the bid while it is being placed and then
hands the choice of revealing back to the bidder. That choice is the bug. A bidder who
realises they have lost simply never opens their envelope, and the auction's outcome becomes
advisory at exactly the moment it starts to bind.

Sealing with timelock encryption removes the choice instead of trusting it. The bid is
encrypted to a drand round that does not exist yet; the decryption key is a threshold
signature the League of Entropy will publish, and no single party can produce it early. So:

* **Nobody can read a bid early** — not the seller, not the relayer, not a validator, not
  the bidder's own client after the fact.
* **Everybody can open one later.** At the reveal round the key becomes public, so the
  bidder, our relayer, or a stranger reading the chain can all complete the same reveal.
  A bidder who would rather not reveal no longer has a move.
* **Nobody can invent a bid late either** — the sealed envelope's hash is anchored on-chain
  at seal time, so the opening has to be the one that was committed to.

---

## How a bid flows

```
bidder's browser                    relayer                          Stellar / drand
────────────────                    ───────                          ───────────────
amount + salt
   │
   ├─ commitment = sha256(domain ‖ auction_id ‖ amount ‖ salt)
   ├─ envelope   = tlock_encrypt(reveal_round, payload)      ──────▶ none
   │
   ├─ POST /envelopes {envelope, commitment, envelope_hash} ──────▶ (hash + ciphertext
   │                                                                 that is unreadable)
   │
   ├─ POST /tx/prepare  (seal_bid)           ◀────────────────────── simulate + assemble
   ├─ wallet signs
   ├─ POST /tx/submit   (fee-sponsored)      ──────────────────────▶ seal_bid
   │                                                                 commitment ‖ envelope_hash ‖ bond
   │
   ⋯ sealing window closes ⋯
   │
   │                                       BLS-verify quicknet round ─▶ attest_beacon
   │                                       decrypt every envelope
   │                                       batch reveal_bid          ─▶ revealed amounts land
   │
   ⋯ funding window closes ⋯
   │                                       settle (permissionless)   ─▶ escrow → seller
   └─ claim (refund derived from your own bid) ────────────────────▶ claim
```

The browser never sends an amount, and the API has no endpoint that accepts one. That is not
a policy — it is the interface: the only bid-shaped payload the relayer accepts is a hash and
a ciphertext it cannot open.

Full design notes, including the byte layouts and the resource-limit reasoning, are in
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Quick start

**Prerequisites** — Node ≥ 22.7 (the backend runs TypeScript directly via
`--experimental-transform-types`), npm ≥ 10. Rust ≥ 1.81 with the `wasm32-unknown-unknown`
target and the Stellar CLI (`stellar`) are needed only to build and deploy the contract.

```bash
git clone https://github.com/subrosa-escrow/subrosa-escrow
cd subrosa-escrow
npm install                       # installs both workspaces
```

### 1. Deploy the contract (testnet)

```bash
make -C contracts test            # Rust test suite — no network needed
make -C contracts deploy-testnet  # deploys, initialises, and writes FUNDING.json
```

The deploy script prints the contract id and writes a deployment artifact to
`.tmp/deploy/testnet.json`. It generates throwaway relayer keys on testnet and stores them in
`.tmp/deploy/relayer-keys.json` (mode `0600`). Read that file and copy the secrets into your
`.env` — see the runbook in [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

### 2. Run the relayer

```bash
cp backend/.env.example backend/.env
# fill in SUBROSA_CONTRACT_ID and RELAYER_SECRET_KEYS

node --env-file=backend/.env --experimental-transform-types backend/src/index.ts
# or: npm run dev:backend   (after exporting .env into your shell)
```

The API listens on `:8080`. It prints its preflight results at boot: a reachable RPC, a
contract whose schema version this build understands, and a relayer key set that can actually
satisfy the on-chain quorum. If preflight fails, `/healthz` stays unhealthy and `/v1/admin/
selfcheck` explains why.

### 3. Run the UI

```bash
cp frontend/.env.example frontend/.env.local
npm run dev:frontend              # http://localhost:3000
```

Reads work without a wallet. Sealing a bid needs [Freighter](https://freighter.app), because
the seal is a signed transaction — the ciphertext itself is computed in the page.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `contracts/subrosa_escrow/src/lib.rs` | The contract: escrow, phases, bonds, settlement, claims. |
| `contracts/subrosa_escrow/src/types.rs` | Persisted types and the documented preimage layouts. |
| `contracts/subrosa_escrow/src/test.rs` | Rust tests, including the golden-vector byte tests. |
| `backend/src/drand/` | Chain params, commitment, beacon verification, tlock, envelope encoding. |
| `backend/src/stellar/` | ScVal encoding, contract bindings, submission, and error mapping. |
| `backend/src/services/orchestrator.ts` | The relayer's actual behaviour: observe, attest, reveal, settle. |
| `backend/src/services/bulletin.ts` | The sealed-envelope bulletin board. |
| `backend/src/api/server.ts` | The HTTP API. Notably: no endpoint takes a bid amount. |
| `backend/src/store/` | Job queue, auction cache, envelopes. Postgres, or in-memory for dev/tests. |
| `frontend/lib/tlock.ts` | Where the privacy guarantee is established — sealing in the browser. |
| `frontend/components/` | Auction UI. `AuctionActions` is the lifecycle control room. |
| `frontend/app/how/page.tsx` | The same design explanation, aimed at users rather than auditors. |
| `FUNDING.json` | Protocol metadata: deployed addresses, pinned parameters, invariants, validation steps. |

---

## Contract interface

Admin (`require_auth` on the recorded admin):

```
initialize(admin, settlement_token, treasury, token_decimals, fee_bps,
           relayer_pubkeys, relayer_threshold, chain_hash,
           drand_genesis, drand_period, assumed_ledger_seconds, margin_rounds,
           max_bids, min_bond, min_reveal_lead_ledgers)
set_relayers(admin, relayer_pubkeys, relayer_threshold)   set_fee_bps(admin, bps)
set_treasury(admin, treasury)                             set_min_bond(admin, min_bond)
transfer_admin(admin, new_admin)                          pause(admin) / unpause(admin)
abort_auction(admin, auction_id)
```

Participants:

```
create_auction(seller, params) -> u64          # commit/reveal/funding windows in ledgers
seal_bid(auction_id, bidder, commitment, envelope_hash)
attest_beacon(auction_id, round, randomness, signatures)   # M-of-N ed25519 over the digest
reveal_bid(auction_id, bidder, amount, salt, envelope) -> i128
fund_bid(auction_id, bidder, amount) -> i128
settle(auction_id) -> Auction                  # permissionless
cancel_auction(seller, auction_id)
claim(auction_id, claimant) -> i128            # pull payment
```

Reads and pure helpers:

```
get_config()                 get_auction(id)          auction_count()
list_auctions(start, limit)  get_bid(id, bidder)      list_bids(id, start, limit)
get_claimable(id, claimant)  current_phase(id)        schema_version()
round_at_timestamp(t)        timestamp_for_round(r)
hash_commitment(auction_id, amount, salt)   hash_beacon_digest(chain, round, randomness, auction_id)
```

`hash_commitment` and `hash_beacon_digest` are exposed so that a client can verify its own
encoder against the contract's, on-chain, without deploying anything.

---

## API

Reads answer from the chain with targeted simulations. Nothing here can contradict on-chain
state. Full request/response examples: [`docs/API.md`](./docs/API.md).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | Ledger height, network passphrase, store/RPC status, preflight problems. |
| `GET` | `/v1/config` | The contract's configuration, read live. |
| `GET` | `/v1/drand/info` | Beacon id, chain hash, latest round, time to the next one. |
| `GET` | `/v1/auctions` | Newest auctions from the chain, falling back to the cache for old pages. |
| `GET` | `/v1/auctions/:id` | Auction, timing, windows, attestation, envelope count, and — with `?claimant=` — the caller's claimable balance. |
| `GET` | `/v1/auctions/:id/bids` | Commitments, bonds, escrowed totals, reveal state. |
| `GET` | `/v1/auctions/:id/activity` | Submissions and queued jobs, for operating the thing. |
| `POST` | `/v1/auctions/:id/envelopes` | Publish a sealed ciphertext. Accepts a hash and an envelope, never an amount. |
| `GET` | `/v1/auctions/:id/envelopes/:bidder` | One bidder's ciphertext, used by the reveal flow. |
| `GET` | `/v1/auctions/:id/attestation` | The beacon attestation, its round, and its signer set. |
| `POST` | `/v1/tx/prepare` | Build an unsigned invoke transaction. Bodies carry hashes, not amounts. |
| `POST` | `/v1/tx/submit` | Broadcast a signed envelope, optionally fee-sponsored. |
| `POST` | `/v1/admin/*` | Observation, manual advance, self-check. Only registered when `ADMIN_TOKEN` is set. |

---

## Tests and verification

```bash
make -C contracts test                    # Rust: escrow conservation, phases, slashing, quorum
npm test                                  # relayer: 85 tests, no network needed
npm run test --workspace frontend         # browser encoders, drand arithmetic, formatting
npm run typecheck                         # backend + frontend, strict
npm run build --workspace frontend        # Next.js production build
```

Its one-liner, and what each part proves, is recorded in `FUNDING.json → validation`.

Three commands need the network or a deployment:

```bash
npm run drand:selftest --workspace backend   # seal → wait for the round → decrypt, live
npm run drand:verify   --workspace backend -- --round <n>
npm run e2e            --workspace backend   # full lifecycle against a live deployment
```

### Why the byte-level tests matter

The commitment preimage is implemented four times: in Rust (the contract's `hash_commitment`),
in the relayer, in the browser, and in the golden-vector tests. Every copy must produce
identical bytes for the same inputs, because the failure mode of a drift is silent and
expensive — the seal succeeds, the bond is escrowed, and the reveal is rejected with
`CommitmentMismatch` a day later, when the auction cannot be fixed.

All four read `backend/src/__tests__/fixtures/golden-vectors.json`. The vectors include
amounts above 2<sup>53</sup> and above 2<sup>63</sup>, where a `number`-typed encoder passes the
simple cases and silently diverges from Rust's `i128::to_be_bytes`.

---

## Configuration

Backend (`backend/.env.example`) — the load-bearing entries:

| Variable | Purpose |
| --- | --- |
| `SUBROSA_CONTRACT_ID` | The deployed contract. Required; the service refuses to boot without it. |
| `RELAYER_SECRET_KEYS` | Ed25519 relayer keys (`S...`). **One key per operator.** Holding ≥ threshold in one place collapses the quorum. |
| `DRAND_CHAIN_HASH` | Pinned quicknet chain hash. Changing it without redeploying the contract invalidates every attestation. |
| `DATABASE_URL` | Postgres. Unset uses an in-memory store — fine for dev and tests, and it degrades reveal *availability*, never correctness. |
| `WORKER_ENABLED` | Runs the observe/attest/reveal/settle loop in-process. |
| `ADMIN_TOKEN` | Enables `/v1/admin/*`. Leave unset in public deployments. |

Frontend (`frontend/.env.example`):

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUBROSA_API_URL` | Where the relayer lives. |
| `NEXT_PUBLIC_SETTLEMENT_SYMBOL` | Display symbol only. A Soroban contract cannot read an SAC's metadata, so the name is configured rather than fetched. |

---

## Deployment

Deploying the contract writes real bytes to a real network, so it is deliberately gated:
mainnet requires `CONFIRM_MAINNET_DEPLOY=yes`, and non-testnet networks require
`SUBROSA_RELAYER_PUBKEYS` to be supplied explicitly — the quorum is a trust assumption and
throwaway keys would quietly turn it into a formality.

The full runbook — relayer key ceremony, contract deploy, backend and worker rollout, database
migration, frontend deploy, and the post-deploy checks — is in
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

---

## Security

The trust model, the one thing the contract cannot verify on-chain, and the known limitations
are documented in [`SECURITY.md`](./SECURITY.md). Report vulnerabilities to
`security@subrosa.example`.

## License

Apache-2.0.
