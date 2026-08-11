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
import { readSceneElements } from '../../../canvas/elements'
import { canvasPathKey, normalizeStoredFolder } from '../../../canvas/folder-paths'
import { getCanvas, listCanvases, listCanvasesWithCounts } from '../../../canvas/store'
import { summarizeScene } from '../../../canvas/summary'
import { getCanvasContext } from '../../../canvas/vault-key'
import type { DataDb } from '../../../database'
import { getTaskById } from '../../../database/queries/tasks'
import { getNoteById } from '../../../vault/notes'
import { AgentToolError } from '../errors'
import { assertSpatialCanvasEnabled } from './canvas-flag'
import { invokeCanvasWrite } from './canvas-write'
import type {
  CanvasDrawOutcome,
  CanvasEntityKind,
  CanvasItemSummary,
  CanvasWriteOutcome,
  VaultServiceHandles
} from './handles'

interface CanvasEntityRefLike {
  entityType: CanvasEntityKind
  entityId: string
}

interface CanvasPlacement {
  title: string | null
  folder: string | null
}

/**
 * How an agent names a canvas: `Work/Plan` for one in a folder, `Plan` for one
 * at the root. Null for an untitled canvas — it has no name to qualify, so only
 * its id can address it.
 */
function qualifiedCanvasPath(row: CanvasPlacement): string | null {
  if (row.title === null) return null
  const folder = normalizeStoredFolder(row.folder)
  return folder === null ? row.title : `${folder}/${row.title}`
}

/**
 * Turn whatever an agent called a canvas into a canvas id.
 *
 * Folders made duplicate titles legal for the first time — `Work/Plan` and
 * `Personal/Plan` are two canvases now — so the qualified path is matched first
 * and a BARE title that matches more than one is refused with every candidate
 * listed. Picking one would mean an agent drawing over the wrong canvas with no
 * error and no trace, which is worse than any failure this can return.
 *
 * Compared through `canvasPathKey` (NFC + lowercase), the same key the rest of
 * the canvas code uses for "is this the same path?", so `work/plan` finds
 * `Work/Plan` the way the filesystem already would on macOS and Windows.
 *
 * An id wins outright, and an unmatched ref is handed back untouched: a caller
 * naming a canvas this vault does not hold must fail exactly as it did before.
 */
function resolveCanvasId(ctx: { db: DataDb; vaultId: string }, ref: string): string {
  const rows = listCanvases(ctx.db, ctx.vaultId)
  if (rows.some((row) => row.id === ref)) return ref

  const key = canvasPathKey(ref)
  const qualified = rows.filter((row) => {
    const path = qualifiedCanvasPath(row)
    return path !== null && canvasPathKey(path) === key
  })
  const matches =
    qualified.length > 0
      ? qualified
      : rows.filter((row) => row.title !== null && canvasPathKey(row.title) === key)

  if (matches.length === 1) return matches[0].id
  if (matches.length > 1) {
    throw new AgentToolError(
      'VALIDATION',
      `"${ref}" names ${matches.length} canvases. Use the folder-qualified name or the id.`,
      {
        canvas: ref,
        candidates: matches.map((row) => ({ id: row.id, path: qualifiedCanvasPath(row) }))
      }
    )
  }
  return ref
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

function toCanvasDrawOutcome(
  canvasId: string,
  result: Awaited<ReturnType<typeof invokeCanvasWrite>>
): CanvasDrawOutcome {
  const elements = result.elements
  return {
    canvas_id: canvasId,
    refs: elements?.refs ?? {},
    created_ids: elements?.createdIds ?? [],
    updated_ids: elements?.updatedIds ?? [],
    deleted_ids: elements?.deletedIds ?? [],
    missing_ids: elements?.missingIds ?? [],
    updated_at: result.updatedAt,
    too_large: result.tooLarge
  }
}

export function createCanvasHandles(dataDb: DataDb): VaultServiceHandles['canvas'] {
  return {
    async list() {
      assertSpatialCanvasEnabled()
      const { db, vaultId } = getCanvasContext()
      return listCanvasesWithCounts(db, vaultId).map((canvas) => ({
        id: canvas.id,
        title: canvas.title,
        folder: canvas.folder,
        // Two canvases may legitimately be titled `Plan` now; the qualified path
        // is what tells them apart and what every other canvas tool accepts.
        path: qualifiedCanvasPath(canvas),
        updated_at: canvas.updatedAt,
        item_count: canvas.itemCount
      }))
    },
    async read(id) {
      assertSpatialCanvasEnabled()
      const ctx = getCanvasContext()
      const canvas = getCanvas(ctx.db, ctx.vaultPath, resolveCanvasId(ctx, id))
      if (!canvas || canvas.unreadable) return null

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
    async readElements(id) {
      assertSpatialCanvasEnabled()
      const ctx = getCanvasContext()
      const canvas = getCanvas(ctx.db, ctx.vaultPath, resolveCanvasId(ctx, id))
      if (!canvas || canvas.unreadable) return null

      const scene = readSceneElements(canvas.scene)
      return {
        canvas_id: canvas.id,
        elements: scene.elements,
        element_count: scene.elementCount,
        truncated: scene.truncated
      }
    },
    async draw(input, windowId) {
      assertSpatialCanvasEnabled()
      const canvasId = resolveCanvasId(getCanvasContext(), input.canvasId)
      const result = await invokeCanvasWrite(windowId, {
        canvasId,
        op: 'draw',
        elements: input.elements
      })
      return toCanvasDrawOutcome(canvasId, result)
    },
    async edit(input, windowId) {
      assertSpatialCanvasEnabled()
      const canvasId = resolveCanvasId(getCanvasContext(), input.canvasId)
      const result = await invokeCanvasWrite(windowId, {
        canvasId,
        op: 'edit',
        edits: input.edits
      })
      return toCanvasDrawOutcome(canvasId, result)
    },
    async addItems(input, windowId) {
      assertSpatialCanvasEnabled()
      // Resolved before any entity check so an ambiguous canvas name fails
      // before the call has looked anything up, let alone minted a card.
      const canvasId = resolveCanvasId(getCanvasContext(), input.canvasId)
      for (const item of input.items) {
        await assertEntityExists(dataDb, item)
      }
      const result = await invokeCanvasWrite(windowId, {
        canvasId,
        op: 'add',
        items: input.items as CanvasEntityRef[]
      })
      return toCanvasWriteOutcome(canvasId, result)
    },
    async removeItem(input, windowId) {
      assertSpatialCanvasEnabled()
      const canvasId = resolveCanvasId(getCanvasContext(), input.canvasId)
      const result = await invokeCanvasWrite(windowId, {
        canvasId,
        op: 'remove',
        items: [input.item as CanvasEntityRef]
      })
      return toCanvasWriteOutcome(canvasId, result)
    }
  }
}
