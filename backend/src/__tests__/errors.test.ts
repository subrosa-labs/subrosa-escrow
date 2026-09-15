/**
 * Contract error classification.
 *
 * The distinction that matters operationally is retryable versus fatal. A `PhaseTooEarly`
 * means "wake up later"; a `CommitmentMismatch` means a human must look at the
 * envelope, and retrying forever would just burn fees while hiding the bug.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_ERRORS,
  contractErrorName,
  isRetryable,
  parseContractErrorCode,
  SubmissionError,
} from '../stellar/errors.ts';

describe('parseContractErrorCode', () => {
  it('reads the code out of a Soroban simulation error string', () => {
    expect(parseContractErrorCode('HostError: Error(Contract, #13)')).toBe(13);
    expect(parseContractErrorCode('Error(Contract, #22)')).toBe(22);
  });

  it('returns undefined when there is no contract error', () => {
    expect(parseContractErrorCode('HostError: Error(WasmVm, InvalidAction)')).toBeUndefined();
    expect(parseContractErrorCode('network unreachable')).toBeUndefined();
  });
});

describe('contractErrorName', () => {
  it('names every code the contract can return', () => {
    for (let code = 1; code <= 33; code++) {
      expect(CONTRACT_ERRORS[code]).toBeDefined();
      expect(contractErrorName(code)).not.toMatch(/^UnknownError/);
    }
  });

  it('names the codes this service actually branches on', () => {
    // These four decide whether the orchestrator retries, skips, or escalates.
    expect(contractErrorName(6)).toBe('InvalidPhase');
    expect(contractErrorName(13)).toBe('CommitmentMismatch');
    expect(contractErrorName(17)).toBe('BeaconUnavailable');
    expect(contractErrorName(32)).toBe('PhaseTooEarly');
  });

  it('does not pretend to know a code it has never seen', () => {
    expect(contractErrorName(9_999)).toBe('UnknownError(9999)');
  });
});

describe('isRetryable', () => {
  it('retries transport-level failures', () => {
    expect(isRetryable(new SubmissionError('socket closed'))).toBe(true);
  });

  it('retries a premature call', () => {
    expect(
      isRetryable(new SubmissionError('too early', { contractErrorCode: 32 })),
    ).toBe(true);
  });

  it('does not retry a deterministic protocol failure', () => {
    expect(
      isRetryable(new SubmissionError('bad opening', { contractErrorCode: 13 })),
    ).toBe(false);
    expect(
      isRetryable(new SubmissionError('bad quorum', { contractErrorCode: 18 })),
    ).toBe(false);
  });

  it('does not retry things that are not submission errors', () => {
    expect(isRetryable(new Error('boom'))).toBe(false);
    expect(isRetryable('boom')).toBe(false);
  });

  it('carries the name alongside the code for logs', () => {
    const error = new SubmissionError('nope', {
      contractErrorCode: 14,
      contractErrorName: contractErrorName(14),
    });
    expect(error.detail.contractErrorName).toBe('EnvelopeHashMismatch');
  });
});
