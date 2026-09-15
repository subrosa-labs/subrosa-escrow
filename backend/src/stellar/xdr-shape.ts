/**
 * Tolerant XDR introspection.
 *
 * `@stellar/stellar-sdk` changed how XDR unions expose their discriminant between
 * major versions: older builds used `switch()` / `value()` methods, newer ones
 * expose `switch` / `value` properties (and, in the build we pin, a `type` string).
 * Every access we make to a discriminant, a value payload or a diagnostic event body
 * goes through here so that a future SDK bump breaks one file with a clear test,
 * instead of scattering `?? undefined` across the codebase.
 */

/**
 * The discriminant name of any union-ish XDR value, normalised.
 *
 * SDK builds have used `scvU64`, `ScValType.scvU64`, `"u64"` and a `switch()` accessor
 * over the years. Callers want to ask `is this a map`, so everything funnels through
 * here and comes out as `u64`, `map`, `vec`, `error`, …
 */
export function scValDiscriminant(value: unknown): string | undefined {
  const record = value as { type?: unknown; switch?: unknown } | null;
  if (!record) return undefined;

  const direct = record.type;
  if (typeof direct === 'string') return normaliseDiscriminant(direct);

  const switched = resolveMaybeCallable(record.switch);
  if (typeof switched === 'string') return normaliseDiscriminant(switched);
  if (switched !== null && typeof switched === 'object') {
    const name = (switched as { name?: unknown }).name;
    if (typeof name === 'string') return normaliseDiscriminant(name);
  }
  return undefined;
}

/** `scvU64` / `ScValType.scvU64` -> `u64`; `map` stays `map`. */
function normaliseDiscriminant(name: string): string {
  const withoutPrefix = name.replace(/^scv/, '');
  return withoutPrefix.charAt(0).toLowerCase() + withoutPrefix.slice(1);
}

/** The payload of a union-ish XDR value, whatever this SDK version calls it. */
export function xdrValue(value: unknown): unknown {
  const record = value as { value?: unknown; type?: unknown } | null;
  if (!record) return undefined;

  const resolved = resolveMaybeCallable(record.value);
  if (resolved !== undefined) return resolved;

  // Some builds keep the payload as a property named after the discriminant.
  const discriminant = scValDiscriminant(value);
  if (discriminant !== undefined) return record[discriminant as keyof typeof record];
  return undefined;
}

/** Whether `value` is a union whose discriminant is `name`. */
export function isXdrType(value: unknown, name: string): boolean {
  return scValDiscriminant(value) === name;
}

/** A JSON view of an XDR value, for logs and regex-based error extraction. */
export function describeScVal(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, candidate) =>
      typeof candidate === 'bigint' ? candidate.toString() : candidate,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

function resolveMaybeCallable(candidate: unknown): unknown {
  if (typeof candidate === 'function') {
    try {
      return (candidate as () => unknown)();
    } catch {
      return undefined;
    }
  }
  return candidate;
}
