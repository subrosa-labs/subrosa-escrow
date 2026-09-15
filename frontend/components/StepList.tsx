'use client';

/**
 * The step list for a multi-signature flow.
 *
 * Showing named steps rather than a spinner is the difference between "it is thinking"
 * and "it is waiting for me to sign" — and a wallet prompt that opens behind another
 * window is otherwise indistinguishable from a hang.
 */

import type { FlowStep } from '../lib/flow.ts';

const MARK: Record<FlowStep['status'], string> = {
  pending: '○',
  active: '◐',
  done: '●',
  error: '✕',
};

const TONE: Record<FlowStep['status'], string> = {
  pending: 'text-ash-400',
  active: 'text-wax-300 animate-pulse',
  done: 'text-reveal-300',
  error: 'text-wax-300',
};

export function StepList({ steps }: { steps: readonly FlowStep[] }) {
  if (steps.length === 0) return null;

  return (
    <ol className="space-y-1.5" aria-live="polite">
      {steps.map((step) => (
        <li key={step.id} className="flex items-baseline gap-2 text-sm">
          <span className={`font-mono text-xs ${TONE[step.status]}`} aria-hidden>
            {MARK[step.status]}
          </span>
          <span className={step.status === 'pending' ? 'text-ash-400' : 'text-ash-100'}>
            {step.label}
          </span>
          {step.detail ? (
            <span className="font-mono text-xs text-ash-400">— {step.detail}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
