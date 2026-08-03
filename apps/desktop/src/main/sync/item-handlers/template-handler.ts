import { eq, isNull } from 'drizzle-orm'
import { templates } from '@memry/db-schema/schema/templates'
import { TemplateSyncPayloadSchema, type TemplateSyncPayload } from '@memry/contracts/sync-payloads'
import { TemplatesChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TemplateHandler')

class TemplateHandler extends BaseItemHandler<TemplateSyncPayload> {
  readonly type = 'template' as const
  readonly schema = TemplateSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TemplateSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(templates).where(eq(templates.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote template update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent template edit, using last-write-wins', { itemId })
        }

        tx.update(templates)
          .set({
            name: data.name ?? existing.name,
            description: data.description !== undefined ? data.description : existing.description,
            icon: data.icon !== undefined ? data.icon : existing.icon,
            tags: data.tags ?? existing.tags,
            properties: (data.properties as unknown[]) ?? existing.properties,
            content: data.content ?? existing.content,
            clock: resolution.mergedClock,
            syncedAt: now,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(templates.id, itemId))
          .run()

        ctx.emit(TemplatesChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(templates)
        .values({
          id: itemId,
          name: data.name ?? 'Untitled Template',
          description: data.description ?? null,
          icon: data.icon ?? null,
          tags: data.tags ?? [],
          properties: (data.properties as unknown[]) ?? [],
          content: data.content ?? '',
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(TemplatesChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(templates).where(eq(templates.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote template delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(templates).where(eq(templates.id, itemId)).run()
    ctx.emit(TemplatesChannels.events.DELETED, { id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(templates).where(eq(templates.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const template = db.select().from(templates).where(eq(templates.id, itemId)).get()
    if (!template) return null
    return JSON.stringify(template)
  }

  markPushSynced(db: DrizzleDb, itemId: string): void {
    db.update(templates).set({ syncedAt: utcNow() }).where(eq(templates.id, itemId)).run()
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(templates).where(isNull(templates.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(templates).set({ clock }).where(eq(templates.id, item.id)).run()
      queue.enqueue({
        type: 'template',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const templateHandler = new TemplateHandler()
