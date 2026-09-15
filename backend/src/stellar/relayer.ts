/**
 * The transaction pipeline.
 *
 * Four operations, each with one job:
 *
 * * `prepare`  — simulate a contract call against the *user's* account and return an
 *                assembled XDR. Nothing is signed and nothing is broadcast.
 * * `sponsor`  — wrap an already-signed inner transaction in a relayer-paid fee bump,
 *                so a bidder with no XLM can still seal a bid.
 * * `submit`   — broadcast a signed transaction and poll it to a terminal ledger.
 * * `invoke`   — prepare + sign + submit, for the relayer's own calls.
 *
 * Note what is *not* here: any path where the relayer learns a bid. Relayer-signed
 * calls are limited to beacon attestation, reveal of an already-decrypted envelope,
 * settlement, and refunds — all of which operate on data that is public by the time
 * the relayer touches it.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { childLogger, type Logger } from '../logger.ts';
import type { StellarNetwork } from './network.ts';
import { contractErrorName, parseContractErrorCode, SubmissionError, isRetryable } from './errors.ts';
import { describeScVal } from './xdr-shape.ts';

export interface PreparedInvocation {
  readonly method: string;
  readonly contractId: string;
  /** Base64 transaction envelope XDR, unsigned. */
  readonly xdr: string;
  readonly source: string;
  /** Ledger at which the assembled footprint was valid. */
  readonly latestLedger: number;
  /** Fees the network will charge for the declared footprint, in stroops. */
  readonly minResourceFee: bigint;
}

export interface SubmissionResult {
  readonly hash: string;
  readonly ledger: number;
  /** Raw return value as base64 `ScVal` XDR, when the call returned something. */
  readonly returnValueXdr?: string;
  readonly explorerUrl: string;
}

export interface RelayerOptions {
  readonly server: rpc.Server;
  readonly network: StellarNetwork;
  readonly contractId: string;
  /** Base fee per operation, stroops. Defaults to the network minimum. */
  readonly baseFee?: string;
  readonly retries?: number;
  readonly retryBaseMs?: number;
  /** Keypair that pays for sponsored transactions. Omit to disable sponsorship. */
  readonly feeSource?: Keypair;
  readonly logger?: Logger;
}

export class Relayer {
  private readonly log: Logger;
  private readonly contract: Contract;

  constructor(private readonly options: RelayerOptions) {
    this.log = options.logger ?? childLogger('relayer', { contractId: options.contractId });
    this.contract = new Contract(options.contractId);
  }

  get canSponsor(): boolean {
    return this.options.feeSource !== undefined;
  }

  /** Simulate a call and return an assembled, unsigned transaction envelope. */
  async prepare(
    source: string,
    method: string,
    args: readonly xdr.ScVal[] = [],
  ): Promise<PreparedInvocation> {
    const account = await this.options.server.getAccount(source);

    const tx = new TransactionBuilder(account, {
      fee: this.options.baseFee ?? BASE_FEE,
      networkPassphrase: this.options.network.passphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(60)
      .build();

    const simulation = await this.options.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      const code = parseContractErrorCode(simulation.error);
      throw new SubmissionError(
        code === undefined
          ? `simulation of ${method} failed: ${simulation.error}`
          : `simulation of ${method} failed: ${contractErrorName(code)} (contract error #${code})`,
        { ...(code !== undefined ? { contractErrorCode: code, contractErrorName: contractErrorName(code) } : {}), raw: simulation.error },
      );
    }

    const assembled = rpc.assembleTransaction(tx, simulation).build();

    return {
      method,
      contractId: this.options.contractId,
      xdr: assembled.toXDR(),
      source,
      latestLedger: simulation.latestLedger,
      minResourceFee: BigInt(simulation.minResourceFee ?? '0'),
    };
  }

  /** Simulate a read-only call and return the raw `ScVal` return value. */
  async dryRun(
    source: string,
    method: string,
    args: readonly xdr.ScVal[] = [],
  ): Promise<{ ok: true; returnValue?: string } | { ok: false; error: string; code?: number }> {
    try {
      const prepared = await this.prepare(source, method, args);
      const tx = TransactionBuilder.fromXDR(prepared.xdr, this.options.network.passphrase);
      if (!(tx instanceof Transaction)) {
        return { ok: false, error: 'unexpected fee-bump envelope from prepare' };
      }
      const simulation = await this.options.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulation)) {
        const code = parseContractErrorCode(simulation.error);
        return { ok: false, error: simulation.error, ...(code !== undefined ? { code } : {}) };
      }
      const retval = simulation.result?.retval;
      return { ok: true, ...(retval ? { returnValue: retval.toXDR('base64') } : {}) };
    } catch (error) {
      if (error instanceof SubmissionError) {
        return {
          ok: false,
          error: error.message,
          ...(error.detail.contractErrorCode !== undefined ? { code: error.detail.contractErrorCode } : {}),
        };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Wrap a signed inner transaction in a fee bump paid by the relayer.
   *
   * The inner transaction's source still needs a sequence number, so the bidder's
   * account must exist — but it does not need any XLM, which is the point.
   */
  buildFeeBump(signedInnerXdr: string): string {
    const feeSource = this.options.feeSource;
    if (!feeSource) {
      throw new SubmissionError('fee sponsorship is not configured (no fee source keypair)');
    }

    const inner = TransactionBuilder.fromXDR(signedInnerXdr, this.options.network.passphrase);
    if (!(inner instanceof Transaction)) {
      throw new SubmissionError('cannot fee-bump a transaction that is already a fee bump');
    }

    const bump = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      this.options.baseFee ?? BASE_FEE,
      inner,
      this.options.network.passphrase,
    );
    bump.sign(feeSource);
    return bump.toXDR();
  }

  /** Prepare, sign and submit a call from the relayer's own account. */
  async invoke(
    signer: Keypair,
    method: string,
    args: readonly xdr.ScVal[] = [],
  ): Promise<SubmissionResult> {
    const prepared = await this.prepare(signer.publicKey(), method, args);
    const tx = TransactionBuilder.fromXDR(prepared.xdr, this.options.network.passphrase);
    if (!(tx instanceof Transaction)) {
      throw new SubmissionError('prepare returned an unexpected envelope type');
    }
    tx.sign(signer);
    return this.submit(tx.toXDR(), method);
  }

  /** Broadcast a signed transaction and poll to a terminal state, with retries. */
  async submit(signedXdr: string, label = 'transaction'): Promise<SubmissionResult> {
    const retries = this.options.retries ?? 0;
    const baseDelay = this.options.retryBaseMs ?? 1_500;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.submitOnce(signedXdr, label);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === retries) break;
        const delay = baseDelay * 2 ** attempt;
        this.log.warn(
          { label, attempt: attempt + 1, delayMs: delay, err: describeError(error) },
          'retrying transaction',
        );
        await sleep(delay);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async submitOnce(signedXdr: string, label: string): Promise<SubmissionResult> {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.options.network.passphrase);
    const response = await this.options.server.sendTransaction(tx);

    if (response.status === 'ERROR') {
      const detail = response.errorResult?.toXDR('base64') ?? '';
      const message = describeScVal(response.errorResult ?? detail);
      const code = parseContractErrorCode(message);
      throw new SubmissionError(
        code === undefined
          ? `${label} was rejected before inclusion: ${detail}`
          : `${label} was rejected before inclusion: ${contractErrorName(code)} (contract error #${code})`,
        {
          ...(code !== undefined
            ? { contractErrorCode: code, contractErrorName: contractErrorName(code) }
            : {}),
          raw: message,
        },
      );
    }

    if (response.status === 'DUPLICATE') {
      this.log.info({ label, hash: response.hash }, 'transaction already submitted; polling');
    }

    const final = await this.options.server.pollTransaction(response.hash, { attempts: 40 });

    if (final.status !== 'SUCCESS') {
      const diagnostic = extractDiagnostic(final);
      const code = diagnostic ? parseContractErrorCode(diagnostic) : undefined;
      throw new SubmissionError(
        code === undefined
          ? `${label} failed on-ledger with status ${final.status}${diagnostic ? `: ${diagnostic}` : ''}`
          : `${label} failed on-ledger: ${contractErrorName(code)} (contract error #${code})`,
        {
          hash: response.hash,
          ...(code !== undefined
            ? { contractErrorCode: code, contractErrorName: contractErrorName(code) }
            : {}),
          raw: { status: final.status, diagnostic },
        },
      );
    }

    const returnValue = extractReturnValue(final);

    return {
      hash: response.hash,
      ledger: final.ledger,
      ...(returnValue ? { returnValueXdr: returnValue.toXDR('base64') } : {}),
      explorerUrl: `${this.options.network.horizonUrl}/tx/${response.hash}`,
    };
  }

  /** Current ledger sequence, used for deadline arithmetic and diagnostics. */
  async latestLedger(): Promise<number> {
    const ledger = await this.options.server.getLatestLedger();
    return ledger.sequence;
  }
}

/**
 * Pull a contract error out of an on-ledger failure.
 *
 * A Soroban contract error surfaces in the diagnostic event stream as an
 * `scvError` carrying `SCE_CONTRACT` plus the numeric code, so the search is a
 * regex over every diagnostic event's JSON view. If the shape ever changes this
 * returns `undefined` and the caller reports the raw status instead of guessing —
 * a misleading error code would be worse than no error code.
 */
function extractDiagnostic(final: { status: string; diagnosticEvents?: unknown }): string | undefined {
  const events = Array.isArray(final.diagnosticEvents) ? final.diagnosticEvents : [];
  for (const event of events) {
    const record = event as { event?: { body?: unknown } };
    const text = describeScVal(record.event?.body ?? event);
    if (/Error\(Contract,\s*#\d+\)/.test(text)) return text;
    const contractError = /"contractError":\s*(\d+)/.exec(text);
    if (contractError?.[1]) return `Error(Contract, #${contractError[1]})`;
  }
  return undefined;
}

function extractReturnValue(final: unknown): xdr.ScVal | undefined {
  const record = final as { returnValue?: xdr.ScVal } | null;
  return record?.returnValue;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The well-known "null account" used as a simulation source for reads. */
export const SIMULATION_SOURCE = new Account(
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  '0',
).accountId();
