import { eq, isNull, and, not } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '@shared/db/schema/data-schema'
import { tasks } from '@shared/db/schema/tasks'
import { inboxItems } from '@shared/db/schema/inbox'
import { savedFilters } from '@shared/db/schema/settings'
import { syncState } from '@shared/db/schema/sync-state'
import { increment } from './vector-clock'
import type { SyncQueueManager } from './queue'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('InitialSeed')

const SEED_DONE_KEY = 'initialSeedDone'

export interface InitialSeedDeps {
  db: DrizzleDb
  queue: SyncQueueManager
  deviceId: string
}

export function runInitialSeed(deps: InitialSeedDeps): void {
  const { db, queue, deviceId } = deps

  const existing = db.select().from(syncState).where(eq(syncState.key, SEED_DONE_KEY)).get()
  if (existing) return

  let seeded = 0

  const unclockedTasks = db.select().from(tasks).where(isNull(tasks.clock)).all()
  for (const t of unclockedTasks) {
    const clock = increment({}, deviceId)
    db.update(tasks).set({ clock }).where(eq(tasks.id, t.id)).run()
    queue.enqueue({
      type: 'task',
      itemId: t.id,
      operation: 'create',
      payload: JSON.stringify({ ...t, clock }),
      priority: 0
    })
    seeded++
  }

  const unclockedInbox = db
    .select()
    .from(inboxItems)
    .where(and(isNull(inboxItems.clock), not(eq(inboxItems.localOnly, true))))
    .all()
  for (const i of unclockedInbox) {
    const clock = increment({}, deviceId)
    db.update(inboxItems).set({ clock }).where(eq(inboxItems.id, i.id)).run()
    queue.enqueue({
      type: 'inbox',
      itemId: i.id,
      operation: 'create',
      payload: JSON.stringify({ ...i, clock }),
      priority: 0
    })
    seeded++
  }

  const unclockedFilters = db
    .select()
    .from(savedFilters)
    .where(isNull(savedFilters.clock))
    .all()
  for (const f of unclockedFilters) {
    const clock = increment({}, deviceId)
    db.update(savedFilters).set({ clock }).where(eq(savedFilters.id, f.id)).run()
    queue.enqueue({
      type: 'filter',
      itemId: f.id,
      operation: 'create',
      payload: JSON.stringify({ ...f, clock }),
      priority: 0
    })
    seeded++
  }

  db.insert(syncState)
    .values({ key: SEED_DONE_KEY, value: 'true', updatedAt: new Date() })
    .run()

  if (seeded > 0) {
    log.info('Initial seed complete', { seeded })
  }
}
