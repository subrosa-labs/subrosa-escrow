/**
 * Environment-driven configuration.
 *
 * Everything is validated and normalised once, at startup, into a frozen object.
 * A misconfigured relayer should fail loudly on boot rather than halfway through
 * signing a settlement transaction.
 */

import { z } from 'zod';
import { QUICKNET } from './drand/chain.ts';

const NetworkName = z.enum(['testnet', 'futurenet', 'mainnet', 'standalone']);

/**
 * A boolean read from an environment variable.
 *
 * `z.coerce.boolean()` is a trap here: it applies `Boolean(value)`, so the string
 * `"false"` becomes `true`. Setting `WORKER_ENABLED=false` would have silently left
 * the worker running — which in a relayer means signing transactions the operator
 * thought they had switched off.
 */
const booleanish = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(normalised)) return false;
  }
  return value;
}, z.boolean());

/** Canonical RPC + Horizon endpoints per network. */
export const NETWORK_ENDPOINTS: Record<z.infer<typeof NetworkName>, { rpc: string; horizon: string }> = {
  testnet: {
    rpc: 'https://soroban-testnet.stellar.org',
    horizon: 'https://horizon-testnet.stellar.org',
  },
  futurenet: {
    rpc: 'https://rpc-futurenet.stellar.org',
    horizon: 'https://horizon-futurenet.stellar.org',
  },
  mainnet: {
    rpc: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    horizon: 'https://horizon.stellar.org',
  },
  standalone: {
    rpc: 'http://localhost:8000/soroban/rpc',
    horizon: 'http://localhost:8000',
  },
};

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('0.0.0.0'),
    /** Comma-separated allowed browser origins, or `*` for any. */
    CORS_ORIGINS: z.string().default('*'),

    STELLAR_NETWORK: NetworkName.default('testnet'),
    STELLAR_RPC_URL: z.string().url().optional(),
    STELLAR_HORIZON_URL: z.string().url().optional(),

    /** Deployed `subrosa_escrow` contract (strkey `C...`). */
    SUBROSA_CONTRACT_ID: z.string().startsWith('C').length(56).optional(),
    /** SAC address of the escrow asset, used only for display metadata. */
    SUBROSA_SETTLEMENT_TOKEN: z.string().startsWith('C').length(56).optional(),

    /**
     * ed25519 relayer secrets (strkey `S...`). One key per operator process.
     *
     * In production these are held by independent operators who each run their own
     * copy of this service; the backend also accepts several so that a single
     * operator can satisfy a quorum on testnet. Holding `>= threshold` keys in one
     * place collapses the quorum to a single trusted party, so never do it on
     * mainnet.
     */
    RELAYER_SECRET_KEYS: z.string().default(''),
    /** Optional explicit public keys, for verification against the on-chain set. */
    RELAYER_PUBLIC_KEYS: z.string().default(''),

    DRAND_CHAIN_HASH: z
      .string()
      .length(64)
      .default(QUICKNET.chainHash),
    DRAND_CHAIN_URL: z.string().url().default(QUICKNET.baseUrl),

    /** Postgres connection string. When absent the service uses an in-memory store. */
    DATABASE_URL: z.string().optional(),

    INDEXER_ENABLED: booleanish.default(true),
    WORKER_ENABLED: booleanish.default(true),

    /** How often the worker wakes up, milliseconds. */
    WORKER_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
    /** How long a claimed job is invisible to other workers, milliseconds. */
    JOB_LEASE_MS: z.coerce.number().int().min(10_000).default(120_000),
    /** Max attempts before a job is parked as `failed`. */
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),

    /** Cap on envelopes accepted per auction, mirroring the contract's `max_bids`. */
    MAX_ENVELOPES_PER_AUCTION: z.coerce.number().int().min(1).default(64),
    /** Cap on an accepted envelope's size, bytes. */
    MAX_ENVELOPE_BYTES: z.coerce.number().int().min(256).default(8_192),

    /** Soroban submission retries on transient RPC failures. */
    TX_RETRIES: z.coerce.number().int().min(0).default(4),
    TX_RETRY_BASE_MS: z.coerce.number().int().min(100).default(1_500),

    /**
     * Bearer token for `POST /v1/admin/*`.
     *
     * When unset the admin routes are not registered at all, which is the right
     * default for a public deployment: an unauthenticated endpoint that can trigger
     * a settlement sweep is a denial-of-service lever.
     */
    ADMIN_TOKEN: z.string().min(16).optional(),
  })
  .transform((raw) => {
    const endpoints = NETWORK_ENDPOINTS[raw.STELLAR_NETWORK];
    const splitList = (value: string): string[] =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    return {
      ...raw,
      isProduction: raw.NODE_ENV === 'production',
      rpcUrl: raw.STELLAR_RPC_URL ?? endpoints.rpc,
      horizonUrl: raw.STELLAR_HORIZON_URL ?? endpoints.horizon,
      relayerSecretKeys: splitList(raw.RELAYER_SECRET_KEYS),
      relayerPublicKeys: splitList(raw.RELAYER_PUBLIC_KEYS),
      corsOrigins:
        raw.CORS_ORIGINS === '*'
          ? ('*' as const)
          : splitList(raw.CORS_ORIGINS),
      usePostgres: typeof raw.DATABASE_URL === 'string' && raw.DATABASE_URL.length > 0,
    };
  })
  .superRefine((cfg, ctx) => {
    if (cfg.WORKER_ENABLED && cfg.relayerSecretKeys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RELAYER_SECRET_KEYS'],
        message:
          'the worker cannot run without at least one relayer key; set RELAYER_SECRET_KEYS or WORKER_ENABLED=false',
      });
    }
    if (cfg.INDEXER_ENABLED && cfg.SUBROSA_CONTRACT_ID === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUBROSA_CONTRACT_ID'],
        message:
          'the indexer needs a deployed contract; set SUBROSA_CONTRACT_ID or INDEXER_ENABLED=false',
      });
    }
    if (
      cfg.isProduction &&
      cfg.relayerSecretKeys.length > 0 &&
      cfg.WORKER_ENABLED &&
      cfg.relayerSecretKeys.length > 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RELAYER_SECRET_KEYS'],
        message:
          'holding more than one relayer key in production reduces the beacon quorum to a single party; run one key per operator',
      });
    }
  });

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

/** Parse and cache the configuration. Throws a readable error on failure. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached && env === process.env) return cached;

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`invalid configuration:\n${lines.join('\n')}`);
  }

  if (env === process.env) cached = parsed.data;
  return parsed.data;
}

/** Test helper: forget the memoised configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}
