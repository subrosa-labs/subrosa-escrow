//! Error surface for the SubRosa Escrow contract.
//!
//! Every fallible entry point returns `Result<_, Error>` rather than panicking so
//! that callers (relayer, frontend) can branch on a stable numeric code instead of
//! parsing diagnostic strings.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` has not been called yet.
    NotInitialized = 1,
    /// `initialize` may only be called once.
    AlreadyInitialized = 2,
    /// The admin has frozen state transitions.
    Paused = 3,
    /// The caller is not the admin, the seller, or the bid owner.
    Unauthorized = 4,
    /// No auction exists under the given id.
    AuctionNotFound = 5,
    /// The auction is not in a phase that permits this operation.
    InvalidPhase = 6,
    /// Window lengths must be strictly positive and deadlines must move forward.
    InvalidWindow = 7,
    /// A generic parameter failed its sanity check.
    InvalidParam = 8,
    /// The bid bond is below the protocol floor, or the seller bond is zero.
    InvalidBond = 9,
    /// This bidder already sealed a bid for this auction.
    BidExists = 10,
    /// No sealed bid was found for this (auction, bidder) pair.
    BidNotFound = 11,
    /// The auction reached `max_bids`; no further sealed bids are accepted.
    BidCapReached = 12,
    /// The revealed opening does not hash to the sealed commitment.
    CommitmentMismatch = 13,
    /// `sha256(envelope)` does not match the hash anchored at seal time.
    EnvelopeHashMismatch = 14,
    /// This bid has already been revealed.
    AlreadyRevealed = 15,
    /// The operation needs a revealed bid but the bid is still sealed.
    BidNotRevealed = 16,
    /// No beacon attestation has been recorded and none could be verified.
    BeaconUnavailable = 17,
    /// Fewer than `relayer_threshold` valid signatures were supplied.
    AttestationInvalid = 18,
    /// The attested beacon round does not match the auction's reveal round.
    AttestationRoundMismatch = 19,
    /// The same relayer index was used twice in one attestation.
    DuplicateSigner = 20,
    /// The relayer set or threshold is misconfigured.
    ThresholdNotConfigured = 21,
    /// The bidder's escrowed balance is below the hammer price.
    InsufficientEscrow = 22,
    /// There is no withdrawable balance for this claimant.
    NothingToClaim = 23,
    /// This bidder has already withdrawn, or their bond was slashed.
    AlreadyWithdrawn = 24,
    /// An arithmetic operation left the safe integer range.
    ArithmeticOverflow = 25,
    /// The derived reveal round would already be available when commits close.
    RevealRoundNotInFuture = 26,
    /// The highest revealed bid is below the reserve price.
    ReserveNotMet = 27,
    /// `fee_bps` exceeds `MAX_FEE_BPS`.
    FeesExceedMax = 28,
    /// The seller may not bid on their own auction.
    SellerCannotBid = 29,
    /// More relayers were supplied than `MAX_RELAYERS`.
    TooManyRelayers = 30,
    /// The sealed envelope was empty.
    InvalidEnvelope = 31,
    /// The auction has not progressed far enough for this operation.
    PhaseTooEarly = 32,
    /// Asset amounts must be strictly positive.
    NonPositiveAmount = 33,
}
