/** Structured logging. Everything goes through here so that `trace_id` and
 * `component` are always attached in the same place. */

import { pino, type Logger } from 'pino';

export type { Logger };

let root: Logger | undefined;

export function initLogger(level: string): Logger {
  root = pino({
    level,
    base: { service: 'subrosa-relayer' },
    // Always JSON on stdout, so it can be shipped anywhere. For readable local
    // output, pipe through pino-pretty: `npm run dev | npx pino-pretty`.
    redact: {
      // Defence in depth: a bid plaintext or a relayer secret must never reach the
      // log stream, and the easiest guarantee is to redact the field names that
      // could carry one.
      paths: [
        'secret',
        'secretKey',
        '*.secret',
        '*.secretKey',
        'relayerSecretKeys',
        'amount',
        '*.amount',
        'plaintext',
        '*.plaintext',
        'envelope',
        '*.envelope',
      ],
      censor: '[redacted]',
    },
  });
  return root;
}

export function logger(): Logger {
  if (!root) root = initLogger('info');
  return root;
}

export function childLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return logger().child({ component, ...bindings });
}
