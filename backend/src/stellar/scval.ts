/**
 * Hand-rolled Soroban value encoding.
 *
 * We do not use generated bindings, so this module owns the mapping from our
 * contract's Rust types to `xdr.ScVal`. Two rules matter and both are easy to get
 * subtly wrong:
 *
 * 1. **Structs are maps with `Symbol` keys, sorted ascending.** Soroban requires
 *    `ScMap` keys to be in canonical order, and the canonical order for symbols is
 *    plain byte order of the symbol text. `structScVal` sorts, so a caller cannot
 *    forget.
 * 2. **Unit-only `#[contracttype]` enums are a one-element vector of the variant
 *    name.** So `Phase::Sealed` is `["Sealed"]`, not `0` and not a bare symbol.
 *    Decoders here accept every shape we have ever seen emitted, because silently
 *    reading `phase` wrong would mislead every UI that depends on it.
 *
 * `BytesN<N>` and `Bytes` share an XDR representation (`scvBytes`) with a length
 * check on the host side, so fixed-width byte arguments are encoded as plain bytes.
 */

import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

import { describeScVal, scValDiscriminant } from './xdr-shape.ts';
import { EncodingError } from '../util/bytes.ts';

export type ScVal = xdr.ScVal;

/** A `Symbol`. */
export function sym(name: string): ScVal {
  return xdr.ScVal.scvSymbol(name);
}

/**
 * A `#[contracttype]` struct: a map of symbol keys to values, sorted by key bytes.
 *
 * Throws on an empty field set because an empty map on a struct argument always
 * means the caller passed the wrong shape.
 */
export function structScVal(fields: Record<string, ScVal>): ScVal {
  const names = Object.keys(fields);
  if (names.length === 0) {
    throw new EncodingError('structScVal requires at least one field');
  }
  const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return xdr.ScVal.scvMap(
    sorted.map(
      (name) =>
        new xdr.ScMapEntry({ key: sym(name), val: fields[name] as ScVal }),
    ),
  );
}

/** A `Vec<T>`. */
export function vecScVal(items: readonly ScVal[]): ScVal {
  return xdr.ScVal.scvVec([...items]);
}

/** `Bytes` / `BytesN<N>`. */
export function bytesScVal(bytes: Uint8Array): ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

export function u32ScVal(value: number): ScVal {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new EncodingError(`u32 out of range: ${value}`);
  }
  return nativeToScVal(value, { type: 'u32' });
}

/**
 * `u64` takes a bigint deliberately.
 *
 * A `number` would silently lose precision above 2^53, and the resulting wrong
 * auction id would simulate as `AuctionNotFound` — a confusing symptom a long way
 * from the cause.
 */
export function u64ScVal(value: bigint): ScVal {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new EncodingError(`u64 out of range: ${value}`);
  }
  return nativeToScVal(value, { type: 'u64' });
}

export function i128ScVal(value: bigint): ScVal {
  const min = -(1n << 127n);
  const max = (1n << 127n) - 1n;
  if (value < min || value > max) {
    throw new EncodingError(`i128 out of range: ${value}`);
  }
  return nativeToScVal(value, { type: 'i128' });
}

/** A `bool`. */
export function boolScVal(value: boolean): ScVal {
  return nativeToScVal(value, { type: 'bool' });
}

/** An `Address`, from a strkey `G...` (account) or `C...` (contract). */
export function addressScVal(strkey: string): ScVal {
  return new Address(strkey).toScVal();
}

/** `Option::Some` / `Option::None`. */
export function optionScVal(value: ScVal | undefined): ScVal {
  return value ?? xdr.ScVal.scvVoid();
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Decode an ScVal to plain JS. Wrapper so decoding stays one import away. */
export function toNative(value: ScVal): unknown {
  return scValToNative(value);
}

export function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new EncodingError(`${field}: expected an integer, got ${describe(value)}`);
}

export function asNumber(value: unknown, field: string): number {
  const big = typeof value === 'number' ? value : Number(asBigInt(value, field));
  if (!Number.isSafeInteger(big)) {
    throw new EncodingError(`${field}: ${big} is not a safe integer`);
  }
  return big;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new EncodingError(`${field}: expected a boolean, got ${describe(value)}`);
}

export function asString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new EncodingError(`${field}: expected a string, got ${describe(value)}`);
}

export function asBytes32(value: unknown, field: string): Uint8Array {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) {
      throw new EncodingError(`${field}: expected 32 bytes, got ${value.length}`);
    }
    return new Uint8Array(value);
  }
  if (value instanceof Uint8Array) return asBytes32(Buffer.from(value), field);
  throw new EncodingError(`${field}: expected bytes, got ${describe(value)}`);
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new EncodingError(`${field}: expected a struct, got ${describe(value)}`);
}

export function asArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new EncodingError(`${field}: expected a vector, got ${describe(value)}`);
}

/** `Option<T>` arrives as either `null`, `undefined`, or the value itself. */
export function asOption<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  return value as T;
}

/**
 * Normalise a unit-only enum.
 *
 * Accepts the shapes we might see across SDK and host versions: `["Sealed"]` (the
 * documented encoding), a bare `"Sealed"` symbol, a numeric discriminant, or an
 * object with a `tag`/`name` field. Being tolerant here is cheap; being wrong is
 * expensive.
 */
export function asEnumName(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === 'string') return first;
    if (value.length === 0) throw new EncodingError(`${field}: enum vector was empty`);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['tag', 'name', 'value', 'variant']) {
      const candidate = record[key];
      if (typeof candidate === 'string') return candidate;
    }
  }
  throw new EncodingError(`${field}: cannot read an enum name from ${describe(value)}`);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
}

/**
 * Pull a contract error code out of an `scvError` value.
 *
 * The XDR shape is `{"error":{"contract":13}}`. Different SDK builds have spelled
 * that key `contract` or `contractError`, so both are accepted rather than trusting
 * one spelling.
 */
export function errorCodeFromScVal(value: ScVal): number | undefined {
  if (scValDiscriminant(value) !== 'error') return undefined;

  const text = JSON.stringify(value);
  const match = /"(?:contract|contractError)":\s*(\d+)/.exec(text);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Escape hatch for logging an ScVal whose shape we do not recognise. */
export function inspectScVal(value: ScVal): string {
  return describeScVal(value);
}
