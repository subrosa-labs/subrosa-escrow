#!/usr/bin/env node
/** Apply the store schema. Safe to run repeatedly; the schema is idempotent. */

import { loadConfig } from '../src/config.ts';
import { initLogger } from '../src/logger.ts';
import { createStore } from '../src/store/index.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = initLogger(config.LOG_LEVEL);
  const store = createStore(config);

  if (!config.usePostgres) {
    log.warn('DATABASE_URL is not set; the in-memory store needs no migration');
    return;
  }

  log.info({ driver: 'postgres' }, 'applying schema');
  await store.migrate();

  const health = await store.health();
  log.info(health, 'migration complete');
  await store.close();
}

main().catch((error: unknown) => {
  console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
