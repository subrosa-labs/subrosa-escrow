/**
 * Composition root.
 *
 * Everything is constructed once here and handed to the API and the worker, so there
 * is exactly one RPC server, one drand client, one store and one orchestrator per
 * process. `createApp` performs the fail-fast checks that are worth doing at boot:
 * a reachable RPC, a deployed contract whose schema version we understand, and a
 * relayer key set that can actually satisfy the on-chain quorum.
 */

import { rpc } from '@stellar/stellar-sdk';
import { loadConfig, type Config } from './config.ts';
import { initLogger, type Logger } from './logger.ts';
import { createStore } from './store/index.ts';
import type { Store } from './store/types.ts';
import { createServer, resolveNetwork, type StellarNetwork } from './stellar/network.ts';
import { SubRosaContract } from './stellar/contract.ts';
import { Relayer } from './stellar/relayer.ts';
import { EnvelopeBulletin } from './services/bulletin.ts';
import { RelayerOrchestrator } from './services/orchestrator.ts';
import { chainByHash, type DrandChain } from './drand/chain.ts';
import { parseRelayerSecret } from './drand/attestation.ts';

/** Schema layout this build understands. Must match `SCHEMA_VERSION` in Rust. */
export const EXPECTED_SCHEMA_VERSION = 1;

export interface App {
  readonly config: Config;
  readonly log: Logger;
  readonly store: Store;
  readonly network: StellarNetwork;
  readonly server: rpc.Server;
  readonly chain: DrandChain;
  readonly contract: SubRosaContract;
  readonly relayer: Relayer;
  readonly bulletin: EnvelopeBulletin;
  readonly orchestrator: RelayerOrchestrator;
  /** Fail-fast boot checks. Returns problems instead of throwing, for `/healthz`. */
  readonly preflight: readonly string[];
  readonly close: () => Promise<void>;
}

export interface CreateAppOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly skipPreflight?: boolean;
}

export async function createApp(options: CreateAppOptions = {}): Promise<App> {
  const config = loadConfig(options.env ?? process.env);
  const log = initLogger(config.LOG_LEVEL);

  const store = createStore(config);
  await store.migrate();

  const network = resolveNetwork(config);
  const server = createServer(network);
  const chain = chainByHash(config.DRAND_CHAIN_HASH);

  const contractId = config.SUBROSA_CONTRACT_ID;
  if (!contractId) {
    throw new Error(
      'SUBROSA_CONTRACT_ID is required. Deploy first: make -C contracts deploy-testnet',
    );
  }

  const contract = new SubRosaContract(server, network, contractId);

  // The fee source only exists to sponsor user transactions; without it the
  // relayer can still do its own work.
  const feeSource = config.relayerSecretKeys[0] ? parseRelayerSecret(config.relayerSecretKeys[0]) : undefined;

  const relayer = new Relayer({
    server,
    network,
    contractId,
    retries: config.TX_RETRIES,
    retryBaseMs: config.TX_RETRY_BASE_MS,
    ...(feeSource ? { feeSource } : {}),
    logger: log.child({ component: 'relayer' }),
  });

  const bulletin = new EnvelopeBulletin(store, config);
  const orchestrator = new RelayerOrchestrator({
    config,
    store,
    contract,
    relayer,
    bulletin,
    server,
  });

  const preflight = options.skipPreflight
    ? []
    : await runPreflight({ config, log, server, contract, orchestrator, store });

  return {
    config,
    log,
    store,
    network,
    server,
    chain,
    contract,
    relayer,
    bulletin,
    orchestrator,
    preflight,
    close: async () => {
      await store.close();
      log.info('shut down');
    },
  };
}

interface PreflightInput {
  config: Config;
  log: Logger;
  server: rpc.Server;
  contract: SubRosaContract;
  orchestrator: RelayerOrchestrator;
  store: Store;
}

/**
 * Boot checks that catch the failure modes which otherwise only show up hours later
 * as a stuck auction.
 */
async function runPreflight(input: PreflightInput): Promise<string[]> {
  const problems: string[] = [];
  const { log, config } = input;

  try {
    const ledger = await input.server.getLatestLedger();
    log.info({ ledger: ledger.sequence, network: config.STELLAR_NETWORK }, 'rpc reachable');
  } catch (error) {
    problems.push(`cannot reach Soroban RPC at ${config.rpcUrl}: ${describe(error)}`);
    return problems;
  }

  try {
    const version = await input.contract.schemaVersion();
    if (version !== EXPECTED_SCHEMA_VERSION) {
      problems.push(
        `contract reports schema version ${version} but this build expects ${EXPECTED_SCHEMA_VERSION}; ` +
          'upgrade the backend or redeploy the contract before proceeding',
      );
    }
  } catch (error) {
    problems.push(`contract ${config.SUBROSA_CONTRACT_ID} did not answer schema_version: ${describe(error)}`);
    return problems;
  }

  const storeHealth = await input.store.health();
  if (!storeHealth.ok) {
    problems.push(`store is unhealthy: ${storeHealth.detail ?? 'unknown error'}`);
  }

  if (config.WORKER_ENABLED) {
    try {
      const check = await input.orchestrator.selfCheck();
      problems.push(...check.problems);
      log.info(
        { holds: check.holds, threshold: check.threshold, committee: check.committee, chain: check.chain },
        'relayer quorum check',
      );
    } catch (error) {
      problems.push(`relayer self-check failed: ${describe(error)}`);
    }
  }

  for (const problem of problems) log.error({ problem }, 'preflight problem');
  return problems;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
