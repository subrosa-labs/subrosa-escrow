/** Display helpers. All amounts arrive as decimal strings in the token's smallest unit. */

const STROOP_DECIMALS = 7;

/**
 * Display symbol for the escrowed asset.
 *
 * The contract records the settlement token's address and decimals but not its symbol — a
 * Soroban contract cannot read a Stellar Asset Contract's metadata — so the human-facing
 * name has to be configured at build time rather than fetched.
 */
export const SETTLEMENT_SYMBOL = process.env.NEXT_PUBLIC_SETTLEMENT_SYMBOL ?? 'USDC';

/**
 * Format a smallest-unit amount for display.
 *
 * Trailing zeros are trimmed, because `1.0000000` reading as `1` is better than a wall of
 * them — but a single significant fraction digit is padded to two, so `1.5` reads as
 * `1.50` instead of `1.5`. Anything padding a fraction with zeros is value-preserving, so
 * this never changes what the number means; it only decides how much of the tail to show.
 */
export function formatAmount(
  value: string | bigint,
  decimals = STROOP_DECIMALS,
  options: { readonly withSymbol?: string; readonly maxFractionDigits?: number } = {},
): string {
  let raw: bigint;
  try {
    raw = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return `${value}`;
  }

  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;

  const maxFraction = options.maxFractionDigits ?? decimals;
  let fractionText = fraction.toString().padStart(decimals, '0');
  if (maxFraction < decimals) fractionText = fractionText.slice(0, maxFraction);
  fractionText = fractionText.replace(/0+$/, '');
  if (fractionText.length === 1) fractionText = `${fractionText}0`;

  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const core = fractionText.length > 0 ? `${grouped}.${fractionText}` : grouped;
  const signed = negative ? `-${core}` : core;
  return options.withSymbol ? `${signed} ${options.withSymbol}` : signed;
}

export function parseAmountToBaseUnits(input: string, decimals = STROOP_DECIMALS): bigint {
  const trimmed = input.trim().replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error('enter a positive number');
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    throw new Error(`this asset supports at most ${decimals} decimal places`);
  }
  const padded = fraction.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded);
}

/** `GACDNJ…HWQ` — enough to recognise, short enough for a table. */
export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function percentOf(top: string | bigint, bottom: string | bigint): string {
  const a = typeof top === 'bigint' ? top : BigInt(top);
  const b = typeof bottom === 'bigint' ? bottom : BigInt(bottom);
  if (b === 0n) return '0%';
  // Two decimal places of a ratio, without going through a float for the integer part.
  const scaled = (a * 10_000n) / b;
  return `${(Number(scaled) / 100).toFixed(2)}%`;
}

/** Fee in basis points, as a human percentage. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
