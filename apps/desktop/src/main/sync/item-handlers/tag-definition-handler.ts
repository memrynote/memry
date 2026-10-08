import { eq, isNull } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { utcNow } from '@memry/shared/utc'
import {
  TagDefinitionSyncPayloadSchema,
  type TagDefinitionSyncPayload
} from '@memry/contracts/sync-payloads'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import {
  joinVersionedValue,
  owesHeal,
  readVersionedObject,
  type VersionedObject
} from '@memry/shared/versioned'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { getTagDefinitionSyncService } from '@memry/sync-client/tag-definition-sync'
import { nextLocalClock } from '@memry/sync-client/tombstone-clocks'
import { createLogger } from '../../lib/logger'
import { readTagViews, writeTagViews } from '../../database/queries/tag-definitions'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('TagDefinitionHandler')

/** The `schema` column as an object. Unreadable JSON reads as absent, as `readTagViews` treats views. */
function readSchemaColumn(raw: string | null, tag: string): VersionedObject | undefined {
  if (raw === null) return undefined
  try {
    return readVersionedObject(JSON.parse(raw))
  } catch {
    log.warn('Discarding a corrupt tag schema', { tag })
    return undefined
  }
}

class TagDefinitionHandler extends BaseItemHandler<TagDefinitionSyncPayload> {
  readonly type = 'tag_definition' as const
  readonly schema = TagDefinitionSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TagDefinitionSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    let heal = false
    const result = ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()
      // The schema joins by its own version on every branch, the skip included
      // (chapter 06 §6.11): an older peer can carry an older or a newer schema
      // under any document clock.
      const schema = joinVersionedValue(
        existing ? readSchemaColumn(existing.schema, itemId) : undefined,
        data.schema
      )
      const schemaWrite = schema.localChanged ? { schema: JSON.stringify(schema.value) } : {}

      if (existing) {
        const resolution = this.resolveUpsertClock(
          ctx,
          itemId,
          existing.clock as VectorClock | null,
          remoteClock,
          data
        )
        if (resolution.action === 'skip') {
          if (schema.localChanged) {
            tx.update(tagDefinitions).set(schemaWrite).where(eq(tagDefinitions.name, itemId)).run()
            ctx.emit('notes:tags-changed', {})
          }
          log.info('Skipping remote tag definition update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent tag definition edit, using last-write-wins', { itemId })
        }

        // A colour the palette handed out is not a colour anyone chose.
        // `getOrCreateTag` mints one from `palette[localTagCount % 24]`, so the
        // same tag name is green on the device where it was the 12th tag and red
        // where it was the 23rd. Both sides only ever "seed" that row, so the
        // clocks come out concurrent and last-write-wins used to repaint a
        // deliberate colour with one nobody picked (report 2026-07-21, a green
        // tag turning red after some notes were edited).
        //
        // So an explicitly unauthored colour may create a tag (below) but may
        // never repaint one. `undefined` is *not* "unauthored": only a build that
        // knows this field can send `false`, and refusing every older payload
        // would silently stop honouring real colour changes made on older builds.
        // We honour such a colour without recording an authorship we never
        // observed, so it is never re-asserted onward to a third device.
        const takeRemoteColor = data.colorAuthored !== false && data.color !== undefined
        const color = takeRemoteColor ? data.color : existing.color

        tx.update(tagDefinitions)
          .set({
            color,
            colorAuthored: takeRemoteColor ? data.colorAuthored === true : existing.colorAuthored,
            icon: data.icon !== undefined ? data.icon : existing.icon,
            categoryId: data.categoryId !== undefined ? data.categoryId : existing.categoryId,
            sortOrder: data.sortOrder ?? existing.sortOrder,
            clock: resolution.mergedClock,
            ...schemaWrite
          })
          .where(eq(tagDefinitions.name, itemId))
          .run()

        // `undefined` means the sending client does not know about this field —
        // keep whatever is local. `null` is an explicit clear. Anything else wins.
        // Collapsing these two into a falsy check silently destroys saved views
        // whenever an older client syncs the tag (the project_links bug, again).
        if (data.views !== undefined) {
          writeTagViews(tx, itemId, data.views)
        }

        // A merge returns 'conflict', which re-queues the merged row at the
        // union clock, so only an apply owes its own re-push.
        heal = owesHeal(resolution.action, schema, resolution.action === 'merge')

        // The colour the row actually kept, not the one that was offered — the
        // renderer must not paint a repaint the merge just refused.
        ctx.emit(TagsChannels.events.COLOR_UPDATED, { tag: itemId, color })
        ctx.emit('notes:tags-changed', {})
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(tagDefinitions)
        .values({
          name: itemId,
          color: data.color ?? '#808080',
          // Creating a tag we do not have takes the sender's colour whatever its
          // provenance — there is nothing here to overwrite. We only record
          // authorship the sender actually asserted.
          colorAuthored: data.colorAuthored === true,
          icon: data.icon ?? null,
          categoryId: data.categoryId ?? null,
          sortOrder: data.sortOrder ?? 0,
          schema: schema.value ? JSON.stringify(schema.value) : null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now
        })
        .run()

      if (data.views !== undefined) {
        writeTagViews(tx, itemId, data.views)
      }

      ctx.emit(TagsChannels.events.NOTES_CHANGED, { tag: itemId })
      ctx.emit('notes:tags-changed', {})
      return 'applied'
    })
    // Ticks this device into the clock, so the re-push passes the server's
    // replay check that a push at the remote's own clock would fail.
    if (heal) getTagDefinitionSyncService()?.enqueueUpdate(itemId)
    return result
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(tagDefinitions)
      .where(eq(tagDefinitions.name, itemId))
      .get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveDeleteClock(existing.clock as VectorClock | null, clock)
      if (resolution.skip) {
        log.info('Skipping remote tag definition delete, local is ahead of the tombstone', {
          itemId
        })
        return 'skipped'
      }
    }

    ctx.db.delete(tagDefinitions).where(eq(tagDefinitions.name, itemId)).run()
    ctx.emit(TagsChannels.events.DELETED, { tag: itemId })
    ctx.emit('notes:tags-changed', {})
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get() as
      Record<string, unknown> | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const tag = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get()
    if (!tag) return null
    const views = readTagViews(db, itemId)
    const schema = readSchemaColumn(tag.schema, itemId)
    const payload: TagDefinitionSyncPayload = {
      name: tag.name,
      color: tag.color,
      colorAuthored: tag.colorAuthored,
      icon: tag.icon ?? null,
      categoryId: tag.categoryId ?? null,
      sortOrder: tag.sortOrder,
      // A NULL column means this device does not know, so the key is left
      // out: `views: null` clears every peer, and `schema: null` carries no
      // information (chapter 13 §13.7.7). "No views" travels as `[]`.
      ...(views !== null ? { views } : {}),
      ...(schema ? { schema } : {}),
      clock: (tag.clock as VectorClock) ?? undefined,
      createdAt: tag.createdAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(tagDefinitions).where(isNull(tagDefinitions.clock)).all()
    for (const item of items) {
      const clock = nextLocalClock(db, 'tag_definition', item.name, null, deviceId, 'create')
      db.update(tagDefinitions).set({ clock }).where(eq(tagDefinitions.name, item.name)).run()
      // The push payload, not the row: `views` and `schema` are JSON text in
      // the row, and a string there fails or vanishes on the receiver.
      const payload = this.buildPushPayload(db, item.name, deviceId, 'create')
      if (payload === null) continue
      queue.enqueue({
        type: 'tag_definition',
        itemId: item.name,
        operation: 'create',
        payload,
        priority: 0
      })
    }
    return items.length
  }
}

export const tagDefinitionHandler = new TagDefinitionHandler()
