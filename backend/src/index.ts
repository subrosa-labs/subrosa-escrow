/**
 * Entry point: HTTP API and, unless disabled, the relayer worker in the same process.
 *
 * Running them together is the right default for a single-operator deployment — the
 * worker is mostly idle, and splitting it out only buys anything once you want to
 * scale the API horizontally. Set `WORKER_ENABLED=false` and run `npm run worker` in a
 * separate process when that day comes; the job leases make it safe either way.
 */

import { createApp } from './app.ts';
import { buildServer } from './api/server.ts';
import { startWorker } from './worker.ts';

async function main(): Promise<void> {
  const app = await createApp();
  const server = buildServer(app);

  const worker = app.config.WORKER_ENABLED ? startWorker(app) : undefined;

  if (app.preflight.length > 0) {
    app.log.error(
      { problems: app.preflight },
      'preflight found problems; the API will report unhealthy until they are fixed',
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await worker?.stop();
    await server.close();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.listen({ port: app.config.PORT, host: app.config.HOST });
  app.log.info(
    {
      port: app.config.PORT,
      network: app.network.name,
      contract: app.config.SUBROSA_CONTRACT_ID,
      worker: Boolean(worker),
      chain: app.chain.beaconId,
    },
    'subrosa relayer listening',
  );
}

main().catch((error: unknown) => {
  // Boot failures go to stderr rather than the pino stream: the logger may not exist
  // yet, and a human is reading this.
  process.stderr.write(
    `failed to start subrosa relayer: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
