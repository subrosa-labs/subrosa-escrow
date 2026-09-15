/** Byte-level helpers. The canonical encoders in `drand/` are built on these. */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type Bytes = Uint8Array;

export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

export function bytesToHex(bytes: Bytes): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Bytes {
  const normalised = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalised.length === 0 || normalised.length % 2 !== 0) {
    throw new EncodingError(`hex string must have an even, non-zero length: ${hex}`);
  }
  if (!/^[0-9a-fA-F]*$/.test(normalised)) {
    throw new EncodingError(`hex string contains non-hex characters: ${hex}`);
  }
  return new Uint8Array(Buffer.from(normalised, 'hex'));
}

/** Strict 32-byte hex decode, as used for salts, commitments and randomness. */
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

export function utf8(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

export function sha256(bytes: Bytes): Bytes {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

export function randomBytes32(): Bytes {
  return new Uint8Array(randomBytes(32));
}

/** Constant-time equality for digests and secrets. */
export function bytesEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * `u64` big-endian, matching Rust's `u64::to_be_bytes`.
 *
 * Accepts bigint so a caller cannot accidentally lose precision above 2^53.
 */
export function u64be(value: bigint | number): Bytes {
  const asBigInt = typeof value === 'bigint' ? value : BigInt(value);
  if (asBigInt < 0n || asBigInt > 0xffffffffffffffffn) {
    throw new EncodingError(`u64 out of range: ${asBigInt}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, asBigInt, false);
  return out;
}

/**
 * `i128` big-endian two's complement, matching Rust's `i128::to_be_bytes`.
 *
 * This is what makes the commitment encoding agreement with the contract exact for
 * amounts above 2^63 — a silent mismatch here would make every large bid
 * unrevealable.
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

/** Strict decimal-string to bigint, for values that travel as JSON. */
export function decimalToBigInt(value: string, field: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new EncodingError(`${field} must be a decimal integer string, got "${value}"`);
  }
  return BigInt(value);
}
