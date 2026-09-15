/**
 * The orchestrator.
 *
 * One entry point per phase transition, all idempotent, all safe to run from several
 * processes at once because the work is serialised per `(auction, kind)` through the
 * job queue's lease.
 *
 * ## The trust posture, in one place
 *
 * The relayer is *not* a trusted revealer. It cannot open an envelope before the
 * round, and it cannot change what an envelope says. What it does is:
 *
 * 1. fetch the reveal round's beacon and check drand's BLS signature against the
 *    pinned quicknet public key;
 * 2. sign an ed25519 quorum attestation over `(chain_hash, round, randomness, auction_id)`
 *    so the contract, which has no pairing function, can accept the beacon;
 * 3. open the envelopes and submit `reveal_bid` — a call that is permissionless, and
 *    on which the contract independently re-checks the envelope hash and the
 *    commitment;
 * 4. call `settle`, whose outcome is a pure function of state the contract already
 *    holds.
 *
 * Steps 3 and 4 could be run by any observer with the same results. Step 2 is the
 * only genuine trust assumption, and it is bounded: a colluding quorum can lie about
 * a beacon, but cannot read a bid early, open a bid that does not match its
 * commitment, or move escrow to anyone the contract did not already credit.
 */

import type { rpc } from '@stellar/stellar-sdk';
import type { HttpChainClient } from 'drand-client';
import type { Config } from '../config.ts';
import { childLogger, type Logger } from '../logger.ts';
import type { AttestationRecord, JobRecord, Store } from '../store/types.ts';
import {
  QUICKNET,
  chainByHash,
  msUntilRound,
  roundTime,
  type DrandChain,
} from '../drand/chain.ts';
import { createDrandClient, fetchVerifiedBeacon } from '../drand/beacon.ts';
import { resolveSigners, signBeaconDigest, type RelayerSigner } from '../drand/attestation.ts';
import { assertOpeningMatchesOnChainCommitment, openBid } from '../drand/envelope.ts';
import { bytesToHex, hexToBytes32 } from '../util/bytes.ts';
import {
  SubRosaContract,
  isTerminal,
  type AuctionView,
  type ConfigView,
} from '../stellar/contract.ts';
import type { Relayer } from '../stellar/relayer.ts';
import { SubmissionError } from '../stellar/errors.ts';
import type { EnvelopeBulletin } from './bulletin.ts';

const SECONDS_PER_LEDGER = 5;
const LEDGER_MS = SECONDS_PER_LEDGER * 1_000;

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

export type AdvanceStatus = 'done' | 'deferred' | 'skipped' | 'partial' | 'failed';

export interface AdvanceResult {
  readonly status: AdvanceStatus;
  readonly kind: JobRecord['kind'];
  readonly auctionId: string;
  readonly reason?: string;
  readonly retryInMs?: number;
  readonly txHashes?: readonly string[];
  readonly details?: Record<string, unknown>;
}

export interface ObserveSummary {
  readonly scanned: bigint;
  readonly scheduled: readonly { auctionId: string; kind: JobRecord['kind']; runAfterMs: number }[];
}

export interface OrchestratorDeps {
  readonly config: Config;
  readonly store: Store;
  readonly contract: SubRosaContract;
  readonly relayer: Relayer;
  readonly bulletin: EnvelopeBulletin;
  readonly server: rpc.Server;
}

export class RelayerOrchestrator {
  private readonly log: Logger;
  private readonly drandClient: HttpChainClient;
  private readonly signers: RelayerSigner[];
  private readonly unmatchedRelayers: readonly string[];
  /** Best available ledger estimate, refreshed on every `observe` tick. */
  private approxLedger = 0;
  private onChainConfig?: { value: ConfigView; fetchedAt: number };

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = childLogger('orchestrator');
    this.drandClient = createDrandClient(this.chain);
    const resolved = resolveSigners(deps.config.relayerSecretKeys, deps.config.relayerPublicKeys);
    this.signers = resolved.signers;
    this.unmatchedRelayers = resolved.unmatched;
  }

  get chain(): DrandChain {
    return chainByHash(this.deps.config.DRAND_CHAIN_HASH);
  }

  /** The relayer keys this process holds that the on-chain config does not know about. */
  get unmatched(): readonly string[] {
    return this.unmatchedRelayers;
  }

  /**
   * Read the on-chain config, cached for a minute.
   *
   * The threshold lives on-chain, so a mismatch between what this process holds and
   * what the contract expects is detected against the contract rather than against a
   * local env var.
   */
  async onChain(): Promise<ConfigView> {
    const cached = this.onChainConfig;
    if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.value;
    const value = await this.deps.contract.getConfig();
    this.onChainConfig = { value, fetchedAt: Date.now() };
    return value;
  }

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  /**
   * Refresh the auction cache and schedule the next action for every auction that
   * is not terminal.
   *
   * Scanning a bounded window of the most recent auctions keeps this O(1)-ish per
   * tick. A production deployment would index the contract's event stream and keep a
   * cursor; the window is deliberate here because it needs no backfill and cannot
   * drift out of sync.
   */
  async observe(windowSize = 50): Promise<ObserveSummary> {
    await this.refreshLedger();
    const count = await this.deps.contract.auctionCount();
    const total = Number(count);
    const start = BigInt(Math.max(0, total - windowSize));

    const auctions = await this.deps.contract.listAuctions(start, windowSize);
    const scheduled: { auctionId: string; kind: JobRecord['kind']; runAfterMs: number }[] = [];

    for (const auction of auctions) {
      await this.cacheAuction(auction);

      if (isTerminal(auction.phase)) continue;

      for (const plan of this.plan(auction)) {
        await this.deps.store.upsertJob({
          auctionId: auction.id.toString(),
          kind: plan.kind,
          runAfter: new Date(Date.now() + plan.delayMs),
        });
        scheduled.push({
          auctionId: auction.id.toString(),
          kind: plan.kind,
          runAfterMs: plan.delayMs,
        });
      }
    }

    return { scanned: BigInt(auctions.length), scheduled };
  }

  /** Decide what an auction needs next, and how soon. */
  private plan(auction: AuctionView): { kind: JobRecord['kind']; delayMs: number }[] {
    const plans: { kind: JobRecord['kind']; delayMs: number }[] = [];
    const roundAvailable = roundTime(auction.revealRound, this.chain) * 1000 <= Date.now();

    if (!auction.beacon) {
      // Attest as soon as the round lands, never before — before that the beacon
      // does not exist, so there is nothing to attest.
      plans.push({
        kind: 'attest',
        delayMs: roundAvailable ? 0 : msUntilRound(auction.revealRound, this.chain),
      });
      return plans;
    }

    if (auction.phase === 'Reveal' || auction.phase === 'Funding') {
      plans.push({
        kind: 'reveal',
        delayMs: this.revealDelayMs(auction),
      });
    }

    if (auction.phase === 'Funding') {
      plans.push({ kind: 'settle', delayMs: this.settleDelayMs(auction) });
    }

    return plans;
  }

  /** Reveals can only be attempted once the beacon is on-chain. */
  private revealDelayMs(auction: AuctionView): number {
    return auction.beacon ? 0 : msUntilRound(auction.revealRound, this.chain);
  }

  private settleDelayMs(auction: AuctionView): number {
    // The contract gates settlement on `funding_deadline`; the remaining ledger
    // count times the assumed ledger time is the earliest honest guess.
    const remaining = auction.fundingDeadline - this.approxLedger;
    return remaining > 0 ? remaining * LEDGER_MS : 0;
  }

  private async refreshLedger(): Promise<number> {
    this.approxLedger = await this.deps.relayer.latestLedger();
    return this.approxLedger;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async advance(job: JobRecord): Promise<AdvanceResult> {
    const auctionId = job.auctionId;
    const id = BigInt(auctionId);

    try {
      if (job.kind === 'attest') return await this.attestBeacon(id);
      if (job.kind === 'reveal') return await this.revealAll(id);
      return await this.settle(id);
    } catch (error) {
      if (error instanceof SubmissionError) {
        return {
          status: 'failed',
          kind: job.kind,
          auctionId,
          reason: error.message,
          details: { contractErrorCode: error.detail.contractErrorCode },
        };
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Beacon attestation
  // -------------------------------------------------------------------------

  /**
   * Produce (or reuse) the quorum attestation for an auction's reveal round, then
   * record it on-chain.
   *
   * The attestation is stored before submission so that a transient RPC failure does
   * not require re-fetching and re-signing — and so the exact bytes that were signed
   * are auditable afterwards.
   */
  async attestBeacon(
    auctionId: bigint,
  ): Promise<AdvanceResult> {
    const id = auctionId.toString();
    const auction = await this.deps.contract.findAuction(auctionId);
    if (!auction) return { status: 'skipped', kind: 'attest', auctionId: id, reason: 'auction_not_found' };
    if (auction.beacon) {
      return { status: 'skipped', kind: 'attest', auctionId: id, reason: 'beacon_already_recorded' };
    }

    const waitMs = msUntilRound(auction.revealRound, this.chain);
    if (waitMs > 0) {
      return {
        status: 'deferred',
        kind: 'attest',
        auctionId: id,
        reason: `reveal round ${auction.revealRound} publishes in ${Math.ceil(waitMs / 1000)}s`,
        retryInMs: waitMs,
      };
    }

    const onChain = await this.onChain();
    const threshold = onChain.relayerThreshold;

    if (this.signers.length < threshold) {
      throw new OrchestratorError(
        `this process holds ${this.signers.length} relayer key(s) but the contract requires ${threshold} of ` +
          `${onChain.relayerPubkeys.length}. Either co-locate more keys (testnet only) or peer with another operator.`,
      );
    }

    let attestation = await this.deps.store.getAttestation(id);
    if (!attestation) {
      // The BLS signature on this beacon is verified inside `fetchVerifiedBeacon`
      // against the pinned quicknet public key. We sign only what cryptography has
      // already vouched for.
      const beacon = await fetchVerifiedBeacon(this.drandClient, this.chain, auction.revealRound);

      const signatures = signBeaconDigest(this.signers, {
        chainHash: this.chain.chainHash,
        round: beacon.round,
        randomnessHex: beacon.randomness,
        auctionId,
      });

      attestation = {
        auctionId: id,
        round: beacon.round,
        randomness: beacon.randomness,
        committeeSize: onChain.relayerPubkeys.length,
        threshold,
        signerIndexes: signatures.map((entry) => entry.signerIndex),
        signatures: signatures.map((entry) => bytesToHex(entry.signature)),
        createdAt: new Date().toISOString(),
      };
      await this.deps.store.putAttestation(attestation);
    }

    const signer = this.signers[0];
    if (!signer) throw new OrchestratorError('no relayer signer available to pay for the attestation');

    const args = this.deps.contract.attestBeaconArgs(
      auctionId,
      attestation.round,
      hexToBytes32(attestation.randomness, 'randomness'),
      attestation.signerIndexes.map((index, position) => ({
        signerIndex: index,
        signature: hexToSignature(attestation.signatures[position] ?? ''),
      })),
    );

    const result = await this.deps.relayer.invoke(signer.keypair, 'attest_beacon', args);
    await this.deps.store.recordSubmission({
      auctionId: id,
      method: 'attest_beacon',
      status: 'confirmed',
      hash: result.hash,
      ledger: result.ledger,
      error: null,
    });

    this.log.info(
      { auctionId: id, round: attestation.round, signers: attestation.signerIndexes, hash: result.hash },
      'beacon attested',
    );

    return {
      status: 'done',
      kind: 'attest',
      auctionId: id,
      txHashes: [result.hash],
      details: { round: attestation.round, signers: attestation.signerIndexes },
    };
  }

  // -------------------------------------------------------------------------
  // Reveal
  // -------------------------------------------------------------------------

  /**
   * Open every envelope we hold for an auction.
   *
   * Each envelope is verified twice before a transaction is spent on it: the at-rest
   * hash check in the bulletin, then a commitment check against the bid recorded
   * on-chain. Only after both pass do we pay to reveal.
   */
  async revealAll(auctionId: bigint): Promise<AdvanceResult> {
    const id = auctionId.toString();
    const auction = await this.deps.contract.findAuction(auctionId);
    if (!auction) return { status: 'skipped', kind: 'reveal', auctionId: id, reason: 'auction_not_found' };
    if (isTerminal(auction.phase)) {
      return { status: 'skipped', kind: 'reveal', auctionId: id, reason: `auction is ${auction.phase}` };
    }
    if (auction.phase === 'Sealed') {
      return { status: 'deferred', kind: 'reveal', auctionId: id, reason: 'commits are still open', retryInMs: 5_000 };
    }
    if (!auction.beacon) {
      return {
        status: 'deferred',
        kind: 'reveal',
        auctionId: id,
        reason: 'beacon is not attested on-chain yet',
        retryInMs: 10_000,
      };
    }

    const { usable, corrupted } = await this.deps.bulletin.verified(auctionId);
    const signer = this.signers[0];
    if (!signer) throw new OrchestratorError('no relayer signer available to submit reveals');

    const txHashes: string[] = [];
    let revealed = 0;
    let already = 0;
    let mismatched = 0;

    for (const record of usable) {
      const bid = await this.deps.contract.findBid(auctionId, record.bidder);
      if (!bid) {
        this.log.warn({ auctionId: id, bidder: record.bidder }, 'envelope has no on-chain bid; skipping');
        continue;
      }
      if (bid.revealed) {
        already++;
        continue;
      }

      let opened;
      try {
        opened = await openBid(record.envelope, this.chain);
      } catch (error) {
        // Most likely the beacon is not actually published yet, or the network is
        // flaky. Defer rather than counting it as a hard failure.
        return {
          status: revealed > 0 ? 'partial' : 'deferred',
          kind: 'reveal',
          auctionId: id,
          reason: `could not open envelope for ${record.bidder}: ${error instanceof Error ? error.message : String(error)}`,
          retryInMs: 15_000,
          ...(txHashes.length > 0 ? { txHashes } : {}),
          details: { revealed, alreadyRevealed: already },
        };
      }

      try {
        assertOpeningMatchesOnChainCommitment(opened, hexToBytes32(bid.commitment, 'commitment'), auctionId);
      } catch (error) {
        mismatched++;
        this.log.error(
          { auctionId: id, bidder: record.bidder, err: error instanceof Error ? error.message : String(error) },
          'envelope does not match its on-chain commitment; refusing to spend a fee on it',
        );
        continue;
      }

      const args = this.deps.contract.revealBidArgs(
        auctionId,
        record.bidder,
        opened.amount,
        opened.salt,
        record.envelope,
      );

      try {
        const result = await this.deps.relayer.invoke(signer.keypair, 'reveal_bid', args);
        txHashes.push(result.hash);
        revealed++;
        await this.deps.store.recordSubmission({
          auctionId: id,
          method: 'reveal_bid',
          status: 'confirmed',
          hash: result.hash,
          ledger: result.ledger,
          error: null,
        });
        this.log.info({ auctionId: id, bidder: record.bidder, hash: result.hash }, 'bid revealed');
      } catch (error) {
        await this.deps.store.recordSubmission({
          auctionId: id,
          method: 'reveal_bid',
          status: 'failed',
          hash: null,
          ledger: null,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    if (revealed === 0 && corrupted.length === 0 && already === 0 && usable.length === 0) {
      this.log.info({ auctionId: id }, 'no envelopes to reveal');
    }

    const nextJob: JobRecord['kind'] = auction.fundingDeadline > this.approxLedger ? 'settle' : 'reveal';

    return {
      status: revealed > 0 ? 'done' : 'skipped',
      kind: 'reveal',
      auctionId: id,
      ...(txHashes.length > 0 ? { txHashes } : {}),
      details: { revealed, alreadyRevealed: already, commitmentMismatches: mismatched, corrupted: corrupted.length, next: nextJob },
    };
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /** Release escrow. Permissionless on-chain; the relayer just pays the fee. */
  async settle(auctionId: bigint): Promise<AdvanceResult> {
    const id = auctionId.toString();
    const auction = await this.deps.contract.findAuction(auctionId);
    if (!auction) return { status: 'skipped', kind: 'settle', auctionId: id, reason: 'auction_not_found' };
    if (isTerminal(auction.phase)) {
      return { status: 'skipped', kind: 'settle', auctionId: id, reason: `auction is ${auction.phase}` };
    }

    const ledger = await this.refreshLedger();
    if (ledger <= auction.fundingDeadline) {
      const remaining = auction.fundingDeadline - ledger;
      return {
        status: 'deferred',
        kind: 'settle',
        auctionId: id,
        reason: `funding window closes in ${remaining} ledgers`,
        retryInMs: remaining * LEDGER_MS,
      };
    }

    const signer = this.signers[0];
    if (!signer) throw new OrchestratorError('no relayer signer available to submit settlement');

    const result = await this.deps.relayer.invoke(
      signer.keypair,
      'settle',
      this.deps.contract.settleArgs(auctionId),
    );

    await this.deps.store.recordSubmission({
      auctionId: id,
      method: 'settle',
      status: 'confirmed',
      hash: result.hash,
      ledger: result.ledger,
      error: null,
    });

    const settled = await this.deps.contract.findAuction(auctionId);
    if (settled) await this.cacheAuction(settled);

    this.log.info(
      {
        auctionId: id,
        outcome: settled?.phase,
        winner: settled?.winner,
        hammerPrice: settled?.hammerPrice?.toString(),
        hash: result.hash,
      },
      'auction settled',
    );

    return {
      status: 'done',
      kind: 'settle',
      auctionId: id,
      txHashes: [result.hash],
      details: {
        outcome: settled?.phase ?? 'unknown',
        winner: settled?.winner ?? null,
        hammerPrice: settled?.hammerPrice?.toString() ?? '0',
        slashed: settled?.slashed?.toString() ?? '0',
      },
    };
  }

  // -------------------------------------------------------------------------
  // Caching
  // -------------------------------------------------------------------------

  async cacheAuction(auction: AuctionView): Promise<void> {
    await this.deps.store.upsertAuctionCache({
      auctionId: auction.id.toString(),
      seller: auction.seller,
      phase: auction.phase,
      reservePrice: auction.reservePrice.toString(),
      bond: auction.bond.toString(),
      commitDeadline: auction.commitDeadline,
      revealDeadline: auction.revealDeadline,
      fundingDeadline: auction.fundingDeadline,
      revealRound: auction.revealRound,
      sealedCount: auction.sealedCount,
      revealedCount: auction.revealedCount,
      winner: auction.winner,
      hammerPrice: auction.hammerPrice.toString(),
      escrowed: auction.escrowed.toString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** The stored attestation for an auction, for the read API. */
  async attestationFor(auctionId: bigint): Promise<AttestationRecord | undefined> {
    return this.deps.store.getAttestation(auctionId.toString());
  }

  /** Validate that our key setup can actually satisfy the on-chain quorum. */
  async selfCheck(): Promise<{
    ok: boolean;
    holds: number;
    threshold: number;
    committee: number;
    chain: string;
    problems: string[];
  }> {
    const problems: string[] = [];
    const onChain = await this.onChain();

    if (onChain.chainHash !== this.chain.chainHash) {
      problems.push(
        `contract is pinned to drand chain ${onChain.chainHash} but this process is configured for ${this.chain.chainHash}`,
      );
    }
    if (this.chain.chainHash !== QUICKNET.chainHash) {
      problems.push(`configured chain ${this.chain.beaconId} is not quicknet`);
    }
    if (this.signers.length < onChain.relayerThreshold) {
      problems.push(
        `holding ${this.signers.length} relayer key(s) but the contract needs ${onChain.relayerThreshold}`,
      );
    }
    if (this.unmatchedRelayers.length > 0) {
      problems.push(
        `configured relayer key(s) not present in the on-chain set: ${this.unmatchedRelayers.join(', ')}`,
      );
    }

    return {
      ok: problems.length === 0,
      holds: this.signers.length,
      threshold: onChain.relayerThreshold,
      committee: onChain.relayerPubkeys.length,
      chain: this.chain.beaconId,
      problems,
    };
  }
}

/**
 * A 64-byte hex ed25519 signature, decoded strictly.
 *
 * Not `hexToBytes32`: the contract's `Signature` struct holds a `BytesN<64>`, and a
 * silent 32-byte truncation here would produce signatures that look fine in the log
 * and fail every quorum check on-chain.
 */
function hexToSignature(hex: string): Uint8Array {
  if (!/^[0-9a-f]{128}$/i.test(hex)) {
    throw new OrchestratorError(
      `ed25519 signature must be 64 bytes of hex (128 characters), got ${hex.length}`,
    );
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
