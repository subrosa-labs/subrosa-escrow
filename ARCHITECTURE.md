# Architecture

This document is the design record for SubRosa Escrow: what each component is responsible for,
what the system proves, what it merely assumes, and where the sharp edges are.

If you are here to understand the protocol in user terms, read `frontend/app/how/page.tsx`
instead — it is the same argument, told to bidders rather than to reviewers.

---

## 1. Design goals

| Goal | How it is met |
| --- | --- |
| No plaintext bid exists before a fixed public time | Bids are timelock-encrypted in the browser to a future drand round. The key is a threshold signature nobody can produce early. |
| Revealing is compulsory, not a choice | Because the key becomes public to everyone at once, any party can open any envelope. A bidder who would rather not reveal has no move. |
| Sealing is binding but cheap | The bond is flat and posted at seal time, so its size is public while the bid is not. |
| The auction cannot be abandoned by its seller | The seller bond is liquidated to the sealed bidders if the seller cancels once bids exist. |
| Cost per auction is bounded and predictable | Settlement is one bounded read pass; per-bidder refunds are derived on demand rather than written during settlement. |
| No single operator is required for correctness | Reveal and settle are permissionless on-chain, and the bidder keeps their own opening. The relayer is an availability service. |

**Non-goals.** Hiding *that* an address bid, or hiding the number of sealed bids. Both are
public on-chain in this design. Hiding them would mean hiding bid entries entirely, which
requires different machinery (and different tradeoffs) than the one here.

---

## 2. Component map

```
┌──────────────────────────────┐
│  Browser (Next.js 14)        │
│  ├ lib/tlock.ts   seal        │  plaintext lives here and nowhere else
│  ├ lib/commitment.ts  hash     │
│  └ lib/flow.ts    step machines│
└──────────────┬───────────────┘
               │  hash + age ciphertext  (never an amount)
┌──────────────▼───────────────┐        ┌───────────────────────────────┐
│  Relayer (Node/TS, Fastify)   │        │  drand quicknet                │
│  ├ api/server.ts   read + relay│◀──────▶│  /public/<round>  beacon + BLS │
│  ├ services/bulletin.ts        │        └───────────────────────────────┘
│  ├ services/orchestrator.ts    │
│  │    observe → attest → reveal → settle
│  └ store/  jobs, cache, envelopes, attestations
└──────────────┬───────────────┘
               │  signed invocations
┌──────────────▼───────────────┐
│  Soroban contract             │
│  escrow · phases · bonds      │
│  settlement · claims · quorum │
└───────────────────────────────┘
```

Three things are deliberately *not* in the relayer: a bid amount, a decryption key, and any
authority that a user depends on. The relayer can refuse to reveal, and the worst case is that
somebody else does it (or the bidder does, from their own backup) a few minutes later.

---

## 3. The privacy argument

**What is established.** A bid plaintext is encrypted with `tlock` (age + X25519 +
ChaCha20-Poly1305) to drand round `reveal_round`. The decryption key is the BLS threshold
signature the League of Entropy publishes for that round. Producing it early requires a
threshold of nodes to sign a round they have not reached, so:

* the relayer stores a ciphertext it cannot open;
* the contract stores a hash of that ciphertext and a hash of the opening;
* the bidder's own client forgets the plaintext when the tab closes.

**What is assumed.** That drand's threshold assumption holds, and that the round genuinely has
not been reached when sealing closes. The second half is *our* invariant and it is enforced:
`reveal_round = round_at(created_at + commit_window * assumed_ledger_seconds) + margin_rounds`,
and `Config::assumed_ledger_seconds` is an estimate, so the margin exists to absorb the error.
An under-estimate moves the round *later* (safe but slow); an over-estimate moves it earlier,
and the margin is what keeps the beacon out of the sealing window. `min_reveal_lead_ledgers`
bounds the other end at creation time.

**What is deliberately given up.** Sealed amounts are hidden, but the *number* of sealed bids
and the identity of every bidder are public. Bonds are public. The commit deadline is public.
Only the one thing that determines the price is hidden until pricing is over.

---

## 4. Byte layouts

These are the load-bearing encodings. Each is implemented in Rust, in the relayer, and in the
browser, and all three are pinned by `backend/src/__tests__/fixtures/golden-vectors.json`.

### Bid commitment

```text
commitment = sha256(
    "subrosa.bid.v1"    // 14 bytes, ASCII domain separator
 || auction_id          // u64,  big-endian
 || amount              // i128, big-endian two's complement
 || salt                // 32 bytes
)                       // = 70-byte preimage
```

The bidder's address is **not** in the preimage, and that is a decision rather than an
omission. A bid is stored under the address that authenticated `seal_bid`, and `reveal_bid`
looks it up under that same stored address. So a stranger who learns an opening cannot redirect
credit for the bid — they can only reveal it, which is exactly the behaviour we want. Binding
`auction_id` is what stops an opening from being replayed into another auction with the same
amount; binding the whole thing through a random salt is what stops a guessed amount from being
confirmed by hashing candidates.

`i128` big-endian is why the encoder cannot go through a JavaScript `number`. Amounts above
2<sup>53</sup> appear in ordinary auctions, and the golden vectors include cases above
2<sup>63</sup> precisely because a naive encoder passes the small cases and diverges here — a
divergence that only surfaces as a rejected reveal after the bond is escrowed.

### Beacon digest

```text
digest = sha256(
    "subrosa.beacon.v1" // 17 bytes
 || chain_hash          // 32 bytes, pinned in Config at initialisation
 || round               // u64,  big-endian
 || randomness          // 32 bytes
 || auction_id          // u64,  big-endian
)                       // = 97-byte preimage
```

Relayers sign this digest with ed25519; the contract checks an M-of-N quorum once per auction.
Binding `auction_id` prevents an attestation gathered for one auction from being replayed into
another, which matters because every auction on the same chain shares a beacon namespace.

### Sealed payload

The tlock plaintext is a small JSON object, canonically ordered:

```json
{"v":1,"auctionId":"42","amount":"1500000","salt":"<64 hex>",
 "commitment":"<64 hex>","revealRound":<n>,"chainHash":"<64 hex>",
 "bidder":"G...","createdAt":<unix seconds>}
```

`bidder` and `createdAt` are optional and ignored by the contract; they exist so a bidder can
recognise their own opening years later. `v` is a version field so a future payload shape
stays readable rather than silently mis-parsed. `chainHash` is carried so an envelope sealed
against a different drand network is rejected by the opener rather than mis-decrypted.

---

## 5. Lifecycle

Phase is *derived*, never trusted from storage:

```rust
Sealed   : sequence <= commit_deadline
Reveal   : commit_deadline < sequence <= reveal_deadline
Funding  : reveal_deadline < sequence <= funding_deadline
terminal : Settled | Cancelled | Failed   (sticky — the clock can never move these back)
```

Every entry point calls `advance_phase` first, so a stalled relayer cannot strand an auction in
a stale phase: the ledger is the clock, and nothing else has to be running for the phase to be
correct.

The windows are *wider* than the phase labels, and that is intentional:

| Operation | Legal from | Legal to |
| --- | --- | --- |
| `seal_bid` | creation | `commit_deadline` |
| `cancel_auction` | creation | `commit_deadline` (seller only) |
| `reveal_bid` | `commit_deadline + 1` | `funding_deadline` |
| `fund_bid` | `commit_deadline + 1` | `funding_deadline` |
| `settle` | `funding_deadline + 1` | forever |
| `claim` | terminal phase | forever |

Reveal and fund remain legal through the whole funding window, so an auction whose phase has
already moved to `Funding` still accepts a late reveal. The UI derives its buttons from ledger
distance rather than from the phase name for exactly this reason
(`frontend/lib/types.ts → windowsOf`).

---

## 6. Economics

**Bid bond.** Flat, posted at seal time, and public. A sealed bid cannot escrow an amount nobody
is allowed to see, so the bond is what makes the seal cost something.

**Funding window.** Revealing *is* a binding commitment to be able to pay. Whatever is not
escrowed by `funding_deadline` is treated as an unbacked bid: the bond is slashed to the seller
and the bid is excluded from setting the hammer price. This is the gap-closer that the bond
alone cannot provide, because the bond cannot scale with a secret amount.

**Seller bond.** Liquidated and split equally between the sealed bidders if the seller cancels
once bids exist (`cancel_compensation = seller_bond / sealed_count`). Cancelling an auction
whose outcome you dislike has a price.

**Settlement.** The winner is the highest bid whose `funded >= revealed_amount` and which meets
the reserve. Under-funded bids are skipped, not merely penalised — the next bidder up wins
instead of the auction failing. `Settled` requires at least one such bid; otherwise the auction
ends as `Failed` and everything is refundable.

**Fees.** A basis-point fee on the hammer price, capped at 10% at initialisation, credited to
the treasury.

**Refunds.** Pull, never push. `claim` is a pure function of `(auction, bid)` shared with
`get_claimable`, so the two cannot drift apart:

```text
winner              → funded - hammer_price           (surplus only; hammer price stays escrowed)
loser, Settled/Failed → funded if backed, funded - bond if not (bond was slashed)
loser, Cancelled    → funded + cancel_compensation
```

---

## 7. Resource-limit engineering

Soroban meters every ledger entry a transaction touches, so the natural design — write one
refund record per losing bidder during settlement — does not scale and breaks at the entry
limit rather than degrading visibly.

So settlement is **one bounded read pass and three writes**:

1. scan at most `Config::max_bids` already-revealed bids (reads only) to find the hammer price
   and accumulate slashed bonds;
2. credit the seller and the treasury through the claim ledger;
3. mark the auction terminal.

Losing bidders' refunds are derived on demand in `claim` from their own bid plus the auction's
terminal state, so each claimant pays only for their own entry. `max_bids` is capped at 64
(`MAX_BIDS_HARD_CAP`); raising it needs the leading bid maintained incrementally, which v1
deliberately does not do because it adds a mutable write on every funding call. This is written
down in `FUNDING.json → security.known_limitations` rather than left as a surprise.

The beacon quorum is checked once per auction in `attest_beacon`, not once per bid, which takes
`reveal_bid` down to three small arguments and no signature verification.

---

## 8. Storage

```rust
DataKey::Config                     instance
DataKey::AuctionCount               instance
DataKey::Auction(u64)               persistent
DataKey::Bid(u64, Address)          persistent
DataKey::Claim(u64, Address)        persistent
```

TTLs are bumped on write: instance entries to 30 days (threshold 20), persistent entries to 180
days (threshold 120). A bid is a one-write-per-auction entry, so bidding is cheap and does not
depend on a sweep.

The relayer's own store (Postgres, or in-memory for dev and tests) holds things the chain has
no reason to: the sealed envelopes, job leases, submission history, and an auction cache for
pagination. None of it is authoritative — every read route that matters answers from the chain,
and the cache is used only for deep pages of the listing.

**Job queue.** `attest`, `reveal`, `settle`, keyed idempotently on `(auction_id, kind)`.
`upsertJob` may pull a job's schedule *earlier* but never push it later, so a re-observation
cannot delay work that was already scheduled. Claims are leased (`JOB_LEASE_MS`), so two
workers cannot both act; a lapsed lease returns the job to the pool. Failures re-pool with a
delay until `JOB_MAX_ATTEMPTS`, after which the job is parked as `failed` with its reason
recorded. Completed jobs are not resurrected.

---

## 9. The relayer

```
observe()  → for each live auction, plan jobs:
             no beacon yet  → attest (at the round's publish time)
             Reveal/Funding → reveal (at the beacon's availability)
             Funding        → settle (after the funding deadline)

advance(job) → idempotent, re-reads chain state before acting:
             attest : skip if beacon already recorded; verify BLS; collect quorum sigs
             reveal : skip if terminal; defer while sealed or unattested; open each envelope,
                      recompute the commitment, submit reveals in a batch
             settle : defer until the funding deadline passes; submit
```

Every step re-reads chain state before acting, so a job that is retried after a partial
successful batch is safe: already-revealed bids are skipped by the contract
(`AlreadyRevealed`) and by the orchestrator.

**Failure modes and what they cost:**

| Failure | Consequence |
| --- | --- |
| Relayer offline during the reveal window | Anyone can reveal, including the bidder from their backup. Bond safety depends on the *contract's* deadline, not on us. |
| Bulletin loses an envelope | The bidder's own backup reveals it. The contract only needs an opening matching the anchored hash. |
| Relayer offline for settlement | `settle` is permissionless, and the UI offers the button to any connected wallet. |
| Relayer cannot reach drand | Sealing by users is unaffected (their browsers talk to drand directly). Attestation blocks until drand returns — reveals cannot land, but the money is not at risk. |
| Postgres unavailable | The chain is untouched. Reveals degrade to "whoever has the ciphertext", which includes the bidder. |
| Relayer key compromised | The attacker can forge an attestation for a *future* round, which corrupts the outcome but cannot decrypt anything early. The quorum must be M-of-N over independent operators for this to require collusion. |

---

## 10. Trust boundaries

| Party | Trusted for | Not trusted for |
| --- | --- | --- |
| drand quicknet | Producing each round's key only at that round's time | Nothing else — it never sees a bid |
| Relayer quorum (M-of-N) | Having BLS-verified the beacon, and reporting the round's randomness honestly | Reading bids, blocking reveals, or moving funds |
| Auction seller | Setting the terms, and posting a bond that is forfeit on cancellation | Opening bids, changing terms, or escaping the deadline |
| Admin | Fee, treasury, bond floor, quorum rotation, pause, abort | Touching escrow, opening bids, or settling arbitrarily |
| Bidders | Nothing | Nothing — an unfunded reveal loses its bond automatically |

The one place a trust assumption is genuinely load-bearing is the beacon quorum: Soroban
exposes no BN254 pairing host function, so the contract cannot check drand's BLS signature
itself. The failure mode is bounded in a way worth stating precisely — a colluding quorum can
invent a randomness value and therefore a *disputed outcome*, but it cannot decrypt anything
early, because fabricating a beacon does not produce the round's key. `npm run drand:verify`
lets anyone re-verify a round independently.

---

## 11. Why timelock encryption

| Approach | Why not |
| --- | --- |
| Plain commit-reveal | The revealed set is self-selecting. Losers never reveal, so the auction is advisory. |
| A trusted revealer | Reintroduces exactly the party that the bidder's incentive is aimed at. |
| Threshold MPC among bidders | Well-defined cryptography, terrible operational story: every bidder must be online to open an auction, and the threshold has to be chosen before the bidder count is known. |
| Verifiable delay function | Requires a VDF chain nobody has hardened for this, and the delay is a cost, not a key. |
| timelock (this) | One dependency that already exists, produces a key nobody controls, whose timing is enforced by an external clock the blockchain can check arithmetically. |

---

## 12. Duplication, on purpose

Three modules exist in more than one place, and each duplication is a deliberate acceptance of
a maintenance cost in exchange for something:

| Duplicated | Copies | Why the copy is kept |
| --- | --- | --- |
| Bid commitment encoding | Rust, Node, browser | The abstraction boundary *is* the privacy claim: the browser must compute the commitment, so importing the relayer's implementation would invite a future change where the server does it "for convenience". The golden-vector test is the mitigation. |
| Round arithmetic (`round_at` / `round_time`) | Rust, Node, browser | The contract is authoritative and derives every auction's reveal round itself. The other two copies only render countdowns and refuse to seal against a live round. |
| Chain parameters | Rust `Config`, relayer env, browser constant | Pinned in all three so a mismatch is impossible to miss: the contract rejects attestations from another chain, and the browser refuses to open an envelope sealed to one. |

Cross-checking is cheap: the contract exposes `hash_commitment` and `hash_beacon_digest` as
view functions, so a client can verify its own encoder against the deployed contract without
deploying anything.

---

## 13. Versioning

`SCHEMA_VERSION` (currently `1`) is checked at the relayer's preflight against
`EXPECTED_SCHEMA_VERSION`. A mismatch is a hard boot failure rather than a runtime surprise,
because the alternative is a relayer that signs calls the ledger will interpret differently.
Sealed payloads carry their own `v` field for the same reason at the envelope level: an old
envelope stays decodable, and an unknown version is rejected instead of mis-parsed.
