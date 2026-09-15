/**
 * User-facing flows.
 *
 * Each flow is a small state machine with named steps, so the UI can say exactly where
 * it is. The important one is `sealBidFlow`, and its ordering is deliberate:
 *
 *   1. seal locally              (plaintext exists only in this tab)
 *   2. publish the envelope      (a ciphertext and a hash; we cannot read it)
 *   3. prepare the seal call     (the relayer builds and simulates it)
 *   4. sign                      (the wallet authorises it)
 *   5. submit                    (optionally fee-sponsored by the relayer)
 *
 * Publish-before-seal means a bid that is anchored on-chain always has its envelope
 * available to the relayer, so the reveal cannot be blocked by a failed upload. The
 * reverse failure — envelope published, seal rejected — leaves an orphan ciphertext,
 * which is harmless: `revealAll` skips envelopes that have no on-chain bid.
 */

import { api, ApiError } from './api.ts';
import { QUICKNET } from './drand.ts';
import { bytesToHex } from './commitment.ts';
import { sealBid, SEALED_BID_VERSION, type SealedBidBundle } from './tlock.ts';
import { signEnvelope, WalletError } from './wallet.ts';
import type { SubmitResponseDto } from './types.ts';

export type StepStatus = 'pending' | 'active' | 'done' | 'error';

export interface FlowStep {
  readonly id: string;
  readonly label: string;
  status: StepStatus;
  detail?: string;
}

export type FlowProgress = (steps: readonly FlowStep[]) => void;

class StepTracker {
  private steps: FlowStep[];

  constructor(
    definitions: readonly { id: string; label: string }[],
    private readonly onProgress?: FlowProgress,
  ) {
    this.steps = definitions.map((definition) => ({ ...definition, status: 'pending' }));
    this.emit();
  }

  start(id: string): void {
    this.patch(id, { status: 'active' });
  }

  done(id: string, detail?: string): void {
    this.patch(id, { status: 'done', ...(detail ? { detail } : {}) });
  }

  fail(id: string, detail: string): void {
    this.patch(id, { status: 'error', detail });
  }

  snapshot(): readonly FlowStep[] {
    return this.steps.map((step) => ({ ...step }));
  }

  private patch(id: string, patch: Partial<FlowStep>): void {
    this.steps = this.steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
    this.emit();
  }

  private emit(): void {
    this.onProgress?.(this.snapshot());
  }
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isChainError && error.body?.contractErrorName) {
      return `${error.body.contractErrorName}: ${error.body.message}`;
    }
    return error.message;
  }
  if (error instanceof WalletError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

export interface SealBidFlowInput {
  readonly auctionId: bigint;
  readonly amount: bigint;
  readonly revealRound: number;
  readonly address: string;
  readonly networkPassphrase: string;
  readonly sponsor?: boolean;
  readonly onProgress?: FlowProgress;
}

/**
 * The bidder's own copy of the opening.
 *
 * `amount` is included on purpose. The contract checks a reveal against two hashes and
 * never consults drand, so a bidder holding this file can reveal with no network access
 * to the beacon at all — which is what makes the bulletin (and this relayer) genuinely
 * replaceable rather than merely "not supposed to matter".
 */
export interface BidBackup {
  readonly version: number;
  readonly auctionId: string;
  readonly amount: string;
  readonly salt: string;
  readonly commitment: string;
  readonly envelope: string;
}

export interface SealBidFlowResult {
  readonly bundle: SealedBidBundle;
  readonly submission: SubmitResponseDto;
  /** Everything the bidder should save in case our bulletin loses their envelope. */
  readonly backup: BidBackup;
}

export async function sealBidFlow(input: SealBidFlowInput): Promise<SealBidFlowResult> {
  const tracker = new StepTracker(
    [
      { id: 'seal', label: 'Sealing in your browser' },
      { id: 'publish', label: 'Publishing the sealed envelope' },
      { id: 'prepare', label: 'Preparing the on-chain commitment' },
      { id: 'sign', label: 'Waiting for your signature' },
      { id: 'submit', label: 'Submitting to Stellar' },
    ],
    input.onProgress,
  );

  let bundle: SealedBidBundle;
  tracker.start('seal');
  try {
    bundle = await sealBid({
      auctionId: input.auctionId,
      amount: input.amount,
      revealRound: input.revealRound,
      chain: QUICKNET,
      bidder: input.address,
    });
    tracker.done('seal', `${bundle.envelopeBytes} bytes of ciphertext, sealed to round ${input.revealRound}`);
  } catch (error) {
    tracker.fail('seal', messageFor(error));
    throw error;
  }

  tracker.start('publish');
  try {
    await api.publishEnvelope({
      auctionId: input.auctionId.toString(),
      bidder: input.address,
      envelope: bundle.envelope,
      commitment: bytesToHex(bundle.commitment),
      envelopeHash: bytesToHex(bundle.envelopeHash),
    });
    tracker.done('publish', 'the relayer holds a ciphertext it cannot read');
  } catch (error) {
    tracker.fail('publish', messageFor(error));
    throw error;
  }

  tracker.start('prepare');
  let prepared;
  try {
    prepared = await api.prepare({
      action: 'seal_bid',
      bidder: input.address,
      auctionId: input.auctionId.toString(),
      commitment: bytesToHex(bundle.commitment),
      envelopeHash: bytesToHex(bundle.envelopeHash),
    });
    tracker.done('prepare', `fee ${prepared.minResourceFee} stroops`);
  } catch (error) {
    tracker.fail('prepare', messageFor(error));
    throw error;
  }

  tracker.start('sign');
  let signed: string;
  try {
    signed = await signEnvelope(prepared.xdr, input.networkPassphrase, input.address);
    tracker.done('sign');
  } catch (error) {
    tracker.fail('sign', messageFor(error));
    throw error;
  }

  tracker.start('submit');
  let submission: SubmitResponseDto;
  try {
    submission = await api.submit(signed, input.sponsor ?? true);
    tracker.done('submit', submission.hash.slice(0, 12) + '…');
  } catch (error) {
    tracker.fail('submit', messageFor(error));
    throw error;
  }

  return {
    bundle,
    submission,
    backup: {
      version: SEALED_BID_VERSION,
      auctionId: input.auctionId.toString(),
      amount: input.amount.toString(),
      salt: bytesToHex(bundle.salt),
      commitment: bytesToHex(bundle.commitment),
      envelope: bundle.envelope,
    },
  };
}

// ---------------------------------------------------------------------------
// Generic lifecycle action
// ---------------------------------------------------------------------------

async function runAction(
  action: string,
  body: Record<string, unknown>,
  address: string,
  networkPassphrase: string,
  onProgress?: FlowProgress,
): Promise<SubmitResponseDto> {
  const tracker = new StepTracker(
    [
      { id: 'prepare', label: 'Simulating the call' },
      { id: 'sign', label: 'Waiting for your signature' },
      { id: 'submit', label: 'Submitting to Stellar' },
    ],
    onProgress,
  );

  tracker.start('prepare');
  let prepared;
  try {
    prepared = await api.prepare({ action, ...body });
    tracker.done('prepare', `fee ${prepared.minResourceFee} stroops`);
  } catch (error) {
    tracker.fail('prepare', messageFor(error));
    throw error;
  }

  tracker.start('sign');
  let signed: string;
  try {
    signed = await signEnvelope(prepared.xdr, networkPassphrase, address);
    tracker.done('sign');
  } catch (error) {
    tracker.fail('sign', messageFor(error));
    throw error;
  }

  tracker.start('submit');
  try {
    const submission = await api.submit(signed, false);
    tracker.done('submit', submission.hash.slice(0, 12) + '…');
    return submission;
  } catch (error) {
    tracker.fail('submit', messageFor(error));
    throw error;
  }
}

export function revealBidFlow(
  input: {
    auctionId: bigint;
    bidder: string;
    amount: bigint;
    salt: Uint8Array;
    envelope: string;
    networkPassphrase: string;
    onProgress?: FlowProgress;
  },
): Promise<SubmitResponseDto> {
  return runAction(
    'reveal_bid',
    {
      bidder: input.bidder,
      auctionId: input.auctionId.toString(),
      amount: input.amount.toString(),
      salt: bytesToHex(input.salt),
      envelope: input.envelope,
    },
    input.bidder,
    input.networkPassphrase,
    input.onProgress,
  );
}

export function fundBidFlow(input: {
  auctionId: bigint;
  bidder: string;
  amount: bigint;
  networkPassphrase: string;
  onProgress?: FlowProgress;
}): Promise<SubmitResponseDto> {
  return runAction(
    'fund_bid',
    { bidder: input.bidder, auctionId: input.auctionId.toString(), amount: input.amount.toString() },
    input.bidder,
    input.networkPassphrase,
    input.onProgress,
  );
}

export function claimFlow(input: {
  auctionId: bigint;
  claimant: string;
  networkPassphrase: string;
  onProgress?: FlowProgress;
}): Promise<SubmitResponseDto> {
  return runAction(
    'claim',
    { claimant: input.claimant, auctionId: input.auctionId.toString() },
    input.claimant,
    input.networkPassphrase,
    input.onProgress,
  );
}

/**
 * Release escrow.
 *
 * Permissionless on-chain: any account can pay the fee and the outcome is the same
 * deterministic function of state, so the UI offers it to whoever is connected. The
 * relayer's worker does this too — this button exists so a stuck queue is never a
 * reason to wait.
 */
export function settleFlow(input: {
  auctionId: bigint;
  source: string;
  networkPassphrase: string;
  onProgress?: FlowProgress;
}): Promise<SubmitResponseDto> {
  return runAction(
    'settle',
    { source: input.source, auctionId: input.auctionId.toString() },
    input.source,
    input.networkPassphrase,
    input.onProgress,
  );
}

export function createAuctionFlow(input: {
  seller: string;
  reservePrice: bigint;
  bond: bigint;
  sellerBond: bigint;
  commitWindowLedgers: number;
  revealWindowLedgers: number;
  fundingWindowLedgers: number;
  networkPassphrase: string;
  onProgress?: FlowProgress;
}): Promise<SubmitResponseDto> {
  return runAction(
    'create_auction',
    {
      seller: input.seller,
      reservePrice: input.reservePrice.toString(),
      bond: input.bond.toString(),
      sellerBond: input.sellerBond.toString(),
      commitWindowLedgers: input.commitWindowLedgers,
      revealWindowLedgers: input.revealWindowLedgers,
      fundingWindowLedgers: input.fundingWindowLedgers,
    },
    input.seller,
    input.networkPassphrase,
    input.onProgress,
  );
}

export function cancelAuctionFlow(input: {
  auctionId: bigint;
  seller: string;
  networkPassphrase: string;
  onProgress?: FlowProgress;
}): Promise<SubmitResponseDto> {
  return runAction(
    'cancel_auction',
    { seller: input.seller, auctionId: input.auctionId.toString() },
    input.seller,
    input.networkPassphrase,
    input.onProgress,
  );
}
