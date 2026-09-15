//! Persisted and transmitted types.
//!
//! # Commitment preimage (must match `backend/src/drand/commitment.ts`)
//!
//! ```text
//! commitment = sha256(
//!     "subrosa.bid.v1"        // 14 bytes, ASCII domain separator
//!  || auction_id             // u64,  big-endian, 8 bytes
//!  || amount                 // i128, big-endian, 16 bytes
//!  || salt                   // 32 bytes
//! )
//! ```
//!
//! The bidder's Stellar address is deliberately *not* part of the preimage. A
//! sealed bid is stored under the address that authenticated the `seal_bid` call,
//! and `reveal_bid` looks the bid up by that same stored address, so a third party
//! who learns an opening cannot redirect credit for the bid. Binding the auction id
//! is what stops an opening from being replayed into a different auction.
//!
//! # Beacon attestation digest (must match `backend/src/drand/attestation.ts`)
//!
//! ```text
//! digest = sha256(
//!     "subrosa.beacon.v1"     // 17 bytes, ASCII domain separator
//!  || chain_hash             // 32 bytes
//!  || round                  // u64,  big-endian, 8 bytes
//!  || randomness             // 32 bytes
//!  || auction_id             // u64,  big-endian, 8 bytes
//! )
//! ```
//!
//! Relay subscribers sign the 32-byte digest with ed25519. Binding `auction_id`
//! means an attestation gathered for one auction cannot be replayed into another
//! even though every auction on the same chain shares a beacon namespace.

use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Storage keys. A `#[contracttype]` enum keeps keys self-describing in the
/// ledger and avoids symbol-collision bugs that raw short symbols invite.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Protocol configuration (instance storage).
    Config,
    /// Monotonic auction counter (instance storage).
    AuctionCount,
    /// An auction, keyed by id (persistent storage).
    Auction(u64),
    /// A sealed bid, keyed by auction and bidder (persistent storage).
    Bid(u64, Address),
    /// Bidder at a dense index within an auction, used for bounded iteration
    /// (persistent storage).
    BidderAt(u64, u32),
    /// Withdrawable balance for a party, keyed by auction and claimant
    /// (persistent storage).
    Claim(u64, Address),
}

/// Where an auction is in its lifecycle.
///
/// `Sealed`, `Reveal` and `Funding` are *time-derived*: the contract recomputes
/// them from the current ledger so a stalled relayer cannot strand an auction.
/// `Settled`, `Cancelled` and `Failed` are sticky terminal states.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    /// Sealed bids are accepted; envelopes stay off-chain.
    Sealed,
    /// The reveal-round beacon is live; anyone may open any envelope.
    Reveal,
    /// The provisional winner is topping up escrow to the hammer price.
    Funding,
    /// Escrow released to the seller, refunds claimable.
    Settled,
    /// Seller cancelled, or the admin aborted. Everything is refundable.
    Cancelled,
    /// The reveal window closed without a bid that met the reserve.
    Failed,
}

/// Immutable-after-init protocol configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// The SAC address of the settlement asset (e.g. USDC), used for all escrow.
    pub settlement_token: Address,
    /// Receives protocol fees.
    pub treasury: Address,
    /// Protocol fee on the hammer price, in basis points.
    pub fee_bps: u32,
    /// `settlement_token` is denominated in this many decimals, used only for
    /// off-chain display and for sanity-checking bond floors.
    pub token_decimals: u32,
    /// Relayer ed25519 public keys allowed to attest drand beacons.
    pub relayer_pubkeys: Vec<BytesN<32>>,
    /// How many of `relayer_pubkeys` must sign one beacon attestation.
    pub relayer_threshold: u32,
    /// Pinned drand chain hash for the network the protocol accepts beacons from.
    pub chain_hash: BytesN<32>,
    /// drand genesis time, unix seconds.
    pub drand_genesis: u64,
    /// drand period, seconds between rounds.
    pub drand_period: u64,
    /// Upper bound on per-auction sealed bids, which bounds every settlement loop.
    pub max_bids: u32,
    /// Ledger close time assumed when translating a future ledger sequence into an
    /// estimated unix timestamp. Only used to pick `reveal_round`, so an
    /// inaccurate value shifts the reveal round and never breaks safety.
    pub assumed_ledger_seconds: u64,
    /// Extra drand rounds added after the estimated commit deadline, absorbing
    /// ledger-time jitter so the beacon is never available while commits are open.
    pub margin_rounds: u64,
    /// Minimum acceptable bid bond.
    pub min_bond: i128,
    /// Minimum ledger gap enforced between a create call and its reveal round.
    pub min_reveal_lead_ledgers: u32,
    pub paused: bool,
}

/// Parameters supplied by the seller when opening an auction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuctionParams {
    /// Lowest hammer price the seller will accept.
    pub reserve_price: i128,
    /// Flat, price-independent bond every sealed bid must escrow.
    ///
    /// It cannot scale with the bid because the bid is secret at seal time. A
    /// flat bond is what makes a sealed bid economically binding.
    pub bond: i128,
    /// Seller's own bond, returned on settlement and slashed on cancellation
    /// after sealed bids exist.
    pub seller_bond: i128,
    pub commit_window_ledgers: u32,
    pub reveal_window_ledgers: u32,
    pub funding_window_ledgers: u32,
}

/// A verified drand beacon, cached after the first successful attestation so
/// later reveals on the same auction skip signature verification.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Beacon {
    pub round: u64,
    pub randomness: BytesN<32>,
}

/// A bid that has been opened. Kept in a dense `Vec` on the auction so that
/// settlement is a single bounded scan without a secondary index lookup.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevealedBid {
    pub bidder: Address,
    pub amount: i128,
}

/// Full auction state.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Auction {
    pub id: u64,
    pub seller: Address,
    pub reserve_price: i128,
    pub bond: i128,
    pub seller_bond: i128,
    /// Ledger sequence after which sealing closes.
    pub commit_deadline: u32,
    /// Ledger sequence after which the provisional winner must stop funding.
    pub funding_deadline: u32,
    /// Ledger sequence at which the seller bond becomes fully returnable.
    pub reveal_deadline: u32,
    /// drand round whose beacon unseals every envelope in this auction.
    pub reveal_round: u64,
    pub phase: Phase,
    pub sealed_count: u32,
    pub revealed_count: u32,
    /// Total tokens the contract holds on this auction's behalf.
    pub escrowed: i128,
    /// Tokens already moved out via `claim`.
    pub claimed: i128,
    /// Bond forfeited by bidders who revealed without funding to their own bid.
    pub slashed: i128,
    /// Per-bidder compensation paid out of the seller bond when the seller
    /// cancels after sealed bids exist. Zero means no compensation is due.
    pub cancel_compensation: i128,
    pub beacon: Option<Beacon>,
    pub winner: Option<Address>,
    pub hammer_price: i128,
    /// Revealed bids in reveal order. Settlement scans this once.
    pub revealed: Vec<RevealedBid>,
}

/// One bidder's participation in one auction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bid {
    pub bidder: Address,
    /// `sha256(domain || auction_id || amount || salt)`, fixed at seal time.
    pub commitment: BytesN<32>,
    /// `sha256(envelope)`, anchoring the off-chain timelock ciphertext.
    pub envelope_hash: BytesN<32>,
    /// Ledger at which the bid was sealed, for audit trails.
    pub sealed_at_ledger: u32,
    /// The flat bond escrowed at seal time.
    pub bond: i128,
    /// Total tokens this bidder has escrowed: bond plus any top-ups.
    pub funded: i128,
    /// Opened amount, zero while still sealed.
    pub revealed_amount: i128,
    pub revealed: bool,
    /// Set once the bidder has pulled their refund.
    ///
    /// Note there is no `skipped` flag: whether a bid was disqualified for
    /// under-funding is `revealed && funded < revealed_amount`, which clients derive
    /// from fields they already have. Recording it would have forced `settle` to
    /// write one ledger entry per disqualified bidder, which is exactly the scaling
    /// cliff this design avoids.
    pub settled: bool,
}

/// A relayer's ed25519 signature over the beacon digest.
///
/// `signer_index` indexes `Config::relayer_pubkeys`; signatures are positional
/// rather than a sparse map so the contract never has to search a key list.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Signature {
    pub signer_index: u32,
    pub signature: BytesN<64>,
}

/// A read-only projection of a bid used by list endpoints, so clients never have
/// to page through storage keys directly.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BidView {
    pub bidder: Address,
    pub envelope_hash: BytesN<32>,
    pub commitment: BytesN<32>,
    pub bond: i128,
    pub funded: i128,
    pub revealed: bool,
    pub revealed_amount: i128,
    pub settled: bool,
}

impl From<&Bid> for BidView {
    fn from(b: &Bid) -> Self {
        BidView {
            bidder: b.bidder.clone(),
            envelope_hash: b.envelope_hash.clone(),
            commitment: b.commitment.clone(),
            bond: b.bond,
            funded: b.funded,
            revealed: b.revealed,
            revealed_amount: b.revealed_amount,
            settled: b.settled,
        }
    }
}
