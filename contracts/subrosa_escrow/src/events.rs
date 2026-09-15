//! On-chain event stream.
//!
//! The backend indexer is driven entirely by this stream, so every state
//! transition that a UI needs to observe emits exactly one event. Topics are
//! `(name, auction_id)` and the body carries the payload.

use soroban_sdk::{contracttype, Address, Env, Symbol};

/// Emitted when `initialize` commits the protocol configuration.
pub fn config_initialized(env: &Env, admin: &Address, chain_hash: &soroban_sdk::BytesN<32>) {
    let topics = (Symbol::new(env, "cfg_init"),);
    env.events().publish(topics, (admin.clone(), chain_hash.clone()));
}

/// Emitted once per created auction.
pub fn auction_created(
    env: &Env,
    auction_id: u64,
    seller: &Address,
    reserve_price: i128,
    bond: i128,
    commit_deadline: u32,
    reveal_deadline: u32,
    funding_deadline: u32,
    reveal_round: u64,
) {
    let topics = (Symbol::new(env, "auc_new"), auction_id);
    env.events().publish(
        topics,
        (
            seller.clone(),
            reserve_price,
            bond,
            commit_deadline,
            reveal_deadline,
            funding_deadline,
            reveal_round,
        ),
    );
}

/// Emitted when a sealed bid is accepted and its bond is escrowed.
pub fn bid_sealed(
    env: &Env,
    auction_id: u64,
    bidder: &Address,
    commitment: &soroban_sdk::BytesN<32>,
    envelope_hash: &soroban_sdk::BytesN<32>,
    bond: i128,
) {
    let topics = (Symbol::new(env, "bid_seal"), auction_id, bidder.clone());
    env.events()
        .publish(topics, (commitment.clone(), envelope_hash.clone(), bond));
}

/// Emitted when a sealed bid is opened. `source` is whoever paid for the reveal,
/// which may be the bidder, a relayer, or an unrelated third party.
pub fn bid_revealed(
    env: &Env,
    auction_id: u64,
    bidder: &Address,
    source: &Address,
    amount: i128,
    reveal_round: u64,
) {
    let topics = (Symbol::new(env, "bid_open"), auction_id, bidder.clone());
    env.events()
        .publish(topics, (source.clone(), amount, reveal_round));
}

/// Emitted when a bidder tops up escrow towards the eventual hammer price.
pub fn bid_funded(env: &Env, auction_id: u64, bidder: &Address, total: i128, delta: i128) {
    let topics = (Symbol::new(env, "bid_fund"), auction_id, bidder.clone());
    env.events().publish(topics, (total, delta));
}

/// Emitted when the beacon for an auction's reveal round is accepted on-chain.
pub fn beacon_recorded(env: &Env, auction_id: u64, round: u64, randomness: &soroban_sdk::BytesN<32>) {
    let topics = (Symbol::new(env, "beacon"), auction_id, round);
    env.events().publish(topics, randomness.clone());
}

/// Emitted once per auction when escrow is released.
///
/// `outcome` is `"settled"`, `"failed"` or `"cancelled"`, which keeps the
/// indexer from needing a separate event per terminal state.
pub fn auction_outcome(
    env: &Env,
    auction_id: u64,
    outcome: Symbol,
    winner: Option<Address>,
    hammer_price: i128,
    fee: i128,
) {
    let topics = (Symbol::new(env, "auc_done"), auction_id, outcome);
    env.events()
        .publish(topics, (winner.clone(), hammer_price, fee));
}

/// Emitted when a party moves accrued balance out of the contract.
pub fn claimed(env: &Env, auction_id: u64, claimant: &Address, amount: i128) {
    let topics = (Symbol::new(env, "claim"), auction_id, claimant.clone());
    env.events().publish(topics, amount);
}

/// Emitted when a bidder is skipped during settlement for failing to fund.
pub fn bid_skipped(env: &Env, auction_id: u64, bidder: &Address, amount: i128, slashed_bond: i128) {
    let topics = (Symbol::new(env, "bid_skip"), auction_id, bidder.clone());
    env.events().publish(topics, (amount, slashed_bond));
}

/// Emitted whenever the admin rotates relayers, fees, or the pause switch.
pub fn config_updated(env: &Env, kind: Symbol, actor: &Address) {
    let topics = (Symbol::new(env, "cfg_upd"), kind);
    env.events().publish(topics, actor.clone());
}
