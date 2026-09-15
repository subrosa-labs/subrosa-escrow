/**
 * Amount parsing and formatting.
 *
 * Money in this system crosses three representations (a decimal string from the API, a
 * bigint in the browser, a `FormData` string from an input), and the parse direction is
 * the dangerous one: a bid of `1.00000005` truncated to seven decimals would commit to a
 * different number than the bidder typed, and the reveal would still succeed — the user
 * would simply have bid something else.
 */

import { describe, expect, it } from 'vitest';
import { formatAmount, formatBps, formatDuration, parseAmountToBaseUnits, shortenAddress } from '../format.ts';

describe('parseAmountToBaseUnits', () => {
  it('scales to the token\u2019s smallest unit', () => {
    expect(parseAmountToBaseUnits('1', 7)).toBe(10_000_000n);
    expect(parseAmountToBaseUnits('0.0000001', 7)).toBe(1n);
    expect(parseAmountToBaseUnits('12.5', 7)).toBe(125_000_000n);
    expect(parseAmountToBaseUnits('1000', 6)).toBe(1_000_000_000n);
  });

  it('tolerates grouping separators and surrounding whitespace', () => {
    expect(parseAmountToBaseUnits(' 1,234.5 ', 7)).toBe(12_345_000_000n);
  });

  it('never silently rounds: more precision than the asset has is an error', () => {
    expect(() => parseAmountToBaseUnits('1.00000005', 7)).toThrow(/at most 7 decimal places/);
  });

  it('rejects anything that is not a positive decimal', () => {
    for (const bad of ['', '.', 'abc', '-1', '1e7', '1.2.3']) {
      expect(() => parseAmountToBaseUnits(bad, 7), bad).toThrow();
    }
  });
});

describe('formatAmount', () => {
  it('formats exactly, without floating point', () => {
    // Whole amounts lose their zero tail; a barely-there amount keeps every digit.
    expect(formatAmount('10000000', 7)).toBe('1');
    expect(formatAmount('1', 7)).toBe('0.0000001');
    expect(formatAmount('15000000', 7)).toBe('1.50');
  });

  it('keeps full precision beyond 2^53', () => {
    // 90,071,992,547,409,93 base units at 7 decimals. A number-typed formatter mangles
    // the last digits.
    expect(formatAmount('9007199254740993', 7)).toBe('900,719,925.4740993');
  });

  it('groups thousands and appends a symbol when asked', () => {
    expect(formatAmount('12345678900000', 7, { withSymbol: 'USDC' })).toBe('1,234,567.89 USDC');
  });

  it('handles negative values', () => {
    expect(formatAmount(-10000000n, 7)).toBe('-1');
    expect(formatAmount(-15000000n, 7)).toBe('-1.50');
  });
});

describe('small helpers', () => {
  it('shortens an address to something recognisable', () => {
    const address = 'GACDNJQ7CJ7LWVJ4I6LQCSNRVV2W4LBGPC6K7VJWQNSM7Q2WQ5VJ6YHWQ';
    expect(shortenAddress(address)).toBe('GACDNJ…YHWQ');
    expect(shortenAddress(address, 8, 6)).toBe('GACDNJQ7…J6YHWQ');
    // Short enough that truncating would lose more than it saves.
    expect(shortenAddress('GSHORT')).toBe('GSHORT');
  });

  it('formats durations and percentages', () => {
    expect(formatDuration(0)).toBe('now');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3 * 3_600_000 + 60_000)).toBe('3h 1m');
    expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe('2d 1h');
    expect(formatBps(250)).toBe('2.50%');
  });
});
