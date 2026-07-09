import { eq, isNull } from 'drizzle-orm'
import { customThemes } from '@memry/db-schema/schema/custom-themes'
import { utcNow } from '@memry/shared/utc'
import { ThemeSyncPayloadSchema, type ThemeSyncPayload } from '@memry/contracts/sync-payloads'
import {
  sanitizeThemeVariables,
  type CustomTheme,
  type ThemeBase
} from '@memry/contracts/themes-api'
import { ThemesChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'
import { applyThemeFile, removeThemeFile } from './theme-file-effects'

const log = createLogger('ThemeHandler')

function toCustomTheme(
  id: string,
  data: Pick<ThemeSyncPayload, 'name' | 'base' | 'variables'>,
  createdAt: string,
  modifiedAt: string
): CustomTheme {
  return {
    id,
    name: data.name,
    base: data.base as ThemeBase,
    variables: sanitizeThemeVariables(data.variables),
    createdAt,
    modifiedAt
  }
}

class ThemeHandler extends BaseItemHandler<ThemeSyncPayload> {
  readonly type = 'theme' as const
  readonly schema = ThemeSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: ThemeSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(customThemes).where(eq(customThemes.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()
      const variables = sanitizeThemeVariables(data.variables)

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote theme update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent theme edit, using last-write-wins', { itemId })
        }

        const modifiedAt = data.modifiedAt ?? now
        tx.update(customThemes)
          .set({
            name: data.name,
            slug: data.slug,
            base: data.base,
            variables,
            clock: resolution.mergedClock,
            modifiedAt
          })
          .where(eq(customThemes.id, itemId))
          .run()

        applyThemeFile(
          data.slug,
          toCustomTheme(itemId, { ...data, variables }, existing.createdAt, modifiedAt),
          existing.slug
        )
        ctx.emit(ThemesChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      const createdAt = data.createdAt ?? now
      const modifiedAt = data.modifiedAt ?? now
      tx.insert(customThemes)
        .values({
          id: itemId,
          name: data.name,
          slug: data.slug,
          base: data.base,
          variables,
          clock: remoteClock,
          createdAt,
          modifiedAt
        })
        .run()

      applyThemeFile(
        data.slug,
        toCustomTheme(itemId, { ...data, variables }, createdAt, modifiedAt)
      )
      ctx.emit(ThemesChannels.events.UPDATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(customThemes).where(eq(customThemes.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote theme delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(customThemes).where(eq(customThemes.id, itemId)).run()
    removeThemeFile(existing.slug)
    ctx.emit(ThemesChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(customThemes).where(eq(customThemes.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const row = db.select().from(customThemes).where(eq(customThemes.id, itemId)).get()
    if (!row) return null
    const payload: ThemeSyncPayload = {
      name: row.name,
      slug: row.slug,
      base: row.base as ThemeSyncPayload['base'],
      variables: (row.variables as Record<string, string>) ?? {},
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(customThemes).where(isNull(customThemes.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(customThemes).set({ clock }).where(eq(customThemes.id, item.id)).run()
      queue.enqueue({
        type: 'theme',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const themeHandler = new ThemeHandler()
