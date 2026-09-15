'use client';

/**
 * A live countdown, driven entirely by an absolute target timestamp from the server.
 *
 * Absolute rather than relative on purpose: a server-relative duration would drift with
 * request latency and, worse, would render differently on each client. The clock is read
 * on mount only, so server-rendered HTML and the first client paint agree.
 */

import { useEffect, useRef, useState } from 'react';
import { formatDuration, formatTimestamp } from '../lib/format.ts';

export interface CountdownProps {
  /** Unix milliseconds. */
  readonly targetMs: number;
  /** What it counts down to, for the label. */
  readonly label?: string;
  readonly className?: string;
  /** Called once when the countdown reaches zero, so a page can refetch. */
  readonly onElapsed?: () => void;
}

export function Countdown({ targetMs, label, className, onElapsed }: CountdownProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const remaining = targetMs - (now ?? targetMs);
  const elapsed = now !== null && remaining <= 0;

  // Fire `onElapsed` on the transition only. Keyed on `elapsed` rather than on the
  // ticking clock so a refetch does not happen once per second.
  const notified = useRef(false);
  useEffect(() => {
    if (elapsed && !notified.current) {
      notified.current = true;
      onElapsed?.();
    }
  }, [elapsed, onElapsed]);

  if (now === null) {
    // First paint: show the wall-clock time, which needs no local clock.
    return (
      <span className={className} title={formatTimestamp(targetMs)}>
        {formatTimestamp(targetMs)}
      </span>
    );
  }

  if (elapsed) {
    return (
      <span className={className}>
        {label ? `${label} ` : ''}now
      </span>
    );
  }

  return (
    <span className={className} title={formatTimestamp(targetMs)}>
      {label ? `${label} ` : ''}
      {formatDuration(remaining)}
    </span>
  );
}
