/** Store factory. Picks Postgres when `DATABASE_URL` is set, memory otherwise. */

import type { Config } from '../config.ts';
import { MemoryStore } from './memory.ts';
import { PostgresStore } from './postgres.ts';
import type { Store } from './types.ts';

export function createStore(config: Config): Store {
  if (config.usePostgres && config.DATABASE_URL) {
    return new PostgresStore({
      connectionString: config.DATABASE_URL,
      applicationName: 'subrosa-relayer',
    });
  }
  return new MemoryStore();
}

export function isMemoryStore(store: Store): store is MemoryStore {
  return store instanceof MemoryStore;
}

export type { Store } from './types.ts';
export { MemoryStore } from './memory.ts';
export { PostgresStore } from './postgres.ts';
export * from './types.ts';
