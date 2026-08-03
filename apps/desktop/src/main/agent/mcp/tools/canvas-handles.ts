/**
 * Canvas section of the vault service handles.
 *
 * Split out of handles-adapter.ts, which is at its max-lines ceiling and had no
 * business owning canvas entity resolution on top of everything else. Reads run
 * entirely in main (the store plus the Excalidraw-free scene summarizer);
 * writes route to a renderer window via canvas-write.ts, because only the
 * renderer can mint valid Excalidraw elements.
 *
 * @module agent/mcp/tools/canvas-handles
 */

import type { CanvasEntityRef } from '@memry/contracts/canvas-api'

import { getCalendarEventById } from '../../../calendar/repositories/calendar-events-repository'
import { getCanvas, listCanvasesWithCounts } from '../../../canvas/store'
import { summarizeScene } from '../../../canvas/summary'
import { getCanvasContext } from '../../../canvas/vault-key'
import type { DataDb } from '../../../database'
import { getTaskById } from '../../../database/queries/tasks'
import { getNoteById } from '../../../vault/notes'
import { AgentToolError } from '../errors'
import { assertSpatialCanvasEnabled } from './canvas-flag'
import { invokeCanvasWrite } from './canvas-write'
import type {
  CanvasEntityKind,
  CanvasItemSummary,
  CanvasWriteOutcome,
  VaultServiceHandles
} from './handles'

interface CanvasEntityRefLike {
  entityType: CanvasEntityKind
  entityId: string
}

/**
 * Resolve a card's entity to a display title. A card whose entity no longer
 * exists reports missing:true rather than being dropped — an agent should be
 * able to see and report a stale card, not silently under-report the canvas.
 */
async function resolveCanvasItem(
  dataDb: DataDb,
  ref: CanvasEntityRefLike
): Promise<CanvasItemSummary> {
  const base = { entity_type: ref.entityType, entity_id: ref.entityId }
  if (ref.entityType === 'note') {
    const note = await getNoteById(ref.entityId)
    return { ...base, title: note?.title ?? null, missing: !note }
  }
  if (ref.entityType === 'task') {
    const task = getTaskById(dataDb, ref.entityId)
    return { ...base, title: task?.title ?? null, missing: !task }
  }
  const event = getCalendarEventById(dataDb, ref.entityId)
  return { ...base, title: event?.title ?? null, missing: !event }
}

/** Refuse to mint a card pointing at nothing — the UI picker cannot, so neither can an agent. */
async function assertEntityExists(dataDb: DataDb, ref: CanvasEntityRefLike): Promise<void> {
  const resolved = await resolveCanvasItem(dataDb, ref)
  if (resolved.missing) {
    throw new AgentToolError('NOT_FOUND', `${ref.entityType} ${ref.entityId} not found`, {
      entityType: ref.entityType,
      entityId: ref.entityId
    })
  }
}

function toCanvasWriteOutcome(
  canvasId: string,
  result: {
    applied: { entityType: string; entityId: string }[]
    skipped: { ref: { entityType: string; entityId: string }; reason: string }[]
    updatedAt: number
    tooLarge: boolean
  }
): CanvasWriteOutcome {
  return {
    canvas_id: canvasId,
    applied: result.applied.map((ref) => ({
      entity_type: ref.entityType,
      entity_id: ref.entityId
    })),
    skipped: result.skipped.map((skip) => ({
      entity_type: skip.ref.entityType,
      entity_id: skip.ref.entityId,
      reason: skip.reason
    })),
    updated_at: result.updatedAt,
    too_large: result.tooLarge
  }
}

export function createCanvasHandles(dataDb: DataDb): VaultServiceHandles['canvas'] {
  return {
    async list() {
      assertSpatialCanvasEnabled()
      const { db, vaultId } = await getCanvasContext()
      return listCanvasesWithCounts(db, vaultId).map((canvas) => ({
        id: canvas.id,
        title: canvas.title,
        updated_at: canvas.updatedAt,
        item_count: canvas.itemCount
      }))
    },
    async read(id) {
      assertSpatialCanvasEnabled()
      const { db, vaultKey } = await getCanvasContext()
      const canvas = getCanvas(db, vaultKey, id)
      if (!canvas) return null

      const summary = summarizeScene(canvas.scene)
      const items = await Promise.all(summary.items.map((ref) => resolveCanvasItem(dataDb, ref)))
      return {
        id: canvas.id,
        title: canvas.title,
        created_at: canvas.createdAt,
        updated_at: canvas.updatedAt,
        items,
        texts: summary.texts,
        element_count: summary.elementCount,
        texts_truncated: summary.textsTruncated
      }
    },
    async addItems(input, windowId) {
      assertSpatialCanvasEnabled()
      for (const item of input.items) {
        await assertEntityExists(dataDb, item)
      }
      const result = await invokeCanvasWrite(windowId, {
        canvasId: input.canvasId,
        op: 'add',
        items: input.items as CanvasEntityRef[]
      })
      return toCanvasWriteOutcome(input.canvasId, result)
    },
    async removeItem(input, windowId) {
      assertSpatialCanvasEnabled()
      const result = await invokeCanvasWrite(windowId, {
        canvasId: input.canvasId,
        op: 'remove',
        items: [input.item as CanvasEntityRef]
      })
      return toCanvasWriteOutcome(input.canvasId, result)
    }
  }
}
