import { eq, isNull } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { HomePageSyncPayloadSchema, type HomePageSyncPayload } from '@memry/contracts/sync-payloads'
import { HomePagesChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('HomePageHandler')

/**
 * `widgets` crosses the wire as an opaque JSON string (see
 * HomePageSyncPayloadSchema), so the only shape contract is "parses to an
 * array". Everything inside is stored verbatim: legacy `{size}` blobs and
 * widget keys invented by a newer build both survive the round trip.
 */
function isWidgetsBlob(raw: string): boolean {
  try {
    return Array.isArray(JSON.parse(raw))
  } catch {
    return false
  }
}

class HomePageHandler extends BaseItemHandler<HomePageSyncPayload> {
  readonly type = 'home_page' as const
  readonly schema = HomePageSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: HomePageSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      // Refuse before touching the clock: returning 'skipped' leaves the local
      // clock un-advanced, so a later readable version of the same board still
      // wins. `data.widgets === undefined` is the *other* case — the sender does
      // not know the field — and falls through to "keep local".
      if (data.widgets !== undefined && !isWidgetsBlob(data.widgets)) {
        log.warn('Skipping remote home board, widgets payload is not a JSON array', { itemId })
        return 'skipped'
      }

      const existing = tx.select().from(homePages).where(eq(homePages.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote home board update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent home board edit, using last-write-wins', { itemId })
        }

        tx.update(homePages)
          .set({
            name: data.name ?? existing.name,
            icon: data.icon !== undefined ? data.icon : existing.icon,
            position: data.position ?? existing.position,
            widgets: data.widgets ?? existing.widgets,
            clock: resolution.mergedClock,
            syncedAt: now,
            updatedAt: data.updatedAt ?? now
          })
          .where(eq(homePages.id, itemId))
          .run()

        ctx.emit(HomePagesChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      // Every payload field is optional, so `{}` parses. Without this guard a
      // frozen-payload push (pull-coordinator enqueues '{}' on conflict) would
      // materialise a permanent ghost board whose empty clock makes every later
      // legitimate version compare as stale. Copied from template-handler.
      if (!data.name) {
        log.warn('Skipping remote home board insert, payload has no name', { itemId })
        return 'skipped'
      }

      tx.insert(homePages)
        .values({
          id: itemId,
          name: data.name,
          icon: data.icon ?? null,
          position: data.position ?? 0,
          widgets: data.widgets ?? '[]',
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now
        })
        .run()

      ctx.emit(HomePagesChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  }

  /**
   * Hard delete, matching `filter`/`template`/`bookmark`. Record-sync tombstones
   * live on the server item (`deleted_at`), never in a local column — a
   * soft-delete column would also break downgrade inertness, since an older
   * build has no `deletedAt` in its model and would list tombstoned boards.
   *
   * Refusing when the local clock is newer or concurrent means manifest repair
   * can re-push the row and clear the server tombstone. That is the intended
   * "a concurrent local edit beats a remote delete", not the canvas resurrection
   * bug — that hazard is about tombstoned rows in a soft-delete table.
   */
  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(homePages).where(eq(homePages.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote home board delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(homePages).where(eq(homePages.id, itemId)).run()
    ctx.emit(HomePagesChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(homePages).where(eq(homePages.id, itemId)).get() as
      Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const board = db.select().from(homePages).where(eq(homePages.id, itemId)).get()
    if (!board) return null
    return JSON.stringify(board)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(homePages).set({ syncedAt: utcNow() }).where(eq(homePages.id, itemId)).run()
  }

  /** Carries boards that already exist on a live-beta device onto the account. */
  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(homePages).where(isNull(homePages.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(homePages).set({ clock }).where(eq(homePages.id, item.id)).run()
      queue.enqueue({
        type: 'home_page',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const homePageHandler = new HomePageHandler()
