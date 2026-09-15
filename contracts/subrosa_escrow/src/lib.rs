#![no_std]

//! # SubRosa Escrow
//!
//! A sealed-bid auction and escrow engine.
//!
//! ## Why this contract exists
//!
//! A public ledger makes every bid visible the instant it is submitted, and
//! ordinary commit-reveal fixes only half the problem: the *committer* can still
//! refuse to reveal, which makes a bid non-binding at exactly the moment that
//! matters. SubRosa removes the revealer from the trust model instead of trusting
//! them. Bids are sealed with drand timelock encryption to a future quicknet
//! round, so the plaintext provably cannot exist anywhere until that round's
//! threshold signature is published — and once it is published, the decryption key
//! is public to everyone at once. Any party (the bidder, our relayer, or a
//! stranger) can therefore open an envelope, and no party can open one early.
//!
//! ## What the contract does and does not verify
//!
//! It verifies:
//!
//! * that a revealed opening hashes to the commitment anchored at seal time, and
//!   that the supplied envelope hashes to the envelope hash anchored then too;
//! * that the beacon for the auction's pinned reveal round was attested by a
//!   quorum of registered relayers;
//! * that every ledger of value is conserved across seal, reveal, funding,
//!   settlement and claim.
//!
//! It does **not** verify the drand BLS signature itself. Soroban exposes no BN254
//! pairing function, so on-chain beacon authenticity reduces to an M-of-N ed25519
//! quorum over a digest that binds `(chain_hash, round, randomness, auction_id)`.
//! That is a real trust assumption and it is documented rather than hidden; see
//! `FUNDING.json -> protocol.privacy_model.beacon.verification_witness`.
//!
//! ## Resource-limit engineering
//!
//! Soroban meters every ledger entry a transaction touches. A naive design writes
//! one refund record per losing bidder during settlement, which does not scale and
//! silently breaks at the entry-count limit. So settlement is **one bounded read
//! pass and three writes**:
//!
//! * `settle` scans at most `Config::max_bids` already-revealed bids (reads only)
//!   to find the hammer price and accumulate slashed bonds;
//! * it credits the seller and the treasury through the `Claim` ledger;
//! * every losing bidder's refund is *derived on demand* in `claim` from their own
//!   bid plus the auction's terminal state, so each claimant pays only for their
//!   own entry.
//!
//! `max_bids` is capped at [`MAX_BIDS_HARD_CAP`] and defaults to a lower value; the
//! path to raising it is maintaining the leading bid incrementally, which is a
//! deliberate non-goal for v1 because it adds mutable state on every funding call.

mod errors;
mod events;
mod types;

#[cfg(test)]
mod test;

pub use crate::errors::Error;
pub use crate::types::{
    Auction, AuctionParams, Beacon, Bid, BidView, Config, DataKey, Phase, RevealedBid, Signature,
};

use soroban_sdk::{
    contract, contractimpl, token, Address, Bytes, BytesN, Env, Vec,
};

/// Ledger closes are targeted at 5 seconds.
const SECONDS_PER_LEDGER: u64 = 5;
const DAY_IN_LEDGERS: u32 = 17_280;

const INSTANCE_BUMP: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_THRESHOLD: u32 = 20 * DAY_IN_LEDGERS;
const PERSISTENT_BUMP: u32 = 180 * DAY_IN_LEDGERS;
const PERSISTENT_THRESHOLD: u32 = 120 * DAY_IN_LEDGERS;

/// Ceiling on the protocol fee.
const MAX_FEE_BPS: u32 = 1_000;

/// Upper bound on `Config::max_bids`. Chosen so that settlement's read pass stays
/// comfortably inside a transaction's ledger-entry budget; see the module docs.
const MAX_BIDS_HARD_CAP: u32 = 64;

/// Upper bound on the relayer quorum size, which bounds attestation verification.
const MAX_RELAYERS: u32 = 16;

const DOMAIN_BID: &[u8] = b"subrosa.bid.v1";
const DOMAIN_BEACON: &[u8] = b"subrosa.beacon.v1";

const BID_PREIMAGE_LEN: usize = 14 + 8 + 16 + 32;
const BEACON_PREIMAGE_LEN: usize = 17 + 32 + 8 + 32 + 8;

/// Bumped whenever the on-chain state layout changes incompatibly.
const SCHEMA_VERSION: u32 = 1;

#[contract]
pub struct SubRosaEscrow;

#[contractimpl]
impl SubRosaEscrow {
    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    /// One-shot protocol setup. Pins the drand chain so that an attestation for a
    /// different beacon network can never be accepted, and registers the relayer
    /// quorum that will be trusted as the on-chain beacon witness.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        settlement_token: Address,
        treasury: Address,
        token_decimals: u32,
        fee_bps: u32,
        relayer_pubkeys: Vec<BytesN<32>>,
        relayer_threshold: u32,
        chain_hash: BytesN<32>,
        drand_genesis: u64,
        drand_period: u64,
        assumed_ledger_seconds: u64,
        margin_rounds: u64,
        max_bids: u32,
        min_bond: i128,
        min_reveal_lead_ledgers: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        if fee_bps > MAX_FEE_BPS {
            return Err(Error::FeesExceedMax);
        }
        let relayer_count = relayer_pubkeys.len();
        if relayer_count == 0 || relayer_count > MAX_RELAYERS {
            return Err(Error::TooManyRelayers);
        }
        if relayer_threshold == 0 || relayer_threshold > relayer_count {
            return Err(Error::ThresholdNotConfigured);
        }
        if drand_period == 0 || assumed_ledger_seconds == 0 {
            return Err(Error::InvalidParam);
        }
        if margin_rounds == 0 {
            return Err(Error::InvalidParam);
        }
        if max_bids == 0 || max_bids > MAX_BIDS_HARD_CAP {
            return Err(Error::InvalidParam);
        }
        if min_bond <= 0 {
            return Err(Error::InvalidBond);
        }
        if min_reveal_lead_ledgers == 0 {
            return Err(Error::InvalidParam);
        }

        let config = Config {
            admin: admin.clone(),
            settlement_token,
            treasury,
            fee_bps,
            token_decimals,
            relayer_pubkeys,
            relayer_threshold,
            chain_hash: chain_hash.clone(),
            drand_genesis,
            drand_period,
            max_bids,
            assumed_ledger_seconds,
            margin_rounds,
            min_bond,
            min_reveal_lead_ledgers,
            paused: false,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::AuctionCount, &0u64);
        Self::bump_instance(&env);

        events::config_initialized(&env, &admin, &chain_hash);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /// Rotate the relayer quorum. Existing auctions keep their recorded beacon but
    /// any auction that has not yet attested a beacon will be judged against the
    /// new quorum, so this is an emergency-grade operation.
    pub fn set_relayers(
        env: Env,
        admin: Address,
        relayer_pubkeys: Vec<BytesN<32>>,
        relayer_threshold: u32,
    ) -> Result<(), Error> {
        let mut config = Self::load_config(&env)?;
        Self::require_admin(&config, &admin)?;
        admin.require_auth();

        let count = relayer_pubkeys.len();
        if count == 0 || count > MAX_RELAYERS {
            return Err(Error::TooManyRelayers);
        }
        if relayer_threshold == 0 || relayer_threshold > count {
            return Err(Error::ThresholdNotConfigured);
        }

        config.relayer_pubkeys = relayer_pubkeys;
        config.relayer_threshold = relayer_threshold;
        env.storage().instance().set(&DataKey::Config, &config);
        Self::bump_instance(&env);

        events::config_updated(&env, soroban_sdk::Symbol::new(&env, "relayers"), &admin);
        Ok(())
    }

    pub fn set_fee_bps(env: Env, admin: Address, fee_bps: u32) -> Result<(), Error> {
        let mut config = Self::load_config(&env)?;
        Self::require_admin(&config, &admin)?;
        admin.require_auth();
        if fee_bps > MAX_FEE_BPS {
            return Err(Error::FeesExceedMax);
        }
        config.fee_bps = fee_bps;
        env.storage().instance().set(&DataKey::Config, &config);
        Self::bump_instance(&env);
        events::config_updated(&env, soroban_sdk::Symbol::new(&env, "fee_bps"), &admin);
        Ok(())
    }

    pub fn set_treasury(env: Env, admin: Address, treasury: Address) -> Result<(), Error> {
        let mut config = Self::load_config(&env)?;
        Self::require_admin(&config, &admin)?;
        admin.require_auth();
        config.treasury = treasury;
        env.storage().instance().set(&DataKey::Config, &config);
        Self::bump_instance(&env);
        events::config_updated(&env, soroban_sdk::Symbol::new(&env, "treasury"), &admin);
        Ok(())
    }

    pub fn set_min_bond(env: Env, admin: Address, min_bond: i128) -> Result<(), Error> {
        let mut config = Self::load_config(&env)?;
        Self::require_admin(&config, &admin)?;
        admin.require_auth();
        if min_bond <= 0 {
            return Err(Error::InvalidBond);
        }
        config.min_bond = min_bond;
        env.storage().instance().set(&DataKey::Config, &config);
        Self::bump_instance(&env);
        events::config_updated(&env, soroban_sdk::Symbol::new(&env, "min_bond"), &admin);
        Ok(())
    }

    pub fn transfer_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        let mut config = Self::load_config(&env)?;
        Self::require_admin(&config, &admin)?;
        admin.require_auth();
        config.admin = new_admin;
        env.storage().instance().set(&DataKey::Config, &config);
        Self::bump_instance(&env);
        events::config_updated(&env, soroban_sdk::Symbol::new(&env, "admin"), &admin);
        Ok(())
    }

    /// Freeze new exposure.
    ///
    /// Deliberately does **not** block `reveal_bid`, `fund_bid`, `settle` or
    /// `claim`. A pause should stop the protocol from taking on new obligations; it
    /// must never be able to strand value that is already escrowed.
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        Self::set_paused(env, admin, true)
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        Self::set_paused(env, admin, false)
    }

    // -----------------------------------------------------------------------
    // Auction lifecycle
    // -----------------------------------------------------------------------

    /// Open an auction. The reveal round is *derived by the contract* from its own
    /// clock rather than accepted as a parameter, so a seller cannot choose a round
    /// that is already decryptable and leak a competitor's bid.
    pub fn create_auction(
        env: Env,
        seller: Address,
        params: AuctionParams,
    ) -> Result<u64, Error> {
        let config = Self::load_config(&env)?;
        Self::require_not_paused(&config)?;
        seller.require_auth();

        if params.reserve_price <= 0 {
            return Err(Error::NonPositiveAmount);
        }
        if params.bond < config.min_bond || params.seller_bond <= 0 {
            return Err(Error::InvalidBond);
        }
        if params.commit_window_ledgers == 0
            || params.reveal_window_ledgers == 0
            || params.funding_window_ledgers == 0
        {
            return Err(Error::InvalidWindow);
        }
        if params.commit_window_ledgers < config.min_reveal_lead_ledgers {
            return Err(Error::InvalidWindow);
        }

        let now_seq = env.ledger().sequence();
        let now_ts = env.ledger().timestamp();

        let commit_deadline = now_seq
            .checked_add(params.commit_window_ledgers)
            .ok_or(Error::ArithmeticOverflow)?;
        let reveal_deadline = commit_deadline
            .checked_add(params.reveal_window_ledgers)
            .ok_or(Error::ArithmeticOverflow)?;
        let funding_deadline = reveal_deadline
            .checked_add(params.funding_window_ledgers)
            .ok_or(Error::ArithmeticOverflow)?;

        // Estimated wall-clock time at which commits close. Ledger time is not
        // perfectly regular, which is exactly why `margin_rounds` exists: we would
        // rather unseal slightly late than unseal while commits are still open.
        let commit_ts_delta = (params.commit_window_ledgers as u64)
            .checked_mul(config.assumed_ledger_seconds)
            .ok_or(Error::ArithmeticOverflow)?;
        let est_commit_ts = now_ts
            .checked_add(commit_ts_delta)
            .ok_or(Error::ArithmeticOverflow)?;

        let reveal_round = Self::round_at(est_commit_ts, config.drand_genesis, config.drand_period)
            .checked_add(config.margin_rounds)
            .ok_or(Error::ArithmeticOverflow)?;

        if Self::round_time(reveal_round, config.drand_genesis, config.drand_period) <= now_ts {
            return Err(Error::RevealRoundNotInFuture);
        }

        let auction_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::AuctionCount)
            .unwrap_or(0u64);
        let next_id = auction_id.checked_add(1).ok_or(Error::ArithmeticOverflow)?;

        let auction = Auction {
            id: auction_id,
            seller: seller.clone(),
            reserve_price: params.reserve_price,
            bond: params.bond,
            seller_bond: params.seller_bond,
            commit_deadline,
            reveal_deadline,
            funding_deadline,
            reveal_round,
            phase: Phase::Sealed,
            sealed_count: 0,
            revealed_count: 0,
            escrowed: params.seller_bond,
            claimed: 0,
            slashed: 0,
            cancel_compensation: 0,
            beacon: None,
            winner: None,
            hammer_price: 0,
            revealed: Vec::new(&env),
        };

        env.storage().instance().set(&DataKey::AuctionCount, &next_id);
        Self::put_auction(&env, &auction);
        Self::bump_instance(&env);

        // Escrow the seller bond, which is what makes a cancellation after sealed
        // bids exist costly rather than free.
        Self::transfer_in(
            &env,
            &config.settlement_token,
            &seller,
            params.seller_bond,
        )?;

        events::auction_created(
            &env,
            auction_id,
            &seller,
            params.reserve_price,
            params.bond,
            commit_deadline,
            reveal_deadline,
            funding_deadline,
            reveal_round,
        );

        Ok(auction_id)
    }

    /// Anchor a sealed bid.
    ///
    /// The envelope itself stays off-chain; only its hash and the commitment go to
    /// the ledger, which keeps a 700-byte age ciphertext out of state while still
    /// making the ciphertext tamper-evident. Reveal is permissionless, so
    /// off-chain storage is an availability dependency, never a correctness one.
    pub fn seal_bid(
        env: Env,
        auction_id: u64,
        bidder: Address,
        commitment: BytesN<32>,
        envelope_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let config = Self::load_config(&env)?;
        Self::require_not_paused(&config)?;
        bidder.require_auth();

        let mut auction = Self::load_auction(&env, auction_id)?;
        Self::advance_phase(&env, &mut auction)?;

        if auction.phase != Phase::Sealed || env.ledger().sequence() > auction.commit_deadline {
            return Err(Error::InvalidPhase);
        }
        if bidder == auction.seller {
            return Err(Error::SellerCannotBid);
        }
        if auction.sealed_count >= config.max_bids {
            return Err(Error::BidCapReached);
        }

        let bid_key = DataKey::Bid(auction_id, bidder.clone());
        if env.storage().persistent().has(&bid_key) {
            return Err(Error::BidExists);
        }

        let bid = Bid {
            bidder: bidder.clone(),
            commitment,
            envelope_hash,
            sealed_at_ledger: env.ledger().sequence(),
            bond: auction.bond,
            funded: auction.bond,
            revealed_amount: 0,
            revealed: false,
            settled: false,
        };

        env.storage().persistent().set(&bid_key, &bid);
        env.storage().persistent().set(
            &DataKey::BidderAt(auction_id, auction.sealed_count),
            &bidder,
        );
        Self::bump_persistent(&env, &bid_key);

        auction.sealed_count += 1;
        auction.escrowed = auction
            .escrowed
            .checked_add(auction.bond)
            .ok_or(Error::ArithmeticOverflow)?;
        Self::put_auction(&env, &auction);

        Self::transfer_in(&env, &config.settlement_token, &bidder, auction.bond)?;

        events::bid_sealed(
            &env,
            auction_id,
            &bidder,
            &bid.commitment,
            &bid.envelope_hash,
            bid.bond,
        );

        Ok(())
    }

    /// Record the reveal-round beacon after checking a quorum of relayer
    /// signatures over `sha256(domain || chain_hash || round || randomness || auction_id)`.
    ///
    /// Split out from `reveal_bid` so the (comparatively expensive) signature
    /// verification happens once per auction instead of once per bid, and so that a
    /// beacon can be published even if every bidder walks away.
    pub fn attest_beacon(
        env: Env,
        auction_id: u64,
        round: u64,
        randomness: BytesN<32>,
        attestation: Vec<Signature>,
    ) -> Result<(), Error> {
        let config = Self::load_config(&env)?;
        let mut auction = Self::load_auction(&env, auction_id)?;

        if auction.beacon.is_some() {
            return Err(Error::AlreadyRevealed);
        }
        if auction.phase == Phase::Sealed
            || auction.phase == Phase::Settled
            || auction.phase == Phase::Cancelled
            || auction.phase == Phase::Failed
        {
            return Err(Error::InvalidPhase);
        }
        if round != auction.reveal_round {
            return Err(Error::AttestationRoundMismatch);
        }

        Self::verify_attestation(&env, &config, auction_id, round, &randomness, &attestation)?;

        auction.beacon = Some(Beacon { round, randomness });
        Self::put_auction(&env, &auction);

        events::beacon_recorded(&env, auction_id, round, &randomness);
        Ok(())
    }

    /// Open a sealed bid. Permissionless by design.
    ///
    /// The caller pays, but credit always accrues to the bidder whose commitment
    /// matches — which is why the bidder's address is deliberately *not* part of the
    /// commitment preimage. A stranger who learns an opening can only do the bidder a
    /// favour, never steal their position.
    ///
    /// Requires the reveal-round beacon to have been attested already (see
    /// [`SubRosaEscrow::attest_beacon`]). Splitting the two keeps signature
    /// verification at once per auction instead of once per bid, and drops the
    /// reveal call down to three small arguments.
    pub fn reveal_bid(
        env: Env,
        auction_id: u64,
        bidder: Address,
        amount: i128,
        salt: BytesN<32>,
        envelope: Bytes,
    ) -> Result<i128, Error> {
        if envelope.len() == 0 {
            return Err(Error::InvalidEnvelope);
        }

        let mut auction = Self::load_auction(&env, auction_id)?;
        Self::advance_phase(&env, &mut auction)?;

        let now_seq = env.ledger().sequence();
        if now_seq <= auction.commit_deadline || now_seq > auction.funding_deadline {
            return Err(Error::InvalidPhase);
        }
        if amount <= 0 {
            return Err(Error::NonPositiveAmount);
        }

        let mut bid = Self::load_bid(&env, auction_id, &bidder)?;
        if bid.revealed {
            return Err(Error::AlreadyRevealed);
        }

        // 1. The envelope must be the exact bytes whose hash was anchored at seal.
        let envelope_digest = env.crypto().sha256(&envelope);
        if envelope_digest != bid.envelope_hash {
            return Err(Error::EnvelopeHashMismatch);
        }

        // 2. The opening must hash to the commitment anchored at seal.
        let expected = Self::bid_commitment(&env, auction_id, amount, &salt);
        if expected != bid.commitment {
            return Err(Error::CommitmentMismatch);
        }

        // 3. The beacon that made this envelope decryptable must already be on
        //    record. `attest_beacon` is where the quorum signatures were checked,
        //    so this path never re-verifies them.
        match auction.beacon.clone() {
            Some(beacon) => {
                if beacon.round != auction.reveal_round {
                    return Err(Error::AttestationRoundMismatch);
                }
            }
            None => return Err(Error::BeaconUnavailable),
        }

        bid.revealed = true;
        bid.revealed_amount = amount;
        let bid_key = DataKey::Bid(auction_id, bidder.clone());
        env.storage().persistent().set(&bid_key, &bid);
        Self::bump_persistent(&env, &bid_key);

        auction.revealed.push_back(RevealedBid {
            bidder: bidder.clone(),
            amount,
        });
        auction.revealed_count += 1;
        Self::put_auction(&env, &auction);

        let source = env.current_contract_address();
        events::bid_revealed(&env, auction_id, &bidder, &source, amount, auction.reveal_round);

        Ok(amount)
    }

    /// Top up escrow towards the bid that was revealed.
    ///
    /// A revealed bid is a binding commitment to be able to pay it. The flat bond
    /// cannot scale with a secret amount, so the funding window is what closes the
    /// gap: whatever is not escrowed by `funding_deadline` is treated as an
    /// unbacked bid and its bond is forfeited.
    pub fn fund_bid(
        env: Env,
        auction_id: u64,
        bidder: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        let config = Self::load_config(&env)?;
        bidder.require_auth();

        if amount <= 0 {
            return Err(Error::NonPositiveAmount);
        }

        let mut auction = Self::load_auction(&env, auction_id)?;
        Self::advance_phase(&env, &mut auction)?;

        let now_seq = env.ledger().sequence();
        if now_seq <= auction.commit_deadline || now_seq > auction.funding_deadline {
            return Err(Error::InvalidPhase);
        }

        let mut bid = Self::load_bid(&env, auction_id, &bidder)?;
        if !bid.revealed {
            return Err(Error::BidNotRevealed);
        }

        bid.funded = bid
            .funded
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        let funded_total = bid.funded;

        let bid_key = DataKey::Bid(auction_id, bidder.clone());
        env.storage().persistent().set(&bid_key, &bid);
        Self::bump_persistent(&env, &bid_key);

        auction.escrowed = auction
            .escrowed
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        Self::put_auction(&env, &auction);

        Self::transfer_in(&env, &config.settlement_token, &bidder, amount)?;

        events::bid_funded(&env, auction_id, &bidder, funded_total, amount);
        Ok(funded_total)
    }

    /// Release escrow. Permissionless: the outcome is a pure function of the
    /// auction's terminal-time state, so anyone can trigger it.
    ///
    /// Writes exactly three ledger entries regardless of bid count — the auction,
    /// the seller's claim, and the treasury's claim. Refunds are derived lazily in
    /// `claim`.
    pub fn settle(env: Env, auction_id: u64) -> Result<Auction, Error> {
        let config = Self::load_config(&env)?;
        let mut auction = Self::load_auction(&env, auction_id)?;
        Self::advance_phase(&env, &mut auction)?;

        if matches!(
            auction.phase,
            Phase::Settled | Phase::Cancelled | Phase::Failed
        ) {
            return Err(Error::InvalidPhase);
        }
        if env.ledger().sequence() <= auction.funding_deadline {
            return Err(Error::PhaseTooEarly);
        }

        // Single bounded pass: identify the hammer price among bids that actually
        // escrowed what they bid, and total up the bonds forfeited by the ones that
        // did not. At most `Config::max_bids` iterations, reads only.
        let mut best_amount: i128 = 0;
        let mut best_bidder: Option<Address> = None;
        let mut slashed_total: i128 = 0;

        let revealed = auction.revealed.clone();
        for i in 0..revealed.len() {
            if let Some(entry) = revealed.get(i) {
                let bid = Self::load_bid(&env, auction_id, &entry.bidder)?;
                if bid.funded < entry.amount {
                    slashed_total = slashed_total
                        .checked_add(auction.bond)
                        .ok_or(Error::ArithmeticOverflow)?;
                } else if entry.amount > best_amount {
                    // Strictly greater means a tie goes to whoever revealed first,
                    // which prices the public service of opening envelopes.
                    best_amount = entry.amount;
                    best_bidder = Some(entry.bidder.clone());
                }
            }
        }

        auction.slashed = slashed_total;

        let settled = best_bidder.is_some() && best_amount >= auction.reserve_price;

        if settled {
            let winner = match best_bidder {
                Some(w) => w,
                None => return Err(Error::InvalidParam),
            };
            let hammer = best_amount;
            let fee = hammer
                .checked_mul(config.fee_bps as i128)
                .ok_or(Error::ArithmeticOverflow)?
                / 10_000;

            let seller_credit = hammer
                .checked_sub(fee)
                .ok_or(Error::ArithmeticOverflow)?
                .checked_add(auction.seller_bond)
                .ok_or(Error::ArithmeticOverflow)?
                .checked_add(slashed_total)
                .ok_or(Error::ArithmeticOverflow)?;

            auction.phase = Phase::Settled;
            auction.winner = Some(winner.clone());
            auction.hammer_price = hammer;

            Self::add_claim(&env, auction_id, &auction.seller, seller_credit)?;
            if fee > 0 {
                Self::add_claim(&env, auction_id, &config.treasury, fee)?;
            }

            events::auction_outcome(
                &env,
                auction_id,
                soroban_sdk::Symbol::new(&env, "settled"),
                Some(winner),
                hammer,
                fee,
            );
        } else {
            auction.phase = Phase::Failed;
            let seller_credit = auction
                .seller_bond
                .checked_add(slashed_total)
                .ok_or(Error::ArithmeticOverflow)?;
            Self::add_claim(&env, auction_id, &auction.seller, seller_credit)?;

            events::auction_outcome(
                &env,
                auction_id,
                soroban_sdk::Symbol::new(&env, "failed"),
                None,
                0,
                0,
            );
        }

        Self::put_auction(&env, &auction);
        Ok(auction)
    }

    /// Seller-initiated cancellation, allowed only while commits are open.
    ///
    /// After sealed bids exist the seller bond is liquidated into equal compensation
    /// for those bidders, which is what stops a seller from baiting bidders and
    /// pulling the auction once they dislike the field.
    pub fn cancel_auction(env: Env, seller: Address, auction_id: u64) -> Result<(), Error> {
        let config = Self::load_config(&env)?;
        Self::require_not_paused(&config)?;
        seller.require_auth();

        let mut auction = Self::load_auction(&env, auction_id)?;
        Self::advance_phase(&env, &mut auction)?;

        if auction.seller != seller {
            return Err(Error::Unauthorized);
        }
        if auction.phase != Phase::Sealed || env.ledger().sequence() > auction.commit_deadline {
            return Err(Error::InvalidPhase);
        }

        if auction.sealed_count == 0 {
            Self::add_claim(
                &env,
                auction_id,
                &auction.seller,
                auction.seller_bond,
            )?;
            auction.cancel_compensation = 0;
        } else {
            let count = auction.sealed_count as i128;
            let share = auction.seller_bond / count;
            let dust = auction
                .seller_bond
                .checked_sub(share.checked_mul(count).ok_or(Error::ArithmeticOverflow)?)
                .ok_or(Error::ArithmeticOverflow)?;
            auction.cancel_compensation = share;
            if dust > 0 {
                Self::add_claim(&env, auction_id, &config.treasury, dust)?;
            }
        }

        auction.phase = Phase::Cancelled;
        Self::put_auction(&env, &auction);

        events::auction_outcome(
            &env,
            auction_id,
            soroban_sdk::Symbol::new(&env, "cancelled"),
            None,
            0,
            0,
        );
        Ok(())
    }

    /// Admin escape hatch for a beacon that never arrives. Returns every bond in
    /// full, including the seller's. It moves no money that was not already escrowed
    /// and applies no penalty, so it cannot be used as a seizure.
    pub fn abort_auction(env: Env, admin: Address, auction_id: u64) -> Result<(), Error> {
        let config = Self::load_config(&env)?;
        Self::require_admin(&config, &admin)?;
        admin.require_auth();

        let mut auction = Self::load_auction(&env, auction_id)?;
        Self::advance_phase(&env, &mut auction)?;
        if matches!(
            auction.phase,
            Phase::Settled | Phase::Cancelled | Phase::Failed
        ) {
            return Err(Error::InvalidPhase);
        }

        auction.phase = Phase::Cancelled;
        auction.cancel_compensation = 0;
        Self::add_claim(&env, auction_id, &auction.seller, auction.seller_bond)?;
        Self::put_auction(&env, &auction);

        events::auction_outcome(
            &env,
            auction_id,
            soroban_sdk::Symbol::new(&env, "aborted"),
            None,
            0,
            0,
        );
        Ok(())
    }

    /// Withdraw everything owed to `claimant` from one auction.
    ///
    /// Two sources are merged: an explicit `Claim` record (seller proceeds or
    /// protocol fee, written at settlement) and the bid-derived refund, which is
    /// computed on demand so that settlement never has to touch every loser's entry.
    pub fn claim(env: Env, auction_id: u64, claimant: Address) -> Result<i128, Error> {
        let config = Self::load_config(&env)?;
        claimant.require_auth();

        let mut auction = Self::load_auction(&env, auction_id)?;
        Self::advance_phase(&env, &mut auction)?;
        if !matches!(
            auction.phase,
            Phase::Settled | Phase::Cancelled | Phase::Failed
        ) {
            return Err(Error::InvalidPhase);
        }

        let mut total: i128 = 0;
        let mut touched_bid = false;

        // Source 1: explicit claim ledger.
        let claim_key = DataKey::Claim(auction_id, claimant.clone());
        if let Some(recorded) = env
            .storage()
            .persistent()
            .get::<DataKey, i128>(&claim_key)
        {
            if recorded > 0 {
                total = total.checked_add(recorded).ok_or(Error::ArithmeticOverflow)?;
                env.storage().persistent().remove(&claim_key);
            }
        }

        // Source 2: derived refund from the claimant's own bid.
        let bid_key = DataKey::Bid(auction_id, claimant.clone());
        if let Some(mut bid) = env.storage().persistent().get::<DataKey, Bid>(&bid_key) {
            if !bid.settled {
                let derived = Self::derived_refund(&auction, &bid);
                total = total.checked_add(derived).ok_or(Error::ArithmeticOverflow)?;
                bid.settled = true;
                env.storage().persistent().set(&bid_key, &bid);
                Self::bump_persistent(&env, &bid_key);
                touched_bid = true;
            } else if total == 0 {
                return Err(Error::AlreadyWithdrawn);
            }
        } else if total == 0 {
            return Err(Error::NothingToClaim);
        }

        if total <= 0 {
            // Nothing was owed, but the bidder has now been marked settled so a
            // repeat call reports AlreadyWithdrawn rather than looping.
            if touched_bid {
                Self::put_auction(&env, &auction);
            }
            return Ok(0);
        }

        auction.escrowed = auction
            .escrowed
            .checked_sub(total)
            .ok_or(Error::ArithmeticOverflow)?;
        auction.claimed = auction
            .claimed
            .checked_add(total)
            .ok_or(Error::ArithmeticOverflow)?;
        Self::put_auction(&env, &auction);

        token::Client::new(&env, &config.settlement_token).transfer(
            &env.current_contract_address(),
            &claimant,
            &total,
        );

        events::claimed(&env, auction_id, &claimant, total);
        Ok(total)
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    pub fn get_config(env: Env) -> Result<Config, Error> {
        Self::load_config(&env)
    }

    pub fn get_auction(env: Env, auction_id: u64) -> Result<Auction, Error> {
        let mut auction = Self::load_auction(&env, auction_id)?;
        auction.phase = Self::derive_phase(&auction, env.ledger().sequence());
        Ok(auction)
    }

    pub fn auction_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::AuctionCount)
            .unwrap_or(0u64)
    }

    /// Page through auctions in creation order. `limit` is clamped to 50.
    pub fn list_auctions(env: Env, start: u64, limit: u32) -> Vec<Auction> {
        let count = Self::auction_count(env.clone());
        let capped = if limit > 50 { 50 } else { limit };
        let mut out = Vec::new(&env);
        let now_seq = env.ledger().sequence();
        let mut id = start;
        let mut taken: u32 = 0;
        while id < count && taken < capped {
            if let Some(mut auction) = env
                .storage()
                .persistent()
                .get::<DataKey, Auction>(&DataKey::Auction(id))
            {
                auction.phase = Self::derive_phase(&auction, now_seq);
                out.push_back(auction);
                taken += 1;
            }
            id += 1;
        }
        out
    }

    pub fn get_bid(env: Env, auction_id: u64, bidder: Address) -> Result<Bid, Error> {
        Self::load_bid(&env, auction_id, &bidder)
    }

    /// Page through the sealed bids of one auction via the dense bidder index.
    pub fn list_bids(
        env: Env,
        auction_id: u64,
        start: u32,
        limit: u32,
    ) -> Result<Vec<BidView>, Error> {
        let auction = Self::load_auction(&env, auction_id)?;
        let capped = if limit > 50 { 50 } else { limit };
        let mut out = Vec::new(&env);
        let mut i = start;
        let mut taken: u32 = 0;
        while i < auction.sealed_count && taken < capped {
            if let Some(bidder) = env
                .storage()
                .persistent()
                .get::<DataKey, Address>(&DataKey::BidderAt(auction_id, i))
            {
                let bid = Self::load_bid(&env, auction_id, &bidder)?;
                out.push_back(BidView::from(&bid));
                taken += 1;
            }
            i += 1;
        }
        Ok(out)
    }

    /// How much `claimant` could withdraw right now. Read-only mirror of the
    /// derivation inside `claim`, used by the UI to render a withdraw button.
    pub fn get_claimable(env: Env, auction_id: u64, claimant: Address) -> Result<i128, Error> {
        let mut auction = Self::load_auction(&env, auction_id)?;
        auction.phase = Self::derive_phase(&auction, env.ledger().sequence());
        if !matches!(
            auction.phase,
            Phase::Settled | Phase::Cancelled | Phase::Failed
        ) {
            return Ok(0);
        }

        let mut total: i128 = 0;
        if let Some(recorded) = env
            .storage()
            .persistent()
            .get::<DataKey, i128>(&DataKey::Claim(auction_id, claimant.clone()))
        {
            total += recorded;
        }
        if let Some(bid) = env
            .storage()
            .persistent()
            .get::<DataKey, Bid>(&DataKey::Bid(auction_id, claimant.clone()))
        {
            if !bid.settled {
                total += Self::derived_refund(&auction, &bid);
            }
        }
        Ok(total)
    }

    pub fn current_phase(env: Env, auction_id: u64) -> Result<Phase, Error> {
        let auction = Self::load_auction(&env, auction_id)?;
        Ok(Self::derive_phase(&auction, env.ledger().sequence()))
    }

    /// drand round that closes at or after `timestamp`.
    pub fn round_at_timestamp(env: Env, timestamp: u64) -> Result<u64, Error> {
        let config = Self::load_config(&env)?;
        Ok(Self::round_at(
            timestamp,
            config.drand_genesis,
            config.drand_period,
        ))
    }

    /// Unix timestamp at which `round` is published.
    pub fn timestamp_for_round(env: Env, round: u64) -> Result<u64, Error> {
        let config = Self::load_config(&env)?;
        Ok(Self::round_time(
            round,
            config.drand_genesis,
            config.drand_period,
        ))
    }

    /// Canonical commitment hash, exposed so a client can prove its own hashing
    /// matches the contract before it seals anything.
    pub fn hash_commitment(
        env: Env,
        auction_id: u64,
        amount: i128,
        salt: BytesN<32>,
    ) -> BytesN<32> {
        Self::bid_commitment(&env, auction_id, amount, &salt)
    }

    /// Canonical beacon digest, exposed for the same reason and for relayer tests.
    pub fn hash_beacon_digest(
        env: Env,
        auction_id: u64,
        round: u64,
        randomness: BytesN<32>,
    ) -> Result<BytesN<32>, Error> {
        let config = Self::load_config(&env)?;
        Ok(Self::beacon_digest(
            &env,
            &config.chain_hash,
            round,
            &randomness,
            auction_id,
        ))
    }

    pub fn schema_version() -> u32 {
        SCHEMA_VERSION
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), Error> {
        let mut config = Self::load_config(&env)?;
        Self::require_admin(&config, &admin)?;
        admin.require_auth();
        config.paused = paused;
        env.storage().instance().set(&DataKey::Config, &config);
        Self::bump_instance(&env);
        events::config_updated(
            &env,
            soroban_sdk::Symbol::new(&env, if paused { "paused" } else { "unpaused" }),
            &admin,
        );
        Ok(())
    }

    fn require_admin(config: &Config, admin: &Address) -> Result<(), Error> {
        if &config.admin != admin {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn require_not_paused(config: &Config) -> Result<(), Error> {
        if config.paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn load_config(env: &Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    fn load_auction(env: &Env, auction_id: u64) -> Result<Auction, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Auction(auction_id))
            .ok_or(Error::AuctionNotFound)
    }

    fn put_auction(env: &Env, auction: &Auction) {
        let key = DataKey::Auction(auction.id);
        env.storage().persistent().set(&key, auction);
        Self::bump_persistent(env, &key);
    }

    fn load_bid(env: &Env, auction_id: u64, bidder: &Address) -> Result<Bid, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Bid(auction_id, bidder.clone()))
            .ok_or(Error::BidNotFound)
    }

    fn add_claim(
        env: &Env,
        auction_id: u64,
        claimant: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Ok(());
        }
        let key = DataKey::Claim(auction_id, claimant.clone());
        let existing: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let updated = existing
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        env.storage().persistent().set(&key, &updated);
        Self::bump_persistent(env, &key);
        Ok(())
    }

    /// Time-derived phase. Terminal phases are sticky: once escrow has been
    /// released or a refund path opened, the clock must never move the auction back
    /// into an earlier phase.
    fn derive_phase(auction: &Auction, now_seq: u32) -> Phase {
        match auction.phase {
            Phase::Settled | Phase::Cancelled | Phase::Failed => auction.phase,
            _ => {
                if now_seq <= auction.commit_deadline {
                    Phase::Sealed
                } else if now_seq <= auction.reveal_deadline {
                    Phase::Reveal
                } else {
                    Phase::Funding
                }
            }
        }
    }

    /// Recompute the phase and persist it when it has moved forward.
    fn advance_phase(env: &Env, auction: &mut Auction) -> Result<(), Error> {
        let derived = Self::derive_phase(auction, env.ledger().sequence());
        if derived != auction.phase {
            auction.phase = derived;
            Self::put_auction(env, auction);
        }
        Ok(())
    }

    /// The refund owed to a bidder, given where their auction ended up.
    ///
    /// Kept as a pure function of `(auction, bid)` so that `claim` and
    /// `get_claimable` cannot drift apart.
    fn derived_refund(auction: &Auction, bid: &Bid) -> i128 {
        let is_winner = match &auction.winner {
            Some(w) => w == &bid.bidder,
            None => false,
        };

        if is_winner {
            // The winner escrowed up to (or past) the hammer price; anything above
            // it comes straight back.
            let surplus = bid.funded - auction.hammer_price;
            return if surplus > 0 { surplus } else { 0 };
        }

        match auction.phase {
            Phase::Settled | Phase::Failed => {
                if bid.revealed && bid.funded < bid.revealed_amount {
                    // Bid more than it escrowed: the bond is forfeited.
                    let rest = bid.funded - bid.bond;
                    if rest > 0 {
                        rest
                    } else {
                        0
                    }
                } else {
                    bid.funded
                }
            }
            Phase::Cancelled => {
                // A sealed bidder in a cancelled auction gets their bond plus an
                // equal share of the liquidated seller bond, if any.
                bid.funded + auction.cancel_compensation
            }
            _ => 0,
        }
    }

    fn transfer_in(
        env: &Env,
        token_id: &Address,
        from: &Address,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::NonPositiveAmount);
        }
        token::Client::new(env, token_id).transfer(from, &env.current_contract_address(), &amount);
        Ok(())
    }

    /// `sha256("subrosa.bid.v1" || auction_id || amount || salt)`.
    fn bid_commitment(
        env: &Env,
        auction_id: u64,
        amount: i128,
        salt: &BytesN<32>,
    ) -> BytesN<32> {
        let mut pre = [0u8; BID_PREIMAGE_LEN];
        pre[0..14].copy_from_slice(DOMAIN_BID);
        pre[14..22].copy_from_slice(&auction_id.to_be_bytes());
        pre[22..38].copy_from_slice(&amount.to_be_bytes());
        pre[38..70].copy_from_slice(&salt.to_array());
        env.crypto().sha256(&Bytes::from_slice(env, &pre))
    }

    /// `sha256("subrosa.beacon.v1" || chain_hash || round || randomness || auction_id)`.
    fn beacon_digest(
        env: &Env,
        chain_hash: &BytesN<32>,
        round: u64,
        randomness: &BytesN<32>,
        auction_id: u64,
    ) -> BytesN<32> {
        let mut pre = [0u8; BEACON_PREIMAGE_LEN];
        pre[0..17].copy_from_slice(DOMAIN_BEACON);
        pre[17..49].copy_from_slice(&chain_hash.to_array());
        pre[49..57].copy_from_slice(&round.to_be_bytes());
        pre[57..89].copy_from_slice(&randomness.to_array());
        pre[89..97].copy_from_slice(&auction_id.to_be_bytes());
        env.crypto().sha256(&Bytes::from_slice(env, &pre))
    }

    /// Verify an M-of-N relayer attestation over the beacon digest.
    ///
    /// Each relayer may sign at most once: the duplicate check is what stops a
    /// quorum of one from masquerading as a quorum of three.
    fn verify_attestation(
        env: &Env,
        config: &Config,
        auction_id: u64,
        round: u64,
        randomness: &BytesN<32>,
        attestation: &Vec<Signature>,
    ) -> Result<(), Error> {
        let digest = Self::beacon_digest(env, &config.chain_hash, round, randomness, auction_id);
        let message = Bytes::from_slice(env, &digest.to_array());
        let relayer_count = config.relayer_pubkeys.len();
        let supplied = attestation.len();

        if supplied < config.relayer_threshold {
            return Err(Error::AttestationInvalid);
        }

        let mut valid: u32 = 0;
        let mut seen: Vec<u32> = Vec::new(env);
        for i in 0..supplied {
            if let Some(sig) = attestation.get(i) {
                if sig.signer_index >= relayer_count {
                    return Err(Error::AttestationInvalid);
                }
                for j in 0..seen.len() {
                    if let Some(previous) = seen.get(j) {
                        if previous == sig.signer_index {
                            return Err(Error::DuplicateSigner);
                        }
                    }
                }
                seen.push_back(sig.signer_index);
                if let Some(pubkey) = config.relayer_pubkeys.get(sig.signer_index) {
                    // Traps on an invalid signature, which is the desired behaviour:
                    // a relayer that submits a bad signature simply burns its own
                    // transaction instead of producing a partial attestation.
                    env.crypto().ed25519_verify(&pubkey, &message, &sig.signature);
                    valid += 1;
                }
            }
        }

        if valid < config.relayer_threshold {
            return Err(Error::AttestationInvalid);
        }
        Ok(())
    }

    /// First drand round at or after `timestamp`.
    fn round_at(timestamp: u64, genesis: u64, period: u64) -> u64 {
        if period == 0 || timestamp <= genesis {
            return 1;
        }
        (timestamp - genesis) / period + 1
    }

    /// Unix timestamp at which `round` becomes available.
    fn round_time(round: u64, genesis: u64, period: u64) -> u64 {
        if round <= 1 {
            return genesis;
        }
        genesis + (round - 1) * period
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
    }

    fn bump_persistent(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_THRESHOLD, PERSISTENT_BUMP);
    }
}
