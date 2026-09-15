/**
 * Response shapes from the relayer API.
 *
 * Every integer that can exceed 2^53 travels as a decimal string, so the UI never has
 * to reason about float precision. Formatting helpers in `format.ts` handle display.
 */

export type Phase = 'Sealed' | 'Reveal' | 'Funding' | 'Settled' | 'Cancelled' | 'Failed';

export const TERMINAL_PHASES: readonly Phase[] = ['Settled', 'Cancelled', 'Failed'];

export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** A revealed bid, as far as the UI is concerned. */
export interface RevealedBidDto {
  readonly bidder: string;
  readonly amount: string;
}

export interface AuctionDto {
  readonly id: string;
  readonly seller: string;
  readonly reservePrice: string;
  readonly bond: string;
  readonly sellerBond: string;
  /** Ledger sequence, not a timestamp. */
  readonly commitDeadline: number;
  readonly revealDeadline: number;
  readonly fundingDeadline: number;
  readonly revealRound: number;
  readonly phase: Phase;
  readonly sealedCount: number;
  readonly revealedCount: number;
  readonly escrowed: string;
  readonly claimed: string;
  readonly slashed: string;
  readonly cancelCompensation: string;
  readonly beacon: { readonly round: number; readonly randomness: string } | null;
  readonly winner: string | null;
  readonly hammerPrice: string;
  readonly revealed: readonly RevealedBidDto[];
}

export interface AuctionTiming {
  readonly now: number;
  /** Where the chain is. `null` when the RPC did not answer. */
  readonly currentLedger: number | null;
  readonly commitClosesInMs: number;
  readonly revealRoundPublishesAt: number;
  readonly revealRoundAvailable: boolean;
  /** Ledgers left in each window; negative once it has closed. */
  readonly commitLedgersRemaining: number | null;
  readonly revealLedgersRemaining: number | null;
  readonly fundingLedgersRemaining: number | null;
  readonly terminal: boolean;
}

/**
 * Which windows are open.
 *
 * Derived from ledger distance rather than from the phase name, because the phase is a
 * coarser boundary than the operations themselves: `reveal_bid` and `fund_bid` stay
 * callable through the whole funding window even though the phase has already moved on.
 */
export interface Windows {
  readonly sealing: boolean;
  readonly revealAndFunding: boolean;
  /** True once settlement may be called by anyone. */
  readonly settlement: boolean;
  readonly canCancel: boolean;
}

export function windowsOf(phase: Phase, timing: AuctionTiming): Windows {
  if (timing.terminal) {
    return { sealing: false, revealAndFunding: false, settlement: false, canCancel: false };
  }

  const commitRemaining = timing.commitLedgersRemaining;
  const fundRemaining = timing.fundingLedgersRemaining;

  // Without a ledger height we fall back to the phase and the beacon clock, which are
  // both still authoritative about sealing. Settlement is the one call that needs the
  // funding deadline, so it stays hidden rather than risk a rejected transaction.
  if (commitRemaining === null || fundRemaining === null) {
    const sealing = phase === 'Sealed' && !timing.revealRoundAvailable;
    return {
      sealing,
      revealAndFunding: !sealing && (phase === 'Reveal' || phase === 'Funding'),
      settlement: false,
      canCancel: sealing,
    };
  }

  return {
    sealing: phase === 'Sealed' && commitRemaining >= 0,
    revealAndFunding: commitRemaining < 0 && fundRemaining >= 0,
    settlement: fundRemaining < 0,
    canCancel: phase === 'Sealed' && commitRemaining >= 0,
  };
}

export interface AttestationDto {
  readonly round: number;
  readonly randomness: string;
  readonly signers: readonly number[];
  readonly committeeSize: number;
  readonly threshold: number;
  readonly createdAt: string;
}

export interface AuctionDetailDto {
  readonly auction: AuctionDto;
  readonly envelopes: number;
  readonly attestation: AttestationDto | null;
  readonly claimable: string | null;
  readonly timing: AuctionTiming;
}

export interface BidDto {
  readonly bidder: string;
  readonly commitment: string;
  readonly envelopeHash: string;
  readonly bond: string;
  readonly funded: string;
  readonly revealed: boolean;
  readonly revealedAmount: string;
  readonly settled: boolean;
  /** `revealed && funded < revealedAmount`: the bond is forfeit. */
  readonly disqualified: boolean;
}

export interface EnvelopeDto {
  readonly bidder: string;
  readonly commitment: string;
  readonly envelopeHash: string;
  readonly envelope: string;
  readonly createdAt: string;
}

export interface ConfigDto {
  readonly admin: string;
  readonly settlementToken: string;
  readonly treasury: string;
  readonly feeBps: number;
  readonly tokenDecimals: number;
  readonly relayerThreshold: number;
  readonly relayerCommitteeSize: number;
  readonly chainHash: string;
  readonly drandGenesis: number;
  readonly drandPeriod: number;
  readonly maxBids: number;
  readonly assumedLedgerSeconds: number;
  readonly marginRounds: number;
  readonly minBond: string;
  readonly minRevealLeadLedgers: number;
  readonly paused: boolean;
}

export interface DrandInfoDto {
  readonly beaconId: string;
  readonly chainHash: string;
  readonly publicKey: string;
  readonly schemeId: string;
  readonly periodSeconds: number;
  readonly genesisTime: number;
  readonly latestRound: number;
  readonly nextRound: number;
  readonly nextRoundInMs: number;
}

export interface HealthDto {
  readonly ok: boolean;
  readonly network: string;
  readonly networkPassphrase?: string;
  readonly contractId: string | null;
  readonly ledger: number | null;
  readonly chain: string;
  readonly rpc: string;
  readonly preflight: readonly string[];
}

export interface PrepareResponseDto {
  readonly action: string;
  readonly xdr: string;
  readonly source: string;
  readonly contractId: string;
  readonly minResourceFee: string;
  readonly latestLedger: number;
  readonly networkPassphrase: string;
  readonly instructions: string;
}

export interface SubmitResponseDto {
  readonly hash: string;
  readonly ledger: number;
  readonly sponsored: boolean;
  readonly returnValueXdr: string | null;
  readonly explorerUrl: string;
}

export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
  readonly contractErrorCode?: number | null;
  readonly contractErrorName?: string | null;
}

/** Where an auction is, in plain language, for the headline of a card. */
export function phaseCopy(phase: Phase): { label: string; blurb: string } {
  switch (phase) {
    case 'Sealed':
      return {
        label: 'Sealing',
        blurb: 'Bids are being accepted. Every bid is encrypted and nobody can read it yet.',
      };
    case 'Reveal':
      return {
        label: 'Opening',
        blurb: 'The reveal round has landed. Envelopes can be opened by anyone, including you.',
      };
    case 'Funding':
      return {
        label: 'Funding',
        blurb: 'The provisional winner is escrowing the full amount. Under-funded bids lose their bond.',
      };
    case 'Settled':
      return { label: 'Settled', blurb: 'Escrow released to the seller. Losing bids are refundable.' };
    case 'Cancelled':
      return { label: 'Cancelled', blurb: 'Bids never became binding. Bonds are refundable.' };
    case 'Failed':
      return { label: 'Failed', blurb: 'No bid met the reserve. Every funded bid is refundable.' };
  }
}
