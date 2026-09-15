#!/usr/bin/env node
/**
 * Independently verify a drand beacon.
 *
 * This is the check anyone can run to audit SubRosa's beacon witness. It uses only
 * `drand-client` against the pinned quicknet public key — no SubRosa code, no SubRosa
 * infrastructure, no trust in our relayer set.
 *
 *   node scripts/verify-beacon.ts --round 32231058
 *   node scripts/verify-beacon.ts --latest
 *   node scripts/verify-beacon.ts --auction 7          # digests the beacon an auction used
 *
 * Exit code 0 means the BLS signature is valid. Non-zero means do not trust any
 * attestation built on that round.
 */

import { QUICKNET, roundAt, roundTime } from '../src/drand/chain.ts';
import { createDrandClient, fetchChainInfo, fetchVerifiedBeacon } from '../src/drand/beacon.ts';
import { beaconDigestHex } from '../src/drand/attestation.ts';

interface Options {
  round?: number;
  latest: boolean;
  auctionId?: bigint;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { latest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--latest') options.latest = true;
    else if (arg === '--round') options.round = Number(argv[++i]);
    else if (arg === '--auction') options.auctionId = BigInt(argv[++i] ?? '0');
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const chain = QUICKNET;
  const client = createDrandClient(chain);

  const info = await fetchChainInfo(client, chain);
  console.log(`chain      ${info.beaconId}  period=${info.periodSeconds}s  scheme=${info.schemeId}`);
  console.log(`chain hash ${info.chainHash}`);
  console.log(`public key ${info.publicKey.slice(0, 32)}…`);

  const round = options.latest ? roundAt(Date.now() / 1000, chain) : options.round;
  if (round === undefined || Number.isNaN(round)) {
    console.error('\nusage: verify-beacon.ts (--round <n> | --latest) [--auction <id>]');
    process.exit(2);
  }

  if (round > roundAt(Date.now() / 1000, chain)) {
    console.error(
      `\nround ${round} is not published yet (opens ${new Date(roundTime(round, chain) * 1000).toISOString()})`,
    );
    process.exit(3);
  }

  console.log(`\nverifying round ${round} …`);
  // `fetchVerifiedBeacon` calls drand-client's `verifyBeacon`, which checks the BLS
  // signature over the round's message against the pinned public key. It throws if the
  // signature is invalid, so reaching the next line is the result.
  const beacon = await fetchVerifiedBeacon(client, chain, round);

  console.log('  signature   VALID');
  console.log(`  randomness  ${beacon.randomness}`);
  console.log(`  signature   ${beacon.signature.slice(0, 48)}…`);
  console.log(`  published   ${new Date(roundTime(round, chain) * 1000).toISOString()}`);

  if (options.auctionId !== undefined) {
    const digest = beaconDigestHex({
      chainHash: chain.chainHash,
      round,
      randomnessHex: beacon.randomness,
      auctionId: options.auctionId,
    });
    console.log(`\n  attestation digest for auction ${options.auctionId}:`);
    console.log(`  ${digest}`);
    console.log(
      '  compare this against `hash_beacon_digest` on the contract, and against the\n' +
        '  message the relayer signatures in /v1/auctions/{id}/attestation verify over.',
    );
  }
}

main().catch((error: unknown) => {
  console.error(`\n  INVALID: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
