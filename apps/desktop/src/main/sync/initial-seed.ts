import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@memry/db-schema/data-schema'
import type { RemoteSyncAdapter } from '@memry/sync-core'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { getAllRemoteSyncAdapters } from './item-handlers'
import type { SyncQueueManager } from './queue'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('InitialSeed')

const SEED_DONE_KEY = 'initialSeedDone'

export interface InitialSeedDeps {
  db: DrizzleDb
  queue: SyncQueueManager
  deviceId: string
  adapters?: Array<RemoteSyncAdapter<DrizzleDb, unknown>>
}

export function runInitialSeed(deps: InitialSeedDeps): void {
  const { db, queue, deviceId } = deps
  const adapters = deps.adapters ?? getAllRemoteSyncAdapters()

  const existing = db.select().from(syncState).where(eq(syncState.key, SEED_DONE_KEY)).get()

  let seeded = 0
  for (const adapter of adapters) {
    seeded += adapter.seedUnclocked?.(db, deviceId, queue) ?? 0
  }

  if (existing && seeded === 0) return

  if (existing && seeded > 0) {
    log.warn('initialSeedDone flag exists but unclocked items found; re-seeded', { seeded })
  }

  db.insert(syncState)
    .values({ key: SEED_DONE_KEY, value: 'true', updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { value: 'true', updatedAt: new Date() }
    })
    .run()

  if (seeded > 0) {
    log.info('Initial seed complete', { seeded })
  }
}
