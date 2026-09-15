#!/usr/bin/env node
/**
 * Inspect the drand chain the protocol is pinned to, and show the round arithmetic
 * that an auction would currently derive.
 *
 *   node scripts/drand-info.ts
 *   node scripts/drand-info.ts --commit-window 3600 --json
 */

import { QUICKNET, msUntilRound, predictRevealRound, roundAt, roundTime } from '../src/drand/chain.ts';
import { createDrandClient, fetchChainInfo } from '../src/drand/beacon.ts';

interface Options {
  commitWindowLedgers: number;
  assumedLedgerSeconds: number;
  marginRounds: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    commitWindowLedgers: 17_280, // one day at 5s ledgers
    assumedLedgerSeconds: 5,
    marginRounds: 40,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit-window') options.commitWindowLedgers = Number(argv[++i] ?? 0);
    else if (arg === '--ledger-seconds') options.assumedLedgerSeconds = Number(argv[++i] ?? 5);
    else if (arg === '--margin-rounds') options.marginRounds = Number(argv[++i] ?? 40);
    else if (arg === '--json') options.json = true;
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const chain = QUICKNET;
  const client = createDrandClient(chain);

  // Fetched live and cross-checked against the pinned constants inside the client.
  const info = await fetchChainInfo(client, chain);

  const nowSeconds = Date.now() / 1000;
  const latestRound = roundAt(nowSeconds, chain);

  const predicted = predictRevealRound({
    createdAtSeconds: Math.floor(nowSeconds),
    commitWindowLedgers: options.commitWindowLedgers,
    assumedLedgerSeconds: options.assumedLedgerSeconds,
    marginRounds: options.marginRounds,
    chain,
  });

  const payload = {
    chain: {
      beaconId: info.beaconId,
      chainHash: info.chainHash,
      publicKey: info.publicKey,
      schemeId: info.schemeId,
      periodSeconds: info.periodSeconds,
      genesisTime: info.genesisTime,
      /** Must match `Config.chain_hash` on the contract. */
      matchesContractPin: info.chainHash === chain.chainHash,
    },
    now: {
      latestRound,
      latestRoundPublishedAt: new Date(roundTime(latestRound, chain) * 1000).toISOString(),
      nextRoundInMs: msUntilRound(latestRound + 1, chain),
    },
    currentAuctionDerivation: {
      commitWindowLedgers: options.commitWindowLedgers,
      assumedLedgerSeconds: options.assumedLedgerSeconds,
      marginRounds: options.marginRounds,
      estimatedCommitClose: new Date(
        (nowSeconds + options.commitWindowLedgers * options.assumedLedgerSeconds) * 1000,
      ).toISOString(),
      revealRound: predicted,
      revealRoundPublishesAt: new Date(roundTime(predicted, chain) * 1000).toISOString(),
      marginRoundsAheadOfCommitClose:
        predicted - roundAt(nowSeconds + options.commitWindowLedgers * options.assumedLedgerSeconds, chain),
    },
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('drand chain');
  console.log(`  beacon        ${payload.chain.beaconId}`);
  console.log(`  scheme        ${payload.chain.schemeId}`);
  console.log(`  period        ${payload.chain.periodSeconds}s`);
  console.log(`  genesis       ${new Date(payload.chain.genesisTime * 1000).toISOString()}`);
  console.log(`  chain hash    ${payload.chain.chainHash}`);
  console.log(`  pinned        ${payload.chain.matchesContractPin ? 'yes' : 'NO — MISMATCH'}`);
  console.log('\nnow');
  console.log(`  latest round  ${payload.now.latestRound}`);
  console.log(`  next in       ${(payload.now.nextRoundInMs / 1000).toFixed(1)}s`);
  console.log('\nif an auction started now');
  console.log(
    `  commits close ~${payload.currentAuctionDerivation.estimatedCommitClose} (after ${options.commitWindowLedgers} ledgers)`,
  );
  console.log(`  reveal round  ${payload.currentAuctionDerivation.revealRound}`);
  console.log(`  beacon at     ${payload.currentAuctionDerivation.revealRoundPublishesAt}`);
  console.log(
    `  that is ${payload.currentAuctionDerivation.marginRoundsAheadOfCommitClose} rounds after the estimated close, ` +
      'which is the jitter margin protecting against a ledger clock that runs slow',
  );
}

main().catch((error: unknown) => {
  console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
