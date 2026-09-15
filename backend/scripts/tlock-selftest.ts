#!/usr/bin/env node
/**
 * Live timelock self-test — the one check that proves the privacy claim rather than
 * asserting it.
 *
 * It does four things against the real quicknet network:
 *
 *   1. seals a bid to a round a few seconds in the future;
 *   2. tries to open it immediately and asserts that it *fails* — this is the
 *      security property, not an error path;
 *   3. waits for the round's beacon to be published;
 *   4. opens it and asserts the plaintext and the recomputed commitment are exact.
 *
 * Ran by `npm run drand:selftest`. Needs network access; takes about a minute because
 * it deliberately waits for a real round to elapse.
 *
 *   node scripts/tlock-selftest.ts [--lead-rounds 10] [--json]
 */

import { Keypair } from '@stellar/stellar-sdk';
import { QUICKNET, msUntilRound, roundAt, roundTime } from '../src/drand/chain.ts';
import { sealBid, openBid } from '../src/drand/envelope.ts';
import { bytesToHex, bytesEqual } from '../src/util/bytes.ts';
import { beaconDigestHex } from '../src/drand/attestation.ts';
import { createDrandClient, fetchChainInfo, fetchVerifiedBeacon } from '../src/drand/beacon.ts';
import { assertTimelockChain, timelockClientFor } from '../src/drand/tlock.ts';

interface Options {
  leadRounds: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { leadRounds: 10, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lead-rounds') options.leadRounds = Number(argv[++i] ?? 10);
    else if (argv[i] === '--json') options.json = true;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const chain = QUICKNET;
  const steps: Record<string, unknown> = {};

  const report = (label: string, value: unknown): void => {
    steps[label] = value;
    if (!options.json) console.log(`  ${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  };

  if (!options.json) {
    console.log('subrosa tlock self-test');
    console.log(`  chain: ${chain.beaconId} (${chain.chainHash.slice(0, 16)}…)`);
  }

  const timelock = timelockClientFor(chain);
  await assertTimelockChain(timelock, chain);

  const drand = createDrandClient(chain);
  const info = await fetchChainInfo(drand, chain);
  report('chain_ok', `period=${info.periodSeconds}s genesis=${info.genesisTime}`);

  const targetRound = roundAt(Date.now() / 1000, chain) + options.leadRounds;
  const opensAt = roundTime(targetRound, chain);
  report('target_round', targetRound);
  report('opens_at', new Date(opensAt * 1000).toISOString());

  // -- 1. Seal -------------------------------------------------------------
  const auctionId = 1n;
  const amount = 1_500_000n;
  const bidder = Keypair.random().publicKey();

  const bundle = await sealBid({ auctionId, amount, revealRound: targetRound, chain, bidder });
  report('envelope_bytes', Buffer.byteLength(bundle.envelope, 'utf8'));
  report('envelope_hash', bytesToHex(bundle.envelopeHash));
  report('commitment', bytesToHex(bundle.commitment));

  // -- 2. It must be unopenable right now ---------------------------------
  let openedEarly = false;
  let earlyError = '';
  try {
    await openBid(bundle.envelope, chain);
    openedEarly = true;
  } catch (error) {
    earlyError = error instanceof Error ? error.message : String(error);
  }

  if (openedEarly) {
    throw new Error(
      'PRIVACY FAILURE: the envelope opened before its reveal round. Do not ship this.',
    );
  }
  report('sealed_before_round', true);
  report('early_open_error', earlyError.slice(0, 120));

  // -- 3. Wait for the real round -----------------------------------------
  const waitMs = msUntilRound(targetRound, chain);
  if (!options.json) console.log(`  waiting ${Math.ceil(waitMs / 1000)}s for round ${targetRound}…`);
  while (Date.now() < roundTime(targetRound, chain) * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const beacon = await fetchVerifiedBeacon(drand, chain, targetRound);
  report('beacon_verified', true);
  report('beacon_randomness', beacon.randomness);

  // -- 4. Open it and check the plaintext exactly -------------------------
  const opened = await openBid(bundle.envelope, chain);

  if (opened.amount !== amount) throw new Error(`amount mismatch: ${opened.amount} !== ${amount}`);
  if (!bytesEqual(opened.commitment, bundle.commitment)) {
    throw new Error('recomputed commitment does not match the commitment anchored at seal time');
  }
  if (opened.plaintext.bidder !== bidder) throw new Error('bidder mismatch');
  if (opened.plaintext.revealRound !== targetRound) throw new Error('reveal round mismatch');

  report('decrypted_amount', opened.amount.toString());
  report('commitment_matches', true);

  const digest = beaconDigestHex({
    chainHash: chain.chainHash,
    round: targetRound,
    randomnessHex: beacon.randomness,
    auctionId,
  });
  report('beacon_digest', digest);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, steps }, null, 2));
  } else {
    console.log('\n  PASS: sealed until the round, openable after it, commitment intact.');
  }
}

main().catch((error: unknown) => {
  console.error(`\n  FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
