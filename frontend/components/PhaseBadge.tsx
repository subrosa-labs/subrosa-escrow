import type { Phase } from '../lib/types.ts';
import { phaseCopy } from '../lib/types.ts';

/**
 * Phase pill.
 *
 * Colour carries the whole meaning here — sealed is red (a closed envelope), reveal is
 * green (an opened one), and terminal states are muted so they stop drawing the eye.
 */
const STYLES: Record<Phase, string> = {
  Sealed: 'border-wax-500/40 bg-wax-500/10 text-wax-300',
  Reveal: 'border-reveal-500/40 bg-reveal-500/10 text-reveal-300',
  Funding: 'border-amber2/40 bg-amber2/10 text-amber2',
  Settled: 'border-ink-600 bg-ink-800 text-ash-200',
  Cancelled: 'border-ink-600 bg-ink-800 text-ash-400',
  Failed: 'border-ink-600 bg-ink-800 text-ash-400',
};

export function PhaseBadge({ phase, withBlurb = false }: { phase: Phase; withBlurb?: boolean }) {
  const copy = phaseCopy(phase);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <span className={`chip ${STYLES[phase]}`}>
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            phase === 'Sealed'
              ? 'bg-wax-400'
              : phase === 'Reveal'
                ? 'bg-reveal-400'
                : phase === 'Funding'
                  ? 'bg-amber2'
                  : 'bg-ash-400'
          }`}
          aria-hidden
        />
        {copy.label}
      </span>
      {withBlurb ? <span className="text-xs text-ash-400">{copy.blurb}</span> : null}
    </span>
  );
}
