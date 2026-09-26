import { eq, isNull } from 'drizzle-orm'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { utcNow } from '@memry/shared/utc'
import {
  PropertyDefinitionSyncPayloadSchema,
  type PropertyDefinitionSyncPayload
} from '@memry/contracts/sync-payloads'
import { PropertiesChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { isPersistableDefinitionType, type PropertyType } from '@memry/contracts/property-types'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { nextLocalClock } from '@memry/sync-client/tombstone-clocks'
import { createLogger } from '../../lib/logger'
import { PropertyDefinitionsService } from '../../vault/property-definitions'
import { writeSyncedVaultFile } from '../bulk-apply'
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
        const resolution = this.resolveUpsertClock(ctx, itemId, existing.clock, remoteClock, data)
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

        ctx.emit(PropertiesChannels.events.DEFINITION_CHANGED, { name: itemId })
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

      ctx.emit(PropertiesChannels.events.DEFINITION_CHANGED, { name: itemId })
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
      const resolution = this.resolveDeleteClock(existing.clock, clock)
      if (resolution.skip) {
        log.info('Skipping remote property definition delete, local is ahead of the tombstone', {
          itemId
        })
        return 'skipped'
      }
    }

    ctx.db.delete(propertyDefinitions).where(eq(propertyDefinitions.name, itemId)).run()
    // `.memry/properties.md` still names it, and the post-pull reload reads
    // that file first: without this the definition comes straight back. The
    // write joins the page's crash journal (#2284).
    const fileWrite = PropertyDefinitionsService.tryGet()?.applyRemoteDelete(itemId)
    if (fileWrite) writeSyncedVaultFile(fileWrite.filePath, fileWrite.content)
    ctx.emit(PropertiesChannels.events.DEFINITION_DELETED, { name: itemId })
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
      clock: definition.clock ?? undefined,
      createdAt: definition.createdAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    // Older builds wrote unclocked `relation` rows from note frontmatter. A
    // pushed one breaks `properties.md` on every peer that lacks the reload
    // filter, so it stays local until the next reload drops it.
    const items = db
      .select()
      .from(propertyDefinitions)
      .where(isNull(propertyDefinitions.clock))
      .all()
      .filter((item) => isPersistableDefinitionType(item.type as PropertyType))
    for (const item of items) {
      const clock = nextLocalClock(db, 'property_definition', item.name, null, deviceId, 'create')
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
