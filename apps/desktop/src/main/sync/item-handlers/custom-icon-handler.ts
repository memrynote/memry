import { eq, isNull } from 'drizzle-orm'
import { customIcons } from '@memry/db-schema/schema/custom-icons'
import {
  CustomIconSyncPayloadSchema,
  type CustomIconSyncPayload
} from '@memry/contracts/sync-payloads'
import { CustomIconsChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { VaultError, VaultErrorCode } from '../../lib/errors'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'
import { deleteCustomIconFile, writeCustomIconFile } from '../../vault/custom-icons'

const log = createLogger('CustomIconHandler')

/**
 * Mirror an applied icon's bytes into `.memry/icons` without letting the file
 * write take down the apply.
 *
 * Same shape as the folder-config mirror: the DB row is the sync record and is
 * written inside the surrounding transaction, while the file is a best-effort
 * vault mirror. It must be `.catch()`-ed because `vault/custom-icons` throws
 * `VAULT_NOT_INITIALIZED` when no vault is open, which happens routinely during
 * quit / vault switch / sign-out. A row whose file is missing is repaired by
 * `custom-icons:list`, which every icon consumer calls before rendering.
 */
function mirrorIconFile(id: string, ext: string, dataBase64: string): void {
  void writeCustomIconFile(id, ext, Buffer.from(dataBase64, 'base64')).catch((error: unknown) => {
    if (error instanceof VaultError && error.code === VaultErrorCode.NOT_INITIALIZED) {
      log.warn('Skipped custom icon file write, no vault is open', { id })
      return
    }
    log.error('Failed to write synced custom icon file', { id, error })
  })
}

function removeIconFile(id: string, ext: string): void {
  void deleteCustomIconFile(id, ext).catch((error: unknown) => {
    if (error instanceof VaultError && error.code === VaultErrorCode.NOT_INITIALIZED) return
    log.error('Failed to remove synced custom icon file', { id, error })
  })
}

class CustomIconHandler extends BaseItemHandler<CustomIconSyncPayload> {
  readonly type = 'custom_icon' as const
  readonly schema = CustomIconSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CustomIconSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(customIcons).where(eq(customIcons.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote custom icon update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent custom icon edit, using last-write-wins', { itemId })
        }

        const ext = data.ext ?? existing.ext
        const iconData = data.data ?? existing.data

        tx.update(customIcons)
          .set({
            name: data.name ?? existing.name,
            ext,
            data: iconData,
            clock: resolution.mergedClock,
            syncedAt: now,
            updatedAt: data.updatedAt ?? now
          })
          .where(eq(customIcons.id, itemId))
          .run()

        // A rename does not resend bytes, but rewriting them is what repairs a
        // device whose file went missing, and an icon is a few KB.
        if (ext !== existing.ext) removeIconFile(itemId, existing.ext)
        mirrorIconFile(itemId, ext, iconData)
        ctx.emit(CustomIconsChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      // Every payload field is optional, so `{}` parses. Without this guard a
      // frozen-payload push (pull-coordinator enqueues '{}' on conflict) would
      // materialise a permanent byte-less ghost icon whose empty clock makes
      // every later legitimate version compare as stale.
      if (!data.name || !data.ext || !data.data) {
        log.warn('Skipping remote custom icon insert, payload is incomplete', { itemId })
        return 'skipped'
      }

      tx.insert(customIcons)
        .values({
          id: itemId,
          name: data.name,
          ext: data.ext,
          data: data.data,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          updatedAt: data.updatedAt ?? now
        })
        .run()

      mirrorIconFile(itemId, data.ext, data.data)
      ctx.emit(CustomIconsChannels.events.UPDATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(customIcons).where(eq(customIcons.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote custom icon delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(customIcons).where(eq(customIcons.id, itemId)).run()
    removeIconFile(itemId, existing.ext)
    ctx.emit(CustomIconsChannels.events.UPDATED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(customIcons).where(eq(customIcons.id, itemId)).get() as
      Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const icon = db.select().from(customIcons).where(eq(customIcons.id, itemId)).get()
    if (!icon) return null
    return JSON.stringify(icon)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(customIcons).set({ syncedAt: utcNow() }).where(eq(customIcons.id, itemId)).run()
  }

  /** Carries icons that already exist on a live-beta device onto the account. */
  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(customIcons).where(isNull(customIcons.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(customIcons).set({ clock }).where(eq(customIcons.id, item.id)).run()
      queue.enqueue({
        type: 'custom_icon',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const customIconHandler = new CustomIconHandler()
