/**
 * Human-readable names for `Error` codes coming back from the contract.
 *
 * Kept in lockstep with `contracts/subrosa_escrow/src/errors.rs`. Without this, a
 * failed settlement surfaces in the logs as `Error(Contract, #22)` and somebody has
 * to go read Rust to find out what happened.
 */

export const CONTRACT_ERRORS: Readonly<Record<number, string>> = {
  1: 'NotInitialized',
  2: 'AlreadyInitialized',
  3: 'Paused',
  4: 'Unauthorized',
  5: 'AuctionNotFound',
  6: 'InvalidPhase',
  7: 'InvalidWindow',
  8: 'InvalidParam',
  9: 'InvalidBond',
  10: 'BidExists',
  11: 'BidNotFound',
  12: 'BidCapReached',
  13: 'CommitmentMismatch',
  14: 'EnvelopeHashMismatch',
  15: 'AlreadyRevealed',
  16: 'BidNotRevealed',
  17: 'BeaconUnavailable',
  18: 'AttestationInvalid',
  19: 'AttestationRoundMismatch',
  20: 'DuplicateSigner',
  21: 'ThresholdNotConfigured',
  22: 'InsufficientEscrow',
  23: 'NothingToClaim',
  24: 'AlreadyWithdrawn',
  25: 'ArithmeticOverflow',
  26: 'RevealRoundNotInFuture',
  27: 'ReserveNotMet',
  28: 'FeesExceedMax',
  29: 'SellerCannotBid',
  30: 'TooManyRelayers',
  31: 'InvalidEnvelope',
  32: 'PhaseTooEarly',
  33: 'NonPositiveAmount',
};

/** Errors that mean "try again later", rather than "this will never work". */
export const RETRYABLE_CONTRACT_ERRORS: ReadonlySet<string> = new Set(['PhaseTooEarly']);

/** Errors that mean our own configuration or data is wrong, and a human must look. */
export const FATAL_CONTRACT_ERRORS: ReadonlySet<string> = new Set([
  'CommitmentMismatch',
  'EnvelopeHashMismatch',
  'AttestationInvalid',
  'AttestationRoundMismatch',
  'DuplicateSigner',
  'ThresholdNotConfigured',
  'ArithmeticOverflow',
  'NotInitialized',
]);

export function contractErrorName(code: number): string {
  return CONTRACT_ERRORS[code] ?? `UnknownError(${code})`;
}

const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

/** Pull a contract error code out of an RPC simulation error string. */
export function parseContractErrorCode(message: string): number | undefined {
  const match = CONTRACT_ERROR_PATTERN.exec(message);
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}

export class SubmissionError extends Error {
  constructor(
    message: string,
    readonly detail: {
      readonly hash?: string;
      readonly contractErrorCode?: number;
      readonly contractErrorName?: string;
      readonly raw?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'SubmissionError';
  }
}

/** True when the failure is worth another attempt. */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof SubmissionError)) return false;
  if (error.detail.contractErrorCode === undefined) return true;
  const name = contractErrorName(error.detail.contractErrorCode);
  return RETRYABLE_CONTRACT_ERRORS.has(name);
}
