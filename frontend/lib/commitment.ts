/**
 * Canonical encodings, browser side.
 *
 * ## Why this is duplicated from the backend instead of shared
 *
 * Because it has to be. The whole privacy claim is that no plaintext bid ever reaches
 * a server, so the commitment and the ciphertext are computed *here*, in the browser,
 * and only a hash is sent. Importing the backend's implementation would drag the
 * relayer's code into the client bundle and, worse, invite a future refactor where the
 * "convenient" path is to let the server compute it.
 *
 * Duplication is therefore deliberate, and the mitigation is a golden-vector test in
 * `lib/__tests__/commitment.test.ts` that pins the same bytes the contract's Rust tests
 * pin. Drift fails in CI.
 *
 * ```text
 * commitment = sha256("subrosa.bid.v1" || auction_id || amount || salt)
 *              ^ 14 bytes            ^ u64 BE     ^ i128 BE  ^ 32 bytes
 * ```
 *
 * The bidder's address is intentionally absent: `seal_bid` files a bid under the
 * address that authenticated the call, and `reveal_bid` looks it up under that same
 * address, so a stranger who learns an opening can only ever credit the real bidder.
 * Binding `auction_id` is what stops an opening from being replayed into another
 * auction.
 */

/** ASCII domain separator. Must equal `DOMAIN_BID` in `contracts/.../lib.rs`. */
export const BID_DOMAIN = 'subrosa.bid.v1';

export const BID_PREIMAGE_LEN = 70;

export type Bytes = Uint8Array;

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

/** `sha256` via Web Crypto, so the browser needs no crypto dependency. */
export async function sha256(bytes: Bytes): Promise<Bytes> {
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view as unknown as BufferSource);
  return new Uint8Array(digest);
}

export function bytesToHex(bytes: Bytes): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Bytes {
  const normalised = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalised.length === 0 || normalised.length % 2 !== 0) {
    throw new EncodingError('hex string must have an even, non-zero length');
  }
  if (!/^[0-9a-fA-F]*$/.test(normalised)) {
    throw new EncodingError('hex string contains non-hex characters');
  }
  const out = new Uint8Array(normalised.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalised.substr(i * 2, 2), 16);
  }
  return out;
}

export function hexToBytes32(hex: string, field = 'value'): Bytes {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) {
    throw new EncodingError(`${field} must be 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

export function concatBytes(...chunks: readonly Bytes[]): Bytes {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * `u64` big-endian, exactly like Rust's `u64::to_be_bytes`.
 *
 * Takes a bigint so that a large auction id cannot be silently mangled by float
 * precision.
 */
export function u64be(value: bigint): Bytes {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new EncodingError(`u64 out of range: ${value}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, false);
  return out;
}

/**
 * `i128` big-endian two's complement, exactly like Rust's `i128::to_be_bytes`.
 *
 * Amounts above 2^53 appear in perfectly ordinary auctions, so this cannot go through
 * a `number`. A silent divergence here would produce commitments the contract rejects
 * at reveal time — after the bond is escrowed.
 */
export function i128be(value: bigint): Bytes {
  const min = -(1n << 127n);
  const max = (1n << 127n) - 1n;
  if (value < min || value > max) {
    throw new EncodingError(`i128 out of range: ${value}`);
  }
  const out = new Uint8Array(16);
  let remaining = value < 0n ? value + (1n << 128n) : value;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

export function utf8(text: string): Bytes {
  return new Uint8Array(new TextEncoder().encode(text));
}

export interface CommitmentInput {
  readonly auctionId: bigint;
  readonly amount: bigint;
  /** 32-byte salt. */
  readonly salt: Bytes;
}

export function bidPreimage(input: CommitmentInput): Bytes {
  if (input.salt.length !== 32) {
    throw new EncodingError(`salt must be 32 bytes, got ${input.salt.length}`);
  }
  const preimage = concatBytes(
    utf8(BID_DOMAIN),
    u64be(input.auctionId),
    i128be(input.amount),
    input.salt,
  );
  if (preimage.length !== BID_PREIMAGE_LEN) {
    throw new EncodingError(`bid preimage must be ${BID_PREIMAGE_LEN} bytes`);
  }
  return preimage;
}

export async function computeCommitment(input: CommitmentInput): Promise<Bytes> {
  return sha256(bidPreimage(input));
}

export function randomSalt(): Bytes {
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  return salt;
}

/** Constant-time-ish comparison; digests are public, so this is for tidiness. */
export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
