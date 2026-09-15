/**
 * ScVal encoding.
 *
 * The two rules worth testing are the ones that fail *silently* if wrong:
 *
 * * `ScMap` keys must be in canonical (byte-ascending) order. Soroban rejects an
 *   out-of-order map, and the error has nothing to do with the field you got wrong.
 * * `u64` and `i128` must be encoded as 64- and 128-bit values. A 32-bit truncation
 *   would produce a transaction that simulates cleanly against the wrong auction.
 */

import { describe, expect, it } from 'vitest';
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  addressScVal,
  asBigInt,
  asBytes32,
  asEnumName,
  asNumber,
  asOption,
  boolScVal,
  bytesScVal,
  i128ScVal,
  structScVal,
  u32ScVal,
  u64ScVal,
  vecScVal,
} from '../stellar/scval.ts';
import { PHASES, parsePhase } from '../stellar/contract.ts';
import { xdrValue, isXdrType, scValDiscriminant } from '../stellar/xdr-shape.ts';

const SELLER = 'GACDNJLVD52ENYH6CDCYBYXFEO72V3UKRAMQECZAB5H5MZVZ6EJDTHWQ';

describe('integer encodings', () => {
  it('round-trips u32, u64 and i128', () => {
    expect(scValToNative(u32ScVal(4_294_967_295))).toBe(4_294_967_295);
    expect(scValToNative(u64ScVal(18_446_744_073_709_551_615n))).toBe(18_446_744_073_709_551_615n);
    expect(scValToNative(i128ScVal(1_500_000n))).toBe(1_500_000n);
    expect(scValToNative(i128ScVal(2n ** 100n))).toBe(2n ** 100n);
    expect(scValToNative(i128ScVal(-42n))).toBe(-42n);
  });

  it('uses the 64- and 128-bit XDR variants, not a truncating one', () => {
    expect(scValDiscriminant(u64ScVal(1n))).toBe('u64');
    expect(scValDiscriminant(i128ScVal(1n))).toBe('i128');
    expect(scValDiscriminant(u32ScVal(1))).toBe('u32');
  });

  it('refuses out-of-range values instead of wrapping', () => {
    expect(() => u32ScVal(-1)).toThrow(/u32 out of range/);
    expect(() => u32ScVal(2 ** 32)).toThrow(/u32 out of range/);
    expect(() => u64ScVal(-1n)).toThrow(/u64 out of range/);
    expect(() => u64ScVal(2n ** 64n)).toThrow(/u64 out of range/);
    expect(() => i128ScVal(2n ** 127n)).toThrow(/i128 out of range/);
    expect(() => i128ScVal(-(2n ** 127n) - 1n)).toThrow(/i128 out of range/);
  });
});

describe('struct encoding', () => {
  it('sorts symbol keys into canonical byte order', () => {
    const encoded = structScVal({
      seller_bond: i128ScVal(1n),
      reserve_price: i128ScVal(2n),
      bond: i128ScVal(3n),
      commit_window_ledgers: u32ScVal(4),
    });

    expect(scValDiscriminant(encoded)).toBe('map');
    const map = xdrValue(encoded) as xdr.ScMapEntry[];
    const keys = map.map((entry) => {
      const key = xdrValue(entry.key);
      return typeof key === 'string' ? key : Buffer.from(key as Uint8Array).toString('utf8');
    });

    // Byte-ascending, and no accidental reliance on JS object insertion order.
    expect(keys).toEqual([
      'bond',
      'commit_window_ledgers',
      'reserve_price',
      'seller_bond',
    ]);
    for (let i = 1; i < keys.length; i++) {
      expect(Buffer.compare(Buffer.from(keys[i - 1]!), Buffer.from(keys[i]!))).toBeLessThan(0);
    }
  });

  it('produces the same encoding regardless of input order', () => {
    const a = structScVal({ alpha: i128ScVal(1n), beta: i128ScVal(2n), gamma: i128ScVal(3n) });
    const b = structScVal({ gamma: i128ScVal(3n), beta: i128ScVal(2n), alpha: i128ScVal(1n) });
    expect(a.toXDR('base64')).toBe(b.toXDR('base64'));
  });

  it('round-trips through scValToNative for inspection', () => {
    const encoded = structScVal({ signer_index: u32ScVal(2), signature: bytesScVal(new Uint8Array(64).fill(9)) });
    const native = scValToNative(encoded) as { signer_index: number; signature: Buffer };
    expect(native.signer_index).toBe(2);
    expect(native.signature).toHaveLength(64);
  });

  it('rejects an empty struct', () => {
    expect(() => structScVal({})).toThrow(/at least one field/);
  });
});

describe('vectors and addresses', () => {
  it('encodes a Vec of structs as a Soroban vector', () => {
    const attestation = vecScVal([
      structScVal({ signer_index: u32ScVal(0), signature: bytesScVal(new Uint8Array(64)) }),
      structScVal({ signer_index: u32ScVal(2), signature: bytesScVal(new Uint8Array(64).fill(1)) }),
    ]);
    expect(scValDiscriminant(attestation)).toBe('vec');
    const items = xdrValue(attestation) as xdr.ScVal[];
    expect(items).toHaveLength(2);
    expect(scValDiscriminant(items[0])).toBe('map');
  });

  it('encodes an account address that decodes back to the same strkey', () => {
    expect(scValToNative(addressScVal(SELLER))).toBe(SELLER);
  });

  it('encodes booleans', () => {
    expect(scValToNative(boolScVal(true))).toBe(true);
    expect(scValToNative(boolScVal(false))).toBe(false);
  });
});

describe('decoders', () => {
  it('parses every phase name the contract can emit', () => {
    for (const phase of PHASES) {
      expect(parsePhase([phase])).toBe(phase);
      expect(parsePhase(phase)).toBe(phase);
    }
  });

  it('rejects an unknown phase rather than defaulting to one', () => {
    expect(() => parsePhase(['Nonsense'])).toThrow(/unknown auction phase/);
    expect(() => parsePhase(null)).toThrow(/cannot read an enum name/);
  });

  it('normalises the enum shapes different SDK versions produce', () => {
    expect(asEnumName(['Sealed'], 'phase')).toBe('Sealed');
    expect(asEnumName('Sealed', 'phase')).toBe('Sealed');
    expect(asEnumName({ tag: 'Sealed' }, 'phase')).toBe('Sealed');
    expect(asEnumName({ name: 'Reveal' }, 'phase')).toBe('Reveal');
  });

  it('reads integers from numbers, bigints and decimal strings', () => {
    expect(asBigInt(5n, 'x')).toBe(5n);
    expect(asBigInt(5, 'x')).toBe(5n);
    expect(asBigInt('5', 'x')).toBe(5n);
    expect(asNumber(5n, 'x')).toBe(5);
    expect(() => asBigInt('abc', 'x')).toThrow(/expected an integer/);
  });

  it('treats absent Options as undefined and present ones as their value', () => {
    expect(asOption<number>(null)).toBeUndefined();
    expect(asOption<number>(undefined)).toBeUndefined();
    expect(asOption<number>(7)).toBe(7);
  });

  it('enforces 32-byte fixed-width fields', () => {
    expect(asBytes32(Buffer.alloc(32), 'hash')).toHaveLength(32);
    expect(() => asBytes32(Buffer.alloc(31), 'hash')).toThrow(/expected 32 bytes/);
    expect(() => asBytes32('not bytes', 'hash')).toThrow(/expected bytes/);
  });

  it('detects an ScVal error as such', () => {
    const error = xdr.ScVal.scvError(
      xdr.ScError.sceContract(13),
    );
    expect(isXdrType(error, 'error')).toBe(true);
  });
});
