import { eq, isNull } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { utcNow } from '@memry/shared/utc'
import {
  TagDefinitionSyncPayloadSchema,
  type TagDefinitionSyncPayload
} from '@memry/contracts/sync-payloads'
import { TagsChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { readTagViews, writeTagViews } from '../../database/queries/tag-definitions'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('TagDefinitionHandler')

class TagDefinitionHandler extends BaseItemHandler<TagDefinitionSyncPayload> {
  readonly type = 'tag_definition' as const
  readonly schema = TagDefinitionSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: TagDefinitionSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
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
            clock: resolution.mergedClock
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
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(tagDefinitions)
      .where(eq(tagDefinitions.name, itemId))
      .get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote tag definition delete, local has unseen changes', { itemId })
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
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    _operation: string
  ): string | null {
    const tag = db.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get()
    if (!tag) return null
    const payload: TagDefinitionSyncPayload = {
      name: tag.name,
      color: tag.color,
      colorAuthored: tag.colorAuthored,
      icon: tag.icon ?? null,
      categoryId: tag.categoryId ?? null,
      sortOrder: tag.sortOrder,
      views: readTagViews(db, itemId),
      clock: (tag.clock as VectorClock) ?? undefined,
      createdAt: tag.createdAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(tagDefinitions).where(isNull(tagDefinitions.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(tagDefinitions).set({ clock }).where(eq(tagDefinitions.name, item.name)).run()
      queue.enqueue({
        type: 'tag_definition',
        itemId: item.name,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const tagDefinitionHandler = new TagDefinitionHandler()
