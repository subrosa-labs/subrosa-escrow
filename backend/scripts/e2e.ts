#!/usr/bin/env node
/**
 * End-to-end lifecycle against a live deployment.
 *
 * Drives a real auction through every phase with real drand rounds:
 *
 *   create -> seal (×3, envelopes published) -> wait for the round
 *   -> attest the beacon -> reveal -> fund -> settle -> claim
 *
 * It asserts the things unit tests cannot: that a sealed envelope is genuinely
 * unreadable on a live network before its round, that an under-funded reveal loses its
 * bond while a funded loser gets everything back, and that the escrow ledger nets to
 * exactly zero once everyone has claimed.
 *
 * Requires a deployed contract plus a relayer key set that satisfies the on-chain
 * quorum. Writes real transactions and spends real testnet fees.
 *
 *   npm run e2e --workspace backend
 *
 * Options:
 *   --commit-ledgers <n>   default 20   (~100s at 5s ledgers)
 *   --reveal-ledgers <n>   default 20
 *   --funding-ledgers <n>  default 20
 *
 * Refuses to run against mainnet.
 */

import { Keypair, TransactionBuilder, type xdr } from '@stellar/stellar-sdk';
import { createApp, type App } from '../src/app.ts';
import { QUICKNET, msUntilRound, roundTime } from '../src/drand/chain.ts';
import { sealBid, openBid } from '../src/drand/envelope.ts';
import { bytesToHex } from '../src/util/bytes.ts';

interface Options {
  commitLedgers: number;
  revealLedgers: number;
  fundingLedgers: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { commitLedgers: 20, revealLedgers: 20, fundingLedgers: 20 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit-ledgers') options.commitLedgers = Number(argv[++i] ?? 20);
    else if (arg === '--reveal-ledgers') options.revealLedgers = Number(argv[++i] ?? 20);
    else if (arg === '--funding-ledgers') options.fundingLedgers = Number(argv[++i] ?? 20);
  }
  return options;
}

/** All amounts are in the settlement token's smallest unit (7 decimals here). */
const BOND = 1_000_000n;
const SELLER_BOND = 2_000_000n;
const RESERVE = 10_000_000n;
const WINNING_BID = 25_000_000n;
const LOSING_BID = 15_000_000n;
/** Revealed above the bond but deliberately never funded: its bond must be forfeit. */
const UNDERFUNDED_BID = 22_000_000n;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const app = await createApp();

  if (app.network.name === 'mainnet') {
    throw new Error('refusing to run the end-to-end suite against mainnet');
  }
  if (app.preflight.length > 0) {
    throw new Error(`preflight failed:\n  - ${app.preflight.join('\n  - ')}`);
  }

  const step = (label: string, value: unknown): void => {
    console.log(`  ${label.padEnd(22)} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  };

  console.log(`\nsubrosa end-to-end on ${app.network.name}`);

  const onChain = await app.orchestrator.onChain();
  step('contract', app.config.SUBROSA_CONTRACT_ID);
  step('settlement token', onChain.settlementToken);
  step('quorum', `${onChain.relayerThreshold} of ${onChain.relayerPubkeys.length}`);

  // -- accounts -------------------------------------------------------------
  const seller = Keypair.random();
  const winner = Keypair.random();
  const loser = Keypair.random();
  const underfunded = Keypair.random();

  for (const [name, keypair] of [
    ['seller', seller],
    ['bidder_winner', winner],
    ['bidder_loser', loser],
    ['bidder_underfunded', underfunded],
  ] as const) {
    await fundAccount(app, keypair.publicKey());
    step(`funded ${name}`, `${keypair.publicKey().slice(0, 8)}…`);
  }

  // -- create the auction ---------------------------------------------------
  const created = await invokeAs(app, seller, 'create_auction',
    app.contract.createAuctionArgs(seller.publicKey(), {
      reservePrice: RESERVE,
      bond: BOND,
      sellerBond: SELLER_BOND,
      commitWindowLedgers: options.commitLedgers,
      revealWindowLedgers: options.revealLedgers,
      fundingWindowLedgers: options.fundingLedgers,
    }),
  );
  step('create_auction', created.hash);

  const auctionId = (await app.contract.auctionCount()) - 1n;
  let auction = await app.contract.getAuction(auctionId);
  step('auction id', auctionId.toString());
  step(
    'reveal round',
    `${auction.revealRound} at ${new Date(roundTime(auction.revealRound, QUICKNET) * 1000).toISOString()}`,
  );

  // -- seal -----------------------------------------------------------------
  const plan = [
    { name: 'winner', keypair: winner, amount: WINNING_BID, fundTo: WINNING_BID },
    { name: 'loser', keypair: loser, amount: LOSING_BID, fundTo: LOSING_BID },
    { name: 'underfunded', keypair: underfunded, amount: UNDERFUNDED_BID, fundTo: BOND },
  ];

  for (const entry of plan) {
    // The plaintext is created here and never leaves except inside the ciphertext.
    const bundle = await sealBid({
      auctionId,
      amount: entry.amount,
      revealRound: auction.revealRound,
      chain: QUICKNET,
      bidder: entry.keypair.publicKey(),
    });

    // Publish first, then anchor the hash on-chain, so the relayer can always reveal
    // even if the sealing transaction is the last thing to land.
    await app.bulletin.publish({
      auctionId,
      bidder: entry.keypair.publicKey(),
      envelope: bundle.envelope,
      commitment: bytesToHex(bundle.commitment),
      envelopeHash: bytesToHex(bundle.envelopeHash),
    });

    const sealed = await invokeAs(app, entry.keypair, 'seal_bid',
      app.contract.sealBidArgs(
        auctionId,
        entry.keypair.publicKey(),
        bundle.commitment,
        bundle.envelopeHash,
      ),
    );
    step(`seal ${entry.name}`, sealed.hash);
  }

  // -- the privacy property, checked live -----------------------------------
  const sample = await app.bulletin.get(auctionId, winner.publicKey());
  if (!sample) throw new Error('published envelope disappeared from the bulletin');
  let openedEarly = false;
  try {
    await openBid(sample.envelope, QUICKNET);
    openedEarly = true;
  } catch {
    openedEarly = false;
  }
  if (openedEarly) throw new Error('PRIVACY FAILURE: an envelope opened before its reveal round');
  step('sealed pre-round', 'confirmed unreadable');

  // -- wait for the round, then attest and reveal ---------------------------
  const waitMs = msUntilRound(auction.revealRound, QUICKNET) + 2_000;
  console.log(`\n  waiting ${Math.ceil(waitMs / 1000)}s for round ${auction.revealRound}…`);
  await sleep(waitMs);

  const attested = await app.orchestrator.attestBeacon(auctionId);
  step('attest_beacon', attested.txHashes?.[0] ?? attested.reason ?? attested.status);

  const revealed = await app.orchestrator.revealAll(auctionId);
  step('reveal', revealed.details ?? revealed.reason ?? revealed.status);

  auction = await app.contract.getAuction(auctionId);
  if (auction.revealedCount !== 3) {
    throw new Error(`expected 3 revealed bids, got ${auction.revealedCount}`);
  }

  // -- fund -----------------------------------------------------------------
  for (const entry of plan) {
    const topUp = entry.fundTo - BOND;
    if (topUp <= 0n) {
      step(`fund ${entry.name}`, 'skipped (left under-funded on purpose)');
      continue;
    }
    const funded = await invokeAs(app, entry.keypair, 'fund_bid',
      app.contract.fundBidArgs(auctionId, entry.keypair.publicKey(), topUp),
    );
    step(`fund ${entry.name}`, funded.hash);
  }

  // -- settle ---------------------------------------------------------------
  const ledger = await app.relayer.latestLedger();
  const settleWaitMs = Math.max(0, (auction.fundingDeadline - ledger + 1) * 5_000);
  console.log(`\n  waiting ${Math.ceil(settleWaitMs / 1000)}s for the funding window to close…`);
  await sleep(settleWaitMs + 5_000);

  const settled = await app.orchestrator.settle(auctionId);
  step('settle', settled.txHashes?.[0] ?? settled.reason ?? settled.status);

  auction = await app.contract.getAuction(auctionId);
  step('phase', auction.phase);
  step('winner', auction.winner ?? '(none)');
  step('hammer price', auction.hammerPrice.toString());
  step('slashed bonds', auction.slashed.toString());

  if (auction.phase !== 'Settled') throw new Error(`expected Settled, got ${auction.phase}`);
  if (auction.winner !== winner.publicKey()) {
    throw new Error(`expected ${winner.publicKey()} to win, got ${auction.winner}`);
  }
  if (auction.hammerPrice !== WINNING_BID) {
    throw new Error(`expected a hammer price of ${WINNING_BID}, got ${auction.hammerPrice}`);
  }
  if (auction.slashed !== BOND) {
    throw new Error(`expected ${BOND} of forfeited bonds, got ${auction.slashed}`);
  }

  // -- claims and conservation ---------------------------------------------
  const escrowBefore = auction.escrowed;

  // The treasury's fee accrues to an address we do not hold the secret for; it stays
  // claimable by them, which is the point of the per-auction claim ledger.
  const ours = [
    { name: 'seller', keypair: seller, expected: 0n },
    { name: 'winner', keypair: winner, expected: 0n },
    { name: 'loser', keypair: loser, expected: LOSING_BID },
    { name: 'underfunded', keypair: underfunded, expected: 0n },
  ];

  let claimedTotal = 0n;
  for (const entry of ours) {
    const claimable = await app.contract.getClaimable(auctionId, entry.keypair.publicKey());
    if (claimable !== entry.expected) {
      throw new Error(
        `${entry.name} expected ${entry.expected}, but the contract offers ${claimable}`,
      );
    }
    if (claimable === 0n) {
      step(`claim ${entry.name}`, '0 (nothing owed)');
      continue;
    }
    const tx = await invokeAs(app, entry.keypair, 'claim',
      app.contract.claimArgs(auctionId, entry.keypair.publicKey()),
    );
    claimedTotal += claimable;
    step(`claim ${entry.name}`, `${claimable} via ${tx.hash.slice(0, 8)}…`);
  }

  const treasuryClaim = await app.contract.getClaimable(auctionId, onChain.treasury);
  step('treasury fee claimable', treasuryClaim.toString());
  step('escrow before claims', escrowBefore.toString());
  step('claimed by us', claimedTotal.toString());

  const finalAuction = await app.contract.getAuction(auctionId);
  step('escrow remaining', finalAuction.escrowed.toString());

  // What is left must be exactly the treasury's fee plus the slashed seller-bond
  // compensation that the contract credited to the seller — all of which is accounted
  // for, none of which is leaking.
  const sellerClaimable = await app.contract.getClaimable(auctionId, seller.publicKey());
  if (finalAuction.escrowed !== treasuryClaim + sellerClaimable) {
    throw new Error(
      `escrow accounting is wrong: ${finalAuction.escrowed} remains but only ` +
        `${treasuryClaim + sellerClaimable} is claimable`,
    );
  }
  step('accounted for', 'escrow remaining == treasury + seller claims');

  console.log('\n  PASS: sealed, revealed, settled, and the escrow ledger reconciles.\n');
  await app.close();
}

/**
 * Build, sign and submit a call as `actor`.
 *
 * Uses the same prepare/sign/submit path the browser uses, so the end-to-end run
 * exercises the production path rather than a shortcut.
 */
async function invokeAs(
  app: App,
  actor: Keypair,
  method: string,
  args: readonly xdr.ScVal[],
): Promise<{ hash: string; ledger: number }> {
  const prepared = await app.relayer.prepare(actor.publicKey(), method, args);
  const tx = TransactionBuilder.fromXDR(prepared.xdr, app.network.passphrase);
  tx.sign(actor);
  const result = await app.relayer.submit(tx.toXDR(), method);
  return { hash: result.hash, ledger: result.ledger };
}

async function fundAccount(app: App, publicKey: string): Promise<void> {
  try {
    await app.server.requestAirdrop(publicKey);
  } catch (error) {
    throw new Error(
      `could not fund ${publicKey} via friendbot (${error instanceof Error ? error.message : String(error)}). ` +
        'The end-to-end suite needs friendbot, so it only runs on testnet or futurenet.',
    );
  }
  // Let the ledger include the airdrop before the next submit needs a sequence number.
  await sleep(2_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(`\n  FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
