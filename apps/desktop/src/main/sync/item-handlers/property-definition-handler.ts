import { eq, isNull } from 'drizzle-orm'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { utcNow } from '@memry/shared/utc'
import {
  PropertyDefinitionSyncPayloadSchema,
  type PropertyDefinitionSyncPayload
} from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { increment } from '@memry/sync-client/vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('PropertyDefinitionHandler')

/**
 * The vault's property definitions, replicated.
 *
 * `.memry/properties.md` stays the file a human can read and edit, but it is
 * local to one machine, so before this handler a `select` property arrived on a
 * second device as bare text with its option colours gone. The DATA DB row is
 * what replicates; `PropertyDefinitionsService.reload()` unions the clocked
 * rows back into that file after every pull.
 *
 * `options` moves as the opaque JSON string the column holds. Parsing it here
 * would drop whatever a newer client put inside it.
 */
class PropertyDefinitionHandler extends BaseItemHandler<PropertyDefinitionSyncPayload> {
  readonly type = 'property_definition' as const
  readonly schema = PropertyDefinitionSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: PropertyDefinitionSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx
        .select()
        .from(propertyDefinitions)
        .where(eq(propertyDefinitions.name, itemId))
        .get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote property definition update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent property definition edit, using last-write-wins', { itemId })
        }

        tx.update(propertyDefinitions)
          .set({
            type: data.type,
            // `undefined` means the sender does not know the field and must not
            // clobber what is local; `null` is an explicit clear. Collapsing the
            // two into a falsy check is how saved views were destroyed once.
            options: data.options !== undefined ? data.options : existing.options,
            defaultValue:
              data.defaultValue !== undefined ? data.defaultValue : existing.defaultValue,
            color: data.color !== undefined ? data.color : existing.color,
            clock: resolution.mergedClock,
            syncedAt: now
          })
          .where(eq(propertyDefinitions.name, itemId))
          .run()

        ctx.emit('notes:property-definitions-changed', { name: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(propertyDefinitions)
        .values({
          name: itemId,
          type: data.type,
          options: data.options ?? null,
          defaultValue: data.defaultValue ?? null,
          color: data.color ?? null,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now
        })
        .run()

      ctx.emit('notes:property-definitions-changed', { name: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.name, itemId))
      .get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote property definition delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(propertyDefinitions).where(eq(propertyDefinitions.name, itemId)).run()
    // `.memry/properties.md` still names it, and the post-pull reload reads
    // that file first — without this the definition comes straight back.
    void import('../../vault/property-definitions')
      .then(({ PropertyDefinitionsService }) =>
        PropertyDefinitionsService.get().applyRemoteDelete(itemId)
      )
      .catch(() => {
        // No vault open, so no file to reconcile.
      })
    ctx.emit('notes:property-definitions-deleted', { name: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.name, itemId))
      .get() as Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const definition = db
      .select()
      .from(propertyDefinitions)
      .where(eq(propertyDefinitions.name, itemId))
      .get()
    if (!definition) return null
    const payload: PropertyDefinitionSyncPayload = {
      name: definition.name,
      type: definition.type,
      options: definition.options ?? null,
      defaultValue: definition.defaultValue ?? null,
      color: definition.color ?? null,
      clock: (definition.clock as VectorClock) ?? undefined,
      createdAt: definition.createdAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db
      .select()
      .from(propertyDefinitions)
      .where(isNull(propertyDefinitions.clock))
      .all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(propertyDefinitions)
        .set({ clock })
        .where(eq(propertyDefinitions.name, item.name))
        .run()
      queue.enqueue({
        type: 'property_definition',
        itemId: item.name,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const propertyDefinitionHandler = new PropertyDefinitionHandler()
