//! Contract test suite.
//!
//! The two `golden_*` tests at the top are the load-bearing ones. They pin the
//! exact byte layout of the commitment preimage and the beacon digest, and the
//! backend's TypeScript mirrors both encodings byte for byte. If either side drifts,
//! a test fails here instead of production producing bids that nobody can open.

use crate::errors::Error;
use crate::types::*;
use crate::{SubRosaEscrow, SubRosaEscrowClient};
use ed25519_dalek::SigningKey;
use soroban_sdk::testutils::ed25519::Signer;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Bytes, BytesN, Env, Vec};

const HEX: &[u8; 16] = b"0123456789abcdef";

/// quicknet — the only chain the protocol will accept beacons from.
const QUICKNET_CHAIN_HASH: &str =
    "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

const GOLDEN_AUCTION_ID: u64 = 42;
const GOLDEN_AMOUNT: i128 = 1_500_000;
const GOLDEN_SALT_HEX: &str = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
const GOLDEN_ROUND: u64 = 1_000;
const GOLDEN_RANDOMNESS_HEX: &str =
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/// Produced with `node:crypto` from the documented preimage layouts, and shared
/// verbatim with `backend/src/__tests__/fixtures/golden-vectors.json`.
const GOLDEN_BID_COMMITMENT: &str =
    "6e0f4a6196ddee2b1985fb24cc35757167ae8b5ed8b07528dde5a7db227ce66f";
const GOLDEN_BEACON_DIGEST: &str =
    "15a00e8ed831253df0f37aa4d4de8dfc0e75821dace0ba5b04815373d60eb575";

const DRAND_GENESIS: u64 = 1_700_000_000;
const DRAND_PERIOD: u64 = 3;
const ASSUMED_LEDGER_SECONDS: u64 = 5;
const MARGIN_ROUNDS: u64 = 10;
const FEE_BPS: u32 = 100;
const BOND: i128 = 50_000;
const SELLER_BOND: i128 = 200_000;
const RESERVE: i128 = 1_000_000;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Harness {
    env: Env,
    contract_id: Address,
    token_id: Address,
    admin: Address,
    treasury: Address,
    seller: Address,
    relayers: std::vec::Vec<SigningKey>,
}

impl Harness {
    fn client(&self) -> SubRosaEscrowClient<'_> {
        SubRosaEscrowClient::new(&self.env, &self.contract_id)
    }

    fn fund(&self, who: &Address, amount: i128) {
        token::StellarAssetClient::new(&self.env, &self.token_id).mint(who, &amount);
    }

    fn balance(&self, who: &Address) -> i128 {
        token::Client::new(&self.env, &self.token_id).balance(who)
    }

    fn warp(&self, sequence: u32, timestamp: u64) {
        self.env.ledger().set_sequence_number(sequence);
        self.env.ledger().set_timestamp(timestamp);
    }

    fn salt(&self) -> BytesN<32> {
        b32(&self.env, GOLDEN_SALT_HEX)
    }

    fn envelope(&self) -> Bytes {
        Bytes::from_slice(&self.env, b"age-encrypted-envelope-placeholder")
    }

    /// Seal a bid whose commitment actually opens to `amount`.
    fn seal_revealable(
        &self,
        auction_id: u64,
        bidder: &Address,
        amount: i128,
        envelope: &Bytes,
    ) -> BytesN<32> {
        let commitment = self
            .client()
            .hash_commitment(&auction_id, &amount, &self.salt());
        self.client().seal_bid(
            auction_id,
            bidder,
            &commitment,
            &self.env.crypto().sha256(envelope),
        );
        commitment
    }

    /// Seal with an arbitrary commitment, for tests that never reveal.
    fn seal_opaque(&self, auction_id: u64, bidder: &Address) {
        self.client().seal_bid(
            &auction_id,
            bidder,
            &BytesN::from_array(&self.env, &[0u8; 32]),
            &self.env.crypto().sha256(&self.envelope()),
        );
    }

    fn attest(&self, auction_id: u64, round: u64, randomness: &BytesN<32>, count: usize) -> Vec<Signature> {
        let digest = self
            .client()
            .hash_beacon_digest(&auction_id, &round, randomness);
        let mut out = Vec::new(&self.env);
        for (i, key) in self.relayers.iter().enumerate().take(count) {
            out.push_back(Signature {
                signer_index: i as u32,
                signature: key.sign(&digest.to_array()),
            });
        }
        out
    }

    fn default_params() -> AuctionParams {
        AuctionParams {
            reserve_price: RESERVE,
            bond: BOND,
            seller_bond: SELLER_BOND,
            commit_window_ledgers: 100,
            reveal_window_ledgers: 100,
            funding_window_ledgers: 100,
        }
    }
}

fn b32(env: &Env, hex: &str) -> BytesN<32> {
    let bytes = hex.as_bytes();
    assert_eq!(bytes.len(), 64, "expected 32-byte hex");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = (hex_nibble(bytes[i * 2]) << 4) | hex_nibble(bytes[i * 2 + 1]);
    }
    BytesN::from_array(env, &out)
}

fn hex_nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("invalid hex digit"),
    }
}

fn to_hex(value: &BytesN<32>) -> std::string::String {
    let mut out = std::string::String::with_capacity(64);
    for byte in value.to_array().iter() {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let seller = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    // Three relayers with a 2-of-3 quorum.
    let relayers: std::vec::Vec<SigningKey> =
        (1u8..=3).map(|i| SigningKey::from_bytes(&[i; 32])).collect();
    let mut pubkeys = Vec::new(&env);
    for key in relayers.iter() {
        pubkeys.push_back(BytesN::from_array(&env, &key.verifying_key().to_bytes()));
    }

    let contract_id = env.register(SubRosaEscrow, ());
    let client = SubRosaEscrowClient::new(&env, &contract_id);

    env.ledger().set_sequence_number(1_000);
    env.ledger().set_timestamp(DRAND_GENESIS);

    client.initialize(
        &admin,
        &token_id,
        &treasury,
        &7u32,
        &FEE_BPS,
        &pubkeys,
        &2u32,
        &b32(&env, QUICKNET_CHAIN_HASH),
        &DRAND_GENESIS,
        &DRAND_PERIOD,
        &ASSUMED_LEDGER_SECONDS,
        &MARGIN_ROUNDS,
        &64u32,
        &1_000i128,
        &10u32,
    );

    Harness {
        env,
        contract_id,
        token_id,
        admin,
        treasury,
        seller,
        relayers,
    }
}

fn open_auction(h: &Harness) -> u64 {
    h.fund(&h.seller, 10_000_000);
    h.client()
        .create_auction(&h.seller, &Harness::default_params())
}

/// Ledger sequence and timestamp at which the beacon for `auction` is published.
fn reveal_moment(h: &Harness, auction_id: u64) -> (u32, u64, u64) {
    let auction = h.client().get_auction(&auction_id);
    let published_at = DRAND_GENESIS + (auction.reveal_round - 1) * DRAND_PERIOD;
    (auction.commit_deadline + 1, published_at + 1, auction.reveal_round)
}

/// Move to the reveal phase and record the beacon.
fn enter_reveal(h: &Harness, auction_id: u64) -> BytesN<32> {
    let (seq, ts, round) = reveal_moment(h, auction_id);
    h.warp(seq, ts);
    let randomness = b32(&h.env, GOLDEN_RANDOMNESS_HEX);
    h.client().attest_beacon(
        &auction_id,
        &round,
        &randomness,
        &h.attest(auction_id, round, &randomness, 2),
    );
    randomness
}

// ---------------------------------------------------------------------------
// Golden vectors
// ---------------------------------------------------------------------------

#[test]
fn golden_bid_commitment_encoding_is_stable() {
    let env = Env::default();
    let contract_id = env.register(SubRosaEscrow, ());
    let client = SubRosaEscrowClient::new(&env, &contract_id);

    let commitment = client.hash_commitment(
        &GOLDEN_AUCTION_ID,
        &GOLDEN_AMOUNT,
        &b32(&env, GOLDEN_SALT_HEX),
    );

    assert_eq!(
        to_hex(&commitment),
        GOLDEN_BID_COMMITMENT,
        "commitment preimage layout drifted; the TypeScript mirror will disagree"
    );
}

#[test]
fn golden_beacon_digest_encoding_is_stable() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let contract_id = env.register(SubRosaEscrow, ());
    let client = SubRosaEscrowClient::new(&env, &contract_id);

    let mut pubkeys = Vec::new(&env);
    pubkeys.push_back(BytesN::from_array(&env, &[1u8; 32]));

    client.initialize(
        &admin,
        &sac.address(),
        &admin,
        &7u32,
        &FEE_BPS,
        &pubkeys,
        &1u32,
        &b32(&env, QUICKNET_CHAIN_HASH),
        &DRAND_GENESIS,
        &DRAND_PERIOD,
        &ASSUMED_LEDGER_SECONDS,
        &MARGIN_ROUNDS,
        &64u32,
        &1_000i128,
        &10u32,
    );

    let digest = client.hash_beacon_digest(
        &GOLDEN_AUCTION_ID,
        &GOLDEN_ROUND,
        &b32(&env, GOLDEN_RANDOMNESS_HEX),
    );

    assert_eq!(
        to_hex(&digest),
        GOLDEN_BEACON_DIGEST,
        "beacon digest layout drifted; relayer signatures will stop verifying"
    );
}

// ---------------------------------------------------------------------------
// Initialisation and creation
// ---------------------------------------------------------------------------

#[test]
fn initialize_rejects_a_bad_quorum_or_fee_and_is_one_shot() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let contract_id = env.register(SubRosaEscrow, ());
    let client = SubRosaEscrowClient::new(&env, &contract_id);

    let mut pubkeys = Vec::new(&env);
    pubkeys.push_back(BytesN::from_array(&env, &[1u8; 32]));

    let base = |fee: u32, threshold: u32| {
        client.try_initialize(
            &admin,
            &sac.address(),
            &admin,
            &7u32,
            &fee,
            &pubkeys,
            &threshold,
            &b32(&env, QUICKNET_CHAIN_HASH),
            &DRAND_GENESIS,
            &DRAND_PERIOD,
            &ASSUMED_LEDGER_SECONDS,
            &MARGIN_ROUNDS,
            &64u32,
            &1_000i128,
            &10u32,
        )
    };

    assert_eq!(base(1_001, 1), Err(Ok(Error::FeesExceedMax)));
    assert_eq!(base(FEE_BPS, 2), Err(Ok(Error::ThresholdNotConfigured)));
    assert_eq!(base(FEE_BPS, 0), Err(Ok(Error::ThresholdNotConfigured)));
    assert_eq!(base(FEE_BPS, 1), Ok(Ok(())));
    // A second call must not be able to re-point the protocol at a different chain.
    assert_eq!(base(FEE_BPS, 1), Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn create_auction_derives_a_reveal_round_that_is_still_secret_at_close() {
    let h = setup();
    let auction_id = open_auction(&h);
    let auction = h.client().get_auction(&auction_id);

    assert_eq!(auction.phase, Phase::Sealed);
    assert_eq!(auction.commit_deadline, 1_100);
    assert_eq!(auction.reveal_deadline, 1_200);
    assert_eq!(auction.funding_deadline, 1_300);

    // 100 ledgers * 5s = 500s of commit window, plus the jitter margin.
    let est_commit_ts = DRAND_GENESIS + 500;
    let expected_round = (est_commit_ts - DRAND_GENESIS) / DRAND_PERIOD + 1 + MARGIN_ROUNDS;
    assert_eq!(auction.reveal_round, expected_round);

    // The property that actually matters: the beacon cannot exist while commits
    // are still open, so no bid can be unsealed early.
    let published_at = DRAND_GENESIS + (auction.reveal_round - 1) * DRAND_PERIOD;
    assert!(published_at > est_commit_ts);
}

#[test]
fn seller_bond_is_escrowed_and_the_seller_cannot_bid() {
    let h = setup();
    let auction_id = open_auction(&h);
    assert_eq!(h.client().get_auction(&auction_id).escrowed, SELLER_BOND);
    assert_eq!(h.balance(&h.seller), 10_000_000 - SELLER_BOND);

    assert_eq!(
        h.client().try_seal_bid(
            &auction_id,
            &h.seller,
            &BytesN::from_array(&h.env, &[0u8; 32]),
            &h.env.crypto().sha256(&h.envelope())
        ),
        Err(Ok(Error::SellerCannotBid))
    );
}

#[test]
fn a_bidder_cannot_seal_twice() {
    let h = setup();
    let auction_id = open_auction(&h);
    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 500_000);
    h.seal_opaque(auction_id, &bidder);

    assert_eq!(
        h.client().try_seal_bid(
            &auction_id,
            &bidder,
            &BytesN::from_array(&h.env, &[0u8; 32]),
            &h.env.crypto().sha256(&h.envelope())
        ),
        Err(Ok(Error::BidExists))
    );
}

#[test]
fn bid_cap_is_enforced() {
    let h = setup();
    let auction_id = open_auction(&h);

    for _ in 0..64 {
        let bidder = Address::generate(&h.env);
        h.fund(&bidder, 100_000);
        h.seal_opaque(auction_id, &bidder);
    }

    let late = Address::generate(&h.env);
    h.fund(&late, 100_000);
    assert_eq!(
        h.client().try_seal_bid(
            &auction_id,
            &late,
            &BytesN::from_array(&h.env, &[0u8; 32]),
            &h.env.crypto().sha256(&h.envelope())
        ),
        Err(Ok(Error::BidCapReached))
    );
}

#[test]
fn sealing_closes_with_the_commit_deadline() {
    let h = setup();
    let auction_id = open_auction(&h);
    let auction = h.client().get_auction(&auction_id);
    h.warp(auction.commit_deadline + 1, DRAND_GENESIS + 600);

    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 100_000);
    assert_eq!(
        h.client().try_seal_bid(
            &auction_id,
            &bidder,
            &BytesN::from_array(&h.env, &[0u8; 32]),
            &h.env.crypto().sha256(&h.envelope())
        ),
        Err(Ok(Error::InvalidPhase))
    );
}

#[test]
fn bond_below_the_protocol_floor_is_rejected() {
    let h = setup();
    let params = AuctionParams {
        bond: 999, // floor is 1_000
        ..Harness::default_params()
    };
    assert_eq!(
        h.client().try_create_auction(&h.seller, &params),
        Err(Ok(Error::InvalidBond))
    );
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

#[test]
fn reveal_requires_the_beacon_to_be_attested_first() {
    let h = setup();
    let auction_id = open_auction(&h);
    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 1_000_000);
    let envelope = h.envelope();
    h.seal_revealable(auction_id, &bidder, 750_000, &envelope);

    let (seq, ts, _) = reveal_moment(&h, auction_id);
    h.warp(seq, ts);

    assert_eq!(
        h.client().try_reveal_bid(&auction_id, &bidder, &750_000i128, &h.salt(), &envelope),
        Err(Ok(Error::BeaconUnavailable))
    );
}

#[test]
fn reveal_rejects_a_wrong_opening_or_a_swapped_envelope() {
    let h = setup();
    let auction_id = open_auction(&h);
    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 1_000_000);

    let amount = 750_000i128;
    let envelope = h.envelope();
    h.seal_revealable(auction_id, &bidder, amount, &envelope);
    enter_reveal(&h, auction_id);

    // A substituted envelope is caught by the envelope hash.
    let impostor = Bytes::from_slice(&h.env, b"a-swapped-envelope");
    assert_eq!(
        h.client()
            .try_reveal_bid(&auction_id, &bidder, &amount, &h.salt(), &impostor),
        Err(Ok(Error::EnvelopeHashMismatch))
    );

    // Lying about the amount is caught by the commitment.
    assert_eq!(
        h.client()
            .try_reveal_bid(&auction_id, &bidder, &800_000i128, &h.salt(), &envelope),
        Err(Ok(Error::CommitmentMismatch))
    );

    // So is a different salt.
    let other_salt = b32(&h.env, GOLDEN_RANDOMNESS_HEX);
    assert_eq!(
        h.client()
            .try_reveal_bid(&auction_id, &bidder, &amount, &other_salt, &envelope),
        Err(Ok(Error::CommitmentMismatch))
    );

    // The honest opening is accepted.
    assert_eq!(
        h.client()
            .reveal_bid(&auction_id, &bidder, &amount, &h.salt(), &envelope),
        amount
    );
    assert_eq!(
        h.client().get_bid(&auction_id, &bidder).revealed_amount,
        amount
    );
    // And cannot be replayed.
    assert_eq!(
        h.client()
            .try_reveal_bid(&auction_id, &bidder, &amount, &h.salt(), &envelope),
        Err(Ok(Error::AlreadyRevealed))
    );
}

#[test]
fn reveal_is_permissionless() {
    let h = setup();
    let auction_id = open_auction(&h);
    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 1_000_000);
    let amount = 750_000i128;
    let envelope = h.envelope();
    h.seal_revealable(auction_id, &bidder, amount, &envelope);
    enter_reveal(&h, auction_id);

    // Anyone with the envelope and its opening can unseal it. That is the whole
    // reason a sealed bid is binding: the bidder cannot decline to reveal.
    h.client()
        .reveal_bid(&auction_id, &bidder, &amount, &h.salt(), &envelope);

    let bid = h.client().get_bid(&auction_id, &bidder);
    assert!(bid.revealed);
    assert_eq!(h.client().get_auction(&auction_id).revealed_count, 1);
}

#[test]
fn revealing_a_bid_that_was_never_sealed_fails() {
    let h = setup();
    let auction_id = open_auction(&h);
    enter_reveal(&h, auction_id);
    let stranger = Address::generate(&h.env);
    assert_eq!(
        h.client()
            .try_reveal_bid(&auction_id, &stranger, &1_000i128, &h.salt(), &h.envelope()),
        Err(Ok(Error::BidNotFound))
    );
}

// ---------------------------------------------------------------------------
// Attestation quorum
// ---------------------------------------------------------------------------

#[test]
fn an_attestation_below_threshold_is_rejected() {
    let h = setup();
    let auction_id = open_auction(&h);
    let (seq, ts, round) = reveal_moment(&h, auction_id);
    h.warp(seq, ts);

    let randomness = b32(&h.env, GOLDEN_RANDOMNESS_HEX);
    let thin = h.attest(auction_id, round, &randomness, 1); // threshold is 2
    assert_eq!(
        h.client()
            .try_attest_beacon(&auction_id, &round, &randomness, &thin),
        Err(Ok(Error::AttestationInvalid))
    );
}

#[test]
fn duplicate_signers_cannot_fake_a_quorum() {
    let h = setup();
    let auction_id = open_auction(&h);
    let (seq, ts, round) = reveal_moment(&h, auction_id);
    h.warp(seq, ts);

    let randomness = b32(&h.env, GOLDEN_RANDOMNESS_HEX);
    let digest = h.client().hash_beacon_digest(&auction_id, &round, &randomness);

    let mut doubled = Vec::new(&h.env);
    for _ in 0..2 {
        doubled.push_back(Signature {
            signer_index: 0,
            signature: h.relayers[0].sign(&digest.to_array()),
        });
    }

    assert_eq!(
        h.client()
            .try_attest_beacon(&auction_id, &round, &randomness, &doubled),
        Err(Ok(Error::DuplicateSigner))
    );
}

#[test]
fn an_attestation_for_the_wrong_round_is_rejected() {
    let h = setup();
    let auction_id = open_auction(&h);
    let (seq, ts, round) = reveal_moment(&h, auction_id);
    h.warp(seq, ts);

    let randomness = b32(&h.env, GOLDEN_RANDOMNESS_HEX);
    let wrong_round = round + 1;
    let attestation = h.attest(auction_id, wrong_round, &randomness, 3);
    assert_eq!(
        h.client()
            .try_attest_beacon(&auction_id, &wrong_round, &randomness, &attestation),
        Err(Ok(Error::AttestationRoundMismatch))
    );
}

#[test]
fn a_beacon_can_only_be_recorded_once() {
    let h = setup();
    let auction_id = open_auction(&h);
    let randomness = enter_reveal(&h, auction_id);
    let (_, _, round) = reveal_moment(&h, auction_id);

    assert_eq!(
        h.client().try_attest_beacon(
            &auction_id,
            &round,
            &randomness,
            &h.attest(auction_id, round, &randomness, 2)
        ),
        Err(Ok(Error::AlreadyRevealed))
    );
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

struct Settled {
    auction_id: u64,
    winner: Address,
    loser: Address,
    underfunded: Address,
}

/// A fully-revealed auction: a funded winner, a funded loser, and a bid that was
/// revealed above its escrow (so its bond is forfeited). Then settle it.
fn settle_fixture(h: &Harness) -> Settled {
    let auction_id = open_auction(h);

    let winner = Address::generate(&h.env);
    let loser = Address::generate(&h.env);
    let underfunded = Address::generate(&h.env);
    for who in [&winner, &loser, &underfunded] {
        h.fund(who, 5_000_000);
    }

    let plan: [(Address, i128, i128); 3] = [
        (winner.clone(), 1_500_000, 1_500_000),
        (loser.clone(), 900_000, 900_000),
        (underfunded.clone(), 1_100_000, BOND),
    ];

    let envelope = h.envelope();
    for (bidder, amount, _) in plan.iter() {
        h.seal_revealable(auction_id, bidder, *amount, &envelope);
    }

    enter_reveal(&h, auction_id);

    for (bidder, amount, _) in plan.iter() {
        h.client()
            .reveal_bid(&auction_id, bidder, amount, &h.salt(), &envelope);
    }

    // Top up to the revealed amount. The under-funded bidder does not, which is
    // exactly what the slashing rule is for.
    for (bidder, _, target) in plan.iter() {
        let top_up = target - BOND;
        if top_up > 0 {
            h.client().fund_bid(&auction_id, bidder, &top_up);
        }
    }

    let auction = h.client().get_auction(&auction_id);
    h.warp(auction.funding_deadline + 1, DRAND_GENESIS + 100_000);
    h.client().settle(&auction_id);

    Settled {
        auction_id,
        winner,
        loser,
        underfunded,
    }
}

#[test]
fn settlement_awards_the_highest_funded_bid_and_conserves_every_unit() {
    let h = setup();
    let s = settle_fixture(&h);

    let auction = h.client().get_auction(&s.auction_id);
    assert_eq!(auction.phase, Phase::Settled);
    assert_eq!(auction.winner, Some(s.winner.clone()));
    assert_eq!(auction.hammer_price, 1_500_000);
    assert_eq!(auction.slashed, BOND);
    assert_eq!(auction.revealed_count, 3);
    // The unfunded 1_100_000 bid loses to the funded 1_500_000 one; it does not
    // become the hammer merely for being the second highest.
    assert_eq!(auction.winner.as_ref(), Some(&s.winner));

    let held: i128 = SELLER_BOND + 1_500_000 + 900_000 + BOND;
    assert_eq!(auction.escrowed, held);

    let fee = 15_000i128; // 100 bps of 1_500_000
    let seller_credit = 1_500_000 - fee + SELLER_BOND + BOND; // 1_735_000

    let seller_before = h.balance(&h.seller);
    let treasury_before = h.balance(&h.treasury);
    let winner_before = h.balance(&s.winner);
    let loser_before = h.balance(&s.loser);
    let under_before = h.balance(&s.underfunded);

    assert_eq!(h.client().claim(&s.auction_id, &h.seller), seller_credit);
    assert_eq!(h.client().claim(&s.auction_id, &h.treasury), fee);
    // Funded to exactly the hammer price, so no surplus comes back.
    assert_eq!(h.client().get_claimable(&s.auction_id, &s.winner), 0);
    assert_eq!(h.client().claim(&s.auction_id, &s.winner), 0);
    assert_eq!(h.client().claim(&s.auction_id, &s.loser), 900_000);
    // Revealed 1_100_000 having escrowed only the 50_000 bond: bond forfeit.
    assert_eq!(h.client().get_claimable(&s.auction_id, &s.underfunded), 0);
    assert_eq!(h.client().claim(&s.auction_id, &s.underfunded), 0);

    assert_eq!(h.balance(&h.seller), seller_before + seller_credit);
    assert_eq!(h.balance(&h.treasury), treasury_before + fee);
    assert_eq!(h.balance(&s.loser), loser_before + 900_000);
    assert_eq!(h.balance(&s.winner), winner_before);
    assert_eq!(h.balance(&s.underfunded), under_before);

    // Nothing stranded, and every unit that went in came back out.
    assert_eq!(h.client().get_auction(&s.auction_id).escrowed, 0);
    assert_eq!(h.client().get_auction(&s.auction_id).claimed, held);
}

#[test]
fn over_funding_the_winning_bid_returns_the_surplus() {
    let h = setup();
    let auction_id = open_auction(&h);

    let winner = Address::generate(&h.env);
    h.fund(&winner, 5_000_000);
    let amount = 1_200_000i128;
    let envelope = h.envelope();
    h.seal_revealable(auction_id, &winner, amount, &envelope);
    enter_reveal(&h, auction_id);
    h.client()
        .reveal_bid(&auction_id, &winner, &amount, &h.salt(), &envelope);
    // Escrow 300_000 more than the bid.
    h.client().fund_bid(&auction_id, &winner, &(amount - BOND + 300_000));

    let auction = h.client().get_auction(&auction_id);
    h.warp(auction.funding_deadline + 1, DRAND_GENESIS + 100_000);
    h.client().settle(&auction_id);

    let before = h.balance(&winner);
    assert_eq!(
        h.client().get_claimable(&auction_id, &winner),
        300_000,
        "surplus above the hammer price must be refundable"
    );
    assert_eq!(h.client().claim(&auction_id, &winner), 300_000);
    assert_eq!(h.balance(&winner), before + 300_000);

    // Seller still only gets the hammer price net of fee.
    assert_eq!(
        h.client().claim(&auction_id, &h.seller),
        1_200_000 - 12_000 + SELLER_BOND
    );
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn claims_are_single_shot() {
    let h = setup();
    let s = settle_fixture(&h);
    assert_eq!(h.client().claim(&s.auction_id, &s.loser), 900_000);
    assert_eq!(
        h.client().try_claim(&s.auction_id, &s.loser),
        Err(Ok(Error::AlreadyWithdrawn))
    );
}

#[test]
fn settle_is_rejected_before_the_funding_window_closes() {
    let h = setup();
    let auction_id = open_auction(&h);
    enter_reveal(&h, auction_id);
    assert_eq!(
        h.client().try_settle(&auction_id),
        Err(Ok(Error::PhaseTooEarly))
    );
}

#[test]
fn settle_is_rejected_once_an_auction_is_terminal() {
    let h = setup();
    let s = settle_fixture(&h);
    assert_eq!(
        h.client().try_settle(&s.auction_id),
        Err(Ok(Error::InvalidPhase))
    );
}

#[test]
fn a_closed_auction_cannot_be_settled_before_it_opens() {
    let h = setup();
    let auction_id = open_auction(&h);
    // Still in the sealed phase.
    assert_eq!(
        h.client().try_settle(&auction_id),
        Err(Ok(Error::PhaseTooEarly))
    );
}

#[test]
fn reserve_not_met_fails_the_auction_and_refunds_everyone() {
    let h = setup();
    let auction_id = open_auction(&h);

    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 1_000_000);
    let amount = 400_000i128; // below the 1_000_000 reserve
    let envelope = h.envelope();
    h.seal_revealable(auction_id, &bidder, amount, &envelope);
    enter_reveal(&h, auction_id);
    h.client()
        .reveal_bid(&auction_id, &bidder, &amount, &h.salt(), &envelope);
    h.client().fund_bid(&auction_id, &bidder, &(amount - BOND));

    let auction = h.client().get_auction(&auction_id);
    h.warp(auction.funding_deadline + 1, DRAND_GENESIS + 100_000);
    let settled = h.client().settle(&auction_id);

    assert_eq!(settled.phase, Phase::Failed);
    assert_eq!(settled.winner, None);
    assert_eq!(settled.slashed, 0, "a funded bid is never slashed by the reserve");

    let seller_before = h.balance(&h.seller);
    let bidder_before = h.balance(&bidder);
    assert_eq!(h.client().claim(&auction_id, &h.seller), SELLER_BOND);
    assert_eq!(h.client().claim(&auction_id, &bidder), amount);
    assert_eq!(h.balance(&h.seller), seller_before + SELLER_BOND);
    assert_eq!(h.balance(&bidder), bidder_before + amount);
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn an_auction_with_no_bids_at_all_fails_cleanly() {
    let h = setup();
    let auction_id = open_auction(&h);
    enter_reveal(&h, auction_id);
    let auction = h.client().get_auction(&auction_id);
    h.warp(auction.funding_deadline + 1, DRAND_GENESIS + 100_000);

    let settled = h.client().settle(&auction_id);
    assert_eq!(settled.phase, Phase::Failed);
    assert_eq!(settled.escrowed, SELLER_BOND);
    assert_eq!(h.client().claim(&auction_id, &h.seller), SELLER_BOND);
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn an_unrevealed_sealed_bid_is_refunded_in_full() {
    let h = setup();
    let auction_id = open_auction(&h);
    let quiet = Address::generate(&h.env);
    h.fund(&quiet, 500_000);
    h.seal_opaque(auction_id, &quiet);

    enter_reveal(&h, auction_id);
    let auction = h.client().get_auction(&auction_id);
    h.warp(auction.funding_deadline + 1, DRAND_GENESIS + 100_000);
    h.client().settle(&auction_id);

    // Never revealed, so the bond was never at risk.
    assert_eq!(h.client().claim(&auction_id, &quiet), BOND);
    assert_eq!(h.balance(&quiet), 500_000);
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn everyone_can_fund_their_own_bid() {
    let h = setup();
    let auction_id = open_auction(&h);
    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 1_000_000);
    let amount = 700_000i128;
    let envelope = h.envelope();
    h.seal_revealable(auction_id, &bidder, amount, &envelope);
    enter_reveal(&h, auction_id);

    // Funding a still-sealed bid is rejected.
    assert_eq!(
        h.client().try_fund_bid(&auction_id, &bidder, &100_000i128),
        Err(Ok(Error::BidNotRevealed))
    );

    h.client()
        .reveal_bid(&auction_id, &bidder, &amount, &h.salt(), &envelope);
    assert_eq!(
        h.client().fund_bid(&auction_id, &bidder, &(amount - BOND)),
        amount
    );
    assert_eq!(h.client().get_bid(&auction_id, &bidder).funded, amount);
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

#[test]
fn cancelling_without_bids_returns_the_whole_seller_bond() {
    let h = setup();
    let auction_id = open_auction(&h);
    let before = h.balance(&h.seller);

    h.client().cancel_auction(&h.seller, &auction_id);
    assert_eq!(h.client().get_auction(&auction_id).phase, Phase::Cancelled);
    assert_eq!(h.client().claim(&auction_id, &h.seller), SELLER_BOND);
    assert_eq!(h.balance(&h.seller), before + SELLER_BOND);
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn cancelling_with_bids_liquidates_the_seller_bond_to_bidders() {
    let h = setup();
    let auction_id = open_auction(&h);

    let bidders: std::vec::Vec<Address> =
        (0..4).map(|_| Address::generate(&h.env)).collect();
    for bidder in bidders.iter() {
        h.fund(bidder, 100_000);
        h.seal_opaque(auction_id, bidder);
    }

    h.client().cancel_auction(&h.seller, &auction_id);
    let auction = h.client().get_auction(&auction_id);
    assert_eq!(auction.phase, Phase::Cancelled);
    // 200_000 seller bond / 4 bidders, no dust.
    assert_eq!(auction.cancel_compensation, 50_000);

    let seller_before = h.balance(&h.seller);
    assert_eq!(h.client().get_claimable(&auction_id, &h.seller), 0);
    assert_eq!(
        h.client().try_claim(&auction_id, &h.seller),
        Err(Ok(Error::NothingToClaim)),
        "a seller who griefed their bidders gets nothing back"
    );
    assert_eq!(h.balance(&h.seller), seller_before);

    for bidder in bidders.iter() {
        // Bond plus the equal compensation share.
        assert_eq!(h.client().claim(&auction_id, bidder), 100_000);
    }
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn cancelling_with_an_indivisible_bond_sends_the_dust_to_the_treasury() {
    let h = setup();
    let params = AuctionParams {
        seller_bond: 200_001,
        ..Harness::default_params()
    };
    h.fund(&h.seller, 10_000_000);
    let auction_id = h.client().create_auction(&h.seller, &params);

    let bidders: std::vec::Vec<Address> =
        (0..4).map(|_| Address::generate(&h.env)).collect();
    for bidder in bidders.iter() {
        h.fund(bidder, 100_000);
        h.seal_opaque(auction_id, bidder);
    }
    h.client().cancel_auction(&h.seller, &auction_id);

    let auction = h.client().get_auction(&auction_id);
    assert_eq!(auction.cancel_compensation, 50_000);
    // 200_001 - 4 * 50_000 = 1 unit of dust, kept by the protocol rather than lost.
    assert_eq!(h.client().claim(&auction_id, &h.treasury), 1);

    // 4 bonds (4 * 50_000) + the seller bond (200_001) must come back out exactly.
    let mut total = 1i128;
    for bidder in bidders.iter() {
        total += h.client().claim(&auction_id, bidder);
    }
    assert_eq!(total, 4 * BOND + 200_001);
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn cancelling_is_rejected_once_commits_close() {
    let h = setup();
    let auction_id = open_auction(&h);
    let auction = h.client().get_auction(&auction_id);
    h.warp(auction.commit_deadline + 1, DRAND_GENESIS + 600);
    assert_eq!(
        h.client().try_cancel_auction(&h.seller, &auction_id),
        Err(Ok(Error::InvalidPhase))
    );
}

#[test]
fn a_non_seller_cannot_cancel() {
    let h = setup();
    let auction_id = open_auction(&h);
    let impostor = Address::generate(&h.env);
    assert_eq!(
        h.client().try_cancel_auction(&impostor, &auction_id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn admin_abort_refunds_bonds_without_penalty() {
    let h = setup();
    let auction_id = open_auction(&h);
    let bidder = Address::generate(&h.env);
    h.fund(&bidder, 100_000);
    h.seal_opaque(auction_id, &bidder);

    h.client().abort_auction(&h.admin, &auction_id);
    assert_eq!(h.client().get_auction(&auction_id).phase, Phase::Cancelled);
    assert_eq!(h.client().claim(&auction_id, &bidder), BOND);
    assert_eq!(h.client().claim(&auction_id, &h.seller), SELLER_BOND);
    assert_eq!(h.client().get_auction(&auction_id).escrowed, 0);
}

#[test]
fn only_the_admin_can_abort() {
    let h = setup();
    let auction_id = open_auction(&h);
    assert_eq!(
        h.client().try_abort_auction(&h.seller, &auction_id),
        Err(Ok(Error::Unauthorized))
    );
}

// ---------------------------------------------------------------------------
// Pause semantics
// ---------------------------------------------------------------------------

#[test]
fn pause_blocks_new_exposure_but_never_blocks_exits() {
    let h = setup();
    let s = settle_fixture(&h);
    h.client().pause(&h.admin);

    assert_eq!(
        h.client()
            .try_create_auction(&h.seller, &Harness::default_params()),
        Err(Ok(Error::Paused))
    );

    // Exits keep working, which is the entire point of splitting pause from
    // fund-safety.
    assert_eq!(h.client().claim(&s.auction_id, &s.loser), 900_000);
    assert_eq!(h.client().claim(&s.auction_id, &h.seller), 1_735_000);

    h.client().unpause(&h.admin);
    assert!(h.client()
        .try_create_auction(&h.seller, &Harness::default_params())
        .is_ok());
}

#[test]
fn admin_rotation_is_guarded() {
    let h = setup();
    let impostor = Address::generate(&h.env);
    assert_eq!(
        h.client().try_set_fee_bps(&impostor, &200u32),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(h.client().set_fee_bps(&h.admin, &200u32), Ok(()));
    assert_eq!(h.client().get_config().fee_bps, 200);
    assert_eq!(
        h.client().try_set_fee_bps(&h.admin, &1_001u32),
        Err(Ok(Error::FeesExceedMax))
    );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

#[test]
fn list_views_page_correctly() {
    let h = setup();
    h.fund(&h.seller, 10_000_000);
    for _ in 0..3 {
        h.client()
            .create_auction(&h.seller, &Harness::default_params());
    }
    assert_eq!(h.client().auction_count(), 3);
    assert_eq!(h.client().list_auctions(&0u64, &50u32).len(), 3);
    assert_eq!(h.client().list_auctions(&1u64, &50u32).len(), 2);
    assert_eq!(h.client().list_auctions(&0u64, &2u32).len(), 2);

    for _ in 0..3 {
        let bidder = Address::generate(&h.env);
        h.fund(&bidder, 100_000);
        h.seal_opaque(0u64, &bidder);
    }
    assert_eq!(h.client().list_bids(&0u64, &0u32, &50u32).len(), 3);
    assert_eq!(h.client().list_bids(&0u64, &2u32, &50u32).len(), 1);
    assert_eq!(h.client().list_bids(&0u64, &0u32, &2u32).len(), 2);
}

#[test]
fn phase_advances_with_the_clock() {
    let h = setup();
    let auction_id = open_auction(&h);
    let auction = h.client().get_auction(&auction_id);
    let published_at = DRAND_GENESIS + (auction.reveal_round - 1) * DRAND_PERIOD;

    assert_eq!(h.client().current_phase(&auction_id), Phase::Sealed);
    h.warp(auction.commit_deadline + 1, published_at);
    assert_eq!(h.client().current_phase(&auction_id), Phase::Reveal);
    h.warp(auction.reveal_deadline + 1, published_at);
    assert_eq!(h.client().current_phase(&auction_id), Phase::Funding);
}

#[test]
fn round_time_conversions_agree_with_drand() {
    let h = setup();
    // Round 1 is the genesis round.
    assert_eq!(h.client().timestamp_for_round(&1u64), DRAND_GENESIS);
    assert_eq!(h.client().timestamp_for_round(&2u64), DRAND_GENESIS + DRAND_PERIOD);
    assert_eq!(
        h.client().round_at_timestamp(&DRAND_GENESIS),
        1,
        "genesis time is round 1"
    );
    assert_eq!(
        h.client().round_at_timestamp(&(DRAND_GENESIS + DRAND_PERIOD)),
        2
    );

    // And the two are inverses on round boundaries: round `r` is live from its
    // publication timestamp until the instant round `r + 1` is published.
    for round in [7u64, 1_000, 32_000_000] {
        let ts = h.client().timestamp_for_round(&round);
        assert_eq!(h.client().round_at_timestamp(&ts), round);
        assert_eq!(
            h.client().round_at_timestamp(&(ts + DRAND_PERIOD - 1)),
            round,
            "still the same round one tick before the next one lands"
        );
        assert_eq!(
            h.client().round_at_timestamp(&(ts + DRAND_PERIOD)),
            round + 1
        );
    }
}

#[test]
fn config_reports_not_initialized_before_setup() {
    let env = Env::default();
    let contract_id = env.register(SubRosaEscrow, ());
    let client = SubRosaEscrowClient::new(&env, &contract_id);
    assert_eq!(client.try_get_config(), Err(Ok(Error::NotInitialized)));
}

#[test]
fn a_missing_auction_reports_not_found() {
    let h = setup();
    assert_eq!(
        h.client().try_get_auction(&999u64),
        Err(Ok(Error::AuctionNotFound))
    );
}
