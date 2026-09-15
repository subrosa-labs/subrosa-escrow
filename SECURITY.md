# Security

Report vulnerabilities to **security@subrosa.example**. Please do not open a public issue for
anything that could move funds or break bid privacy. We will acknowledge within 72 hours.

---

## What the protocol guarantees

1. **Bid confidentiality until the reveal round.** A bid amount is encrypted in the bidder's
   browser to a future drand round. No plaintext exists in the relayer's database, its logs, its
   memory, or on the ledger. The decryption key is a BLS threshold signature the League of
   Entropy produces only when that round arrives.
2. **No trusted revealer.** Because the key becomes public to everyone at the same instant, any
   party can complete a reveal: the bidder, our relayer, or a stranger reading the chain. A
   bidder who would prefer not to reveal has no move. This is the property that separates
   SubRosa from ordinary commit-reveal, where the committed set is self-selecting.
3. **Reveals are exactly the bids that were sealed.** `reveal_bid` requires the supplied envelope
   to hash to the `envelope_hash` anchored on-chain, and the opening to hash to the anchored
   commitment. Neither the relayer nor the contract can fabricate a bid, and neither can
   substitute a ciphertext for a different one.
4. **Bonds and escrow are conserved.** Every move of the settlement token is a contract-enforced
   transfer, and the invariant `escrowed >= bonds + proceeds` holds at every ledger. An
   under-funded reveal loses its bond rather than winning.
5. **A seller cannot walk away cheaply.** Cancelling while bids are sealed liquidates the seller
   bond and splits it between those bidders.

## What the protocol assumes

### The drand threshold assumption
Bid privacy rests on the League of Entropy: that no threshold of nodes colludes to sign a round
before it is due. This is the same assumption drand's other users make, and it is the reason
timelock encryption is preferable here to a trusted operator — but it *is* an external
dependency, not a proof.

### The on-chain beacon quorum
Soroban exposes no BN254 pairing host function, so the contract cannot verify drand's BLS
signature itself. Instead, registered relayers each verify the signature off-chain and sign an
ed25519 digest binding `(chain_hash, round, randomness, auction_id)`; the contract checks an
M-of-N quorum once per auction.

**This is a real trust assumption and it is documented rather than hidden.** Its failure mode is
narrow, and worth stating precisely: a colluding quorum could invent a `randomness` value and
force a disputed outcome. It **cannot** read a bid early, because fabricating a beacon does not
produce the round's key. The correct mitigations are an M-of-N set held by independent operators
and `npm run drand:verify`, which lets anyone re-verify a round without trusting any SubRosa
infrastructure.

### Availability is not a security property
The relayer, the bulletin board, and the database are all replaceable:

| If this fails | Then |
| --- | --- |
| The relayer is offline during the reveal window | Anyone can reveal. The bidder can always reveal from the backup they saved, which needs no network access to drand at all — the contract only compares hashes. |
| The bulletin loses an envelope | Same: the bidder's own copy is the fallback. |
| The relayer is offline for settlement | `settle` is permissionless, and the UI offers it to any connected wallet. |
| The database is lost | The chain is unaffected. Only convenience data disappears. |

The relayer can make an auction *slow*. It cannot make it unreadable, unsettleable, or
un-refundable.

---

## Known limitations

1. **Public metadata.** Bidder addresses, the number of sealed bids, bond sizes, and the timing
   of every phase are all public. Only the amount is hidden. Hiding the rest requires different
   machinery and different tradeoffs; it is not attempted here.
2. **Sealed-bid cap.** `Config::max_bids` bounds the settlement loop (hard cap 64). An auction
   that fills up rejects further seals rather than degrading.
3. **Ledger-time estimate.** Auction deadlines are ledger sequences while sealing safety is
   enforced by the drand round. `assumed_ledger_seconds` bridges the two. A wrong value moves
   the reveal round — earlier is prevented by `margin_rounds` and `min_reveal_lead_ledgers` —
   but it never weakens the property that no beacon exists during the sealing window, because
   that is enforced by the round arithmetic, not by a timestamp.
4. **The relayer sees the envelope size.** An observer of the ciphertext can tell roughly how
   large a bid's payload is. The payload is a fixed-shape JSON object, so the leak is small but
   non-zero.
5. **No in-place contract upgrade.** A new contract means a new id. In-flight auctions on the
   old contract remain settleable and claimable forever, because those paths are permissionless.
6. **`reveal_bid` reveals the opening publicly.** That is the point, but it means the salt and
   amount become chain state forever. Do not reuse a salt.

---

## Deploying safely

The operational half of this document is [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md). The
security-relevant requirements, in short:

* **One relayer key per operator.** Holding ≥ threshold keys in one place collapses the quorum
  into a single trusted party. The backend refuses to start this way in production.
* **`ADMIN_TOKEN` unset in public deployments**, or set to a long random value. Those routes can
  drive settlement.
* **`CORS_ORIGINS` set to exact origins**, not `*`.
* **`NODE_ENV=production`**, which also enables the single-key enforcement.
* **Re-derive the settlement token address yourself** rather than trusting the value in
  `FUNDING.json`, which exists to be checked.

## Verifying a deployment

Nothing here requires trusting this repository's claims:

```bash
# Re-verify a drand round against quicknet's pinned public key.
npm run drand:verify --workspace backend -- --round <n>

# Confirm the client's commit encoding matches the deployed contract, on-chain.
# The contract exposes hash_commitment(auction_id, amount, salt) for exactly this purpose.

# Confirm the wasm you audited is the wasm that is deployed.
make -C contracts wasm-hash && cat FUNDING.json | jq '.protocol.artifacts.wasm.sha256'
```

## Scope

In scope: the Soroban contract, the relayer and its API, the browser-side sealing and reveal
paths, and the deployment scripts. Out of scope: drand itself, the Stellar network, Freighter,
and the operator's own infrastructure.
