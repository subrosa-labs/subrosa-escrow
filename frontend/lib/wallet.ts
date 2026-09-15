/**
 * Wallet integration.
 *
 * Freighter only. The interface is deliberately narrow — connect, get an address, sign
 * an XDR — because everything interesting lives in the relayer's `prepare` endpoint,
 * which hands back an unsigned envelope. The wallet's only job is to authorise it.
 *
 * Note what the wallet is *not* asked to do: it never sees a bid amount. By the time
 * the transaction is signed, the amount is already inside the ciphertext and the
 * contract only receives a hash.
 */

import type { SubmitResponseDto } from './types.ts';

export interface WalletConnection {
  readonly address: string;
  readonly networkPassphrase: string | null;
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

async function freighter() {
  return import('@stellar/freighter-api');
}

export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** Whether a Freighter extension is present at all. */
export async function isWalletAvailable(): Promise<boolean> {
  if (!isBrowser()) return false;
  try {
    const api = await freighter();
    const result = await api.isConnected();
    return result.isConnected;
  } catch {
    return false;
  }
}

/**
 * Prompt for access and return the address.
 *
 * `requestAccess` is the only call that opens a popup; every other read is silent, so
 * the UI can show a connected state on load without nagging.
 */
export async function connectWallet(): Promise<WalletConnection> {
  if (!isBrowser()) throw new WalletError('a wallet can only be connected in a browser');

  const api = await freighter();
  const access = await api.requestAccess();
  if (access.error) throw new WalletError(access.error.message);
  if (!access.address) {
    throw new WalletError('Freighter did not return an address. Is the extension unlocked?');
  }

  const details = await api.getNetworkDetails();
  const passphrase = details.error ? null : details.networkPassphrase;

  return { address: access.address, networkPassphrase: passphrase };
}

/** Silent read, for restoring a session without prompting. */
export async function currentAddress(): Promise<string | null> {
  if (!isBrowser()) return null;
  try {
    const api = await freighter();
    const allowed = await api.isAllowed();
    if (allowed.error || !allowed.isAllowed) return null;
    const result = await api.getAddress();
    if (result.error || !result.address) return null;
    return result.address;
  } catch {
    return null;
  }
}

export async function currentNetworkPassphrase(): Promise<string | null> {
  if (!isBrowser()) return null;
  try {
    const api = await freighter();
    const details = await api.getNetworkDetails();
    return details.error ? null : details.networkPassphrase;
  } catch {
    return null;
  }
}

/** Ask the wallet to sign an unsigned envelope. Returns signed XDR. */
export async function signEnvelope(xdr: string, networkPassphrase: string, address: string): Promise<string> {
  const api = await freighter();
  const signed = await api.signTransaction(xdr, { networkPassphrase, address });
  if (signed.error) throw new WalletError(signed.error.message);
  if (!signed.signedTxXdr) throw new WalletError('the wallet returned an empty signature');
  return signed.signedTxXdr;
}

/**
 * Split an assemble transaction into the pieces the user should see before signing.
 *
 * The library's `AssembledTransaction` is not available here — the relayer assembled it
 * server-side — so there is nothing to introspect beyond the XDR the relayer already
 * validated. We surface the fee and the contract instead, which is what a careful user
 * actually wants to check.
 */
export interface SigningPreview {
  readonly contractId: string;
  readonly minResourceFee: string;
  readonly networkPassphrase: string;
}

export function describeSigning(prepared: {
  contractId: string;
  minResourceFee: string;
  networkPassphrase: string;
}): SigningPreview {
  return {
    contractId: prepared.contractId,
    minResourceFee: prepared.minResourceFee,
    networkPassphrase: prepared.networkPassphrase,
  };
}

export type { SubmitResponseDto };
