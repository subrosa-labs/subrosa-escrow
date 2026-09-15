/**
 * Standalone worker entry point (`npm run worker`).
 *
 * Same orchestrator as the combined process, minus the HTTP server. Use this when the
 * API and the relayer should scale independently.
 */

import { createApp } from './app.ts';
import { startWorker } from './worker.ts';

async function main(): Promise<void> {
  const app = await createApp();

  if (app.preflight.length > 0) {
    app.log.error(
      { problems: app.preflight },
      'preflight found problems; refusing to start the worker so a broken key set cannot burn fees',
    );
    process.exit(1);
  }

  const worker = startWorker(app);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down worker');
    await worker.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  app.log.info(
    { network: app.network.name, contract: app.config.SUBROSA_CONTRACT_ID, chain: app.chain.beaconId },
    'subrosa worker started',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `failed to start subrosa worker: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
