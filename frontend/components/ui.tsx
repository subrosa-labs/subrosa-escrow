/**
 * Small presentational primitives.
 *
 * All server-safe (no hooks, no browser globals), so both server and client components
 * can import them without pulling anything across the boundary.
 */

import type { ReactNode } from 'react';

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: 'border-ink-600 bg-ink-850 text-ash-200',
    warn: 'border-amber2/40 bg-amber2/10 text-amber2',
    error: 'border-wax-500/40 bg-wax-500/10 text-wax-300',
    ok: 'border-reveal-500/40 bg-reveal-500/10 text-reveal-300',
  } as const;

  return (
    <div className={`rounded-lg border p-4 text-sm ${tones[tone]}`} role={tone === 'error' ? 'alert' : undefined}>
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? 'mt-1 opacity-90' : 'opacity-90'}>{children}</div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={mono ? 'value mt-0.5' : 'mt-0.5 text-sm text-ash-100'}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-ash-400">{hint}</div> : null}
    </div>
  );
}

/** Truncated hash with the full value in the tooltip and the copy affordance. */
export function Hash({ value, label, chars = 10 }: { value: string; label?: string; chars?: number }) {
  const short = value.length > chars * 2 + 1 ? `${value.slice(0, chars)}…${value.slice(-chars)}` : value;
  return (
    <span className="font-mono text-xs text-ash-200" title={value}>
      {label ? <span className="text-ash-400">{label} </span> : null}
      {short}
    </span>
  );
}

/**
 * Link to a block explorer.
 *
 * Built from the relayer's own `explorerUrl` where it provides one, so the network the
 * relayer is on decides the explorer rather than this bundle's build-time network.
 */
export function ExplorerLink({
  url,
  children,
  className,
}: {
  url: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={`text-wax-300 hover:text-wax-200 ${className ?? ''}`}
    >
      {children}
    </a>
  );
}
