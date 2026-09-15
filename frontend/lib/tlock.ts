/**
 * Browser-side sealing.
 *
 * This is where the privacy guarantee is actually established: `sealBid` runs in the
 * user's tab, and the only things that leave it are an age-armored ciphertext and a
 * 32-byte hash. The plaintext — the amount and the salt — exists in this tab and
 * nowhere else until the reveal round publishes the decryption key.
 *
 * Two consequences worth stating plainly to users:
 *
 * * **The bid is binding.** Once sealed, anyone can open it at the reveal round,
 *   including us. There is no "withdraw my bid" — that is the point, because the
 *   alternative is a bidder who refuses to reveal.
 * * **Losing the salt is not fatal.** The salt is inside the envelope, and the envelope
 *   is submitted on-chain. Losing the local copy means losing the ability to reveal
 *   *early* or to reveal if the bulletin loses your envelope. The UI nags about keeping
 *   it anyway.
 *
 * `tlock-js` is imported lazily so it never lands in the server bundle, and so the
 * landing page does not pay for it.
 */

import {
  bytesEqual,
  bytesToHex,
  computeCommitment,
  concatBytes,
  hexToBytes32,
  type Bytes,
} from './commitment.ts';
import { isRoundPublished, roundTime, type DrandChain } from './drand.ts';

/** Must match `SEALED_BID_VERSION` in `backend/src/drand/sealed-bid.ts`. */
export const SEALED_BID_VERSION = 1;

export interface SealedBidPlaintext {
  v: number;
  auctionId: string;
  amount: string;
  salt: string;
  commitment: string;
  revealRound: number;
  chainHash: string;
  bidder?: string;
  createdAt?: number;
}

export interface SealBidParams {
  readonly auctionId: bigint;
  readonly amount: bigint;
  readonly revealRound: number;
  readonly chain: DrandChain;
  readonly bidder?: string;
  /** Deterministic salt, for tests. Never reuse one in production. */
  readonly salt?: Bytes;
}

export interface SealedBidBundle {
  /** age-armored ciphertext. Submit this to the bulletin. */
  readonly envelope: string;
  /** `sha256(envelope)` — goes on-chain as `envelope_hash`. */
  readonly envelopeHash: Bytes;
  /** `sha256(preimage)` — goes on-chain as the bid commitment. */
  readonly commitment: Bytes;
  /** What the contract will compare against at reveal time. */
  readonly salt: Bytes;
  /** Decrypted form, for local display only. */
  readonly plaintext: SealedBidPlaintext;
  readonly envelopeBytes: number;
}

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

async function loadTlock() {
  // Lazily imported so the crypto stack is only pulled in when someone actually seals.
  return import('tlock-js');
}

/** sha256 via Web Crypto. */
async function sha256(bytes: Bytes): Promise<Bytes> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes) as unknown as BufferSource);
  return new Uint8Array(digest);
}

/**
 * Refuse to seal against a round that is already live.
 *
 * tlock will happily encrypt to a past round. The result looks like a sealed envelope
 * but can be read by anyone immediately, so this guard is a privacy control, not a
 * convenience check.
 */
export function assertSealableRound(round: number, chain: DrandChain, nowMs = Date.now()): void {
  if (isRoundPublished(round, chain, nowMs)) {
    throw new SealError(
      `round ${round} was published at ${new Date(roundTime(round, chain) * 1000).toLocaleString()} — ` +
        'sealing to it would expose this bid immediately. Ask the relayer for a fresh auction round.',
    );
  }
}

/** Canonical, deterministic encoding of the sealed payload. */
export function encodePlaintext(plaintext: SealedBidPlaintext): Bytes {
  const ordered: Record<string, unknown> = {
    v: plaintext.v,
    auctionId: plaintext.auctionId,
    amount: plaintext.amount,
    salt: plaintext.salt,
    commitment: plaintext.commitment,
    revealRound: plaintext.revealRound,
    chainHash: plaintext.chainHash,
  };
  if (plaintext.bidder !== undefined) ordered.bidder = plaintext.bidder;
  if (plaintext.createdAt !== undefined) ordered.createdAt = plaintext.createdAt;
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(ordered)));
}

export function decodePlaintext(bytes: Bytes): SealedBidPlaintext {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SealedBidPlaintext;
  if (parsed.v !== SEALED_BID_VERSION) {
    throw new SealError(`unsupported sealed bid version ${parsed.v}`);
  }
  if (!/^\d+$/.test(parsed.amount) || !/^\d+$/.test(parsed.auctionId)) {
    throw new SealError('sealed bid has a non-numeric amount or auction id');
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.salt)) {
    throw new SealError('sealed bid has a malformed salt');
  }
  return parsed;
}

export async function sealBid(params: SealBidParams): Promise<SealedBidBundle> {
  const { auctionId, amount, revealRound, chain } = params;

  assertSealableRound(revealRound, chain);
  if (amount <= 0n) throw new SealError('a bid must be greater than zero');

  const salt = params.salt ?? (await import('./commitment.ts')).randomSalt();
  const commitment = await computeCommitment({ auctionId, amount, salt });

  const plaintext: SealedBidPlaintext = {
    v: SEALED_BID_VERSION,
    auctionId: auctionId.toString(),
    amount: amount.toString(),
    salt: bytesToHex(salt),
    commitment: bytesToHex(commitment),
    revealRound,
    chainHash: chain.chainHash,
    ...(params.bidder ? { bidder: params.bidder } : {}),
    createdAt: Math.floor(Date.now() / 1000),
  };

  const { timelockEncrypt, mainnetClient, Buffer: TlockBuffer } = await loadTlock();
  const payload = TlockBuffer.from(encodePlaintext(plaintext));

  let envelope: string;
  try {
    envelope = await timelockEncrypt(revealRound, payload, mainnetClient());
  } catch (error) {
    throw new SealError(
      `could not reach the drand beacon to seal this bid (${
        error instanceof Error ? error.message : String(error)
      }). Your bid was not sent anywhere.`,
    );
  }

  const envelopeBytes = new TextEncoder().encode(envelope);

  return {
    envelope,
    envelopeHash: await sha256(envelopeBytes),
    commitment,
    salt,
    plaintext,
    envelopeBytes: envelopeBytes.length,
  };
}

export interface OpenedBid {
  readonly plaintext: SealedBidPlaintext;
  readonly amount: bigint;
  readonly salt: Bytes;
  /** Re-derived from the plaintext, not read from it. */
  readonly commitment: Bytes;
}

/**
 * Open an envelope in the browser.
 *
 * Used by the "reveal" button so that a bidder can always unseal their own bid even if
 * our relayer is offline — the ciphertext is on-chain, so a reveal needs only the
 * beacon, not us.
 */
export async function openEnvelope(envelope: string, chain: DrandChain): Promise<OpenedBid> {
  const { timelockDecrypt, mainnetClient } = await loadTlock();

  let bytes: Bytes;
  try {
    const decrypted = await timelockDecrypt(envelope, mainnetClient());
    bytes = new Uint8Array(decrypted);
  } catch (error) {
    throw new SealError(
      `could not open this envelope — the reveal round may not be published yet (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  const plaintext = decodePlaintext(bytes);
  if (plaintext.chainHash !== chain.chainHash) {
    throw new SealError('this envelope was sealed to a different drand chain');
  }

  const salt = hexToBytes32(plaintext.salt, 'salt');
  const amount = BigInt(plaintext.amount);
  const commitment = await computeCommitment({ auctionId: BigInt(plaintext.auctionId), amount, salt });

  const declared = hexToBytes32(plaintext.commitment, 'commitment');
  if (!bytesEqual(declared, commitment)) {
    throw new SealError('this envelope does not match its own commitment; do not trust its contents');
  }

  return { plaintext, amount, salt, commitment };
}

/** `sha256(envelope)` for a ciphertext the user holds locally. */
export async function envelopeHashOf(envelope: string): Promise<Bytes> {
  return sha256(new TextEncoder().encode(envelope));
}

/** Bytes helper re-exported so components do not reach into `commitment.ts`. */
export { concatBytes };
