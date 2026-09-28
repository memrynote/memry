/**
 * Reads over `canvas_entity_edges`: arrows between two cards on a live canvas.
 *
 * Every read joins `canvases` and drops tombstones. The delete paths prune the
 * rows too, but the table is advisory and the join is what guarantees a
 * deleted canvas never shows up as a connection.
 *
 * @module database/queries/canvas-edges
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { canvasEntityEdges, canvases } from '@memry/db-schema/data-schema'
import type { CanvasEntityType } from '@memry/contracts/canvas-api'
import type { DataDb } from '../types'

export interface CanvasEdgeRow {
  canvasId: string
  canvasTitle: string | null
  sourceType: CanvasEntityType
  sourceId: string
  targetType: CanvasEntityType
  targetId: string
}

const edgeColumns = {
  canvasId: canvasEntityEdges.canvasId,
  canvasTitle: canvases.title,
  sourceType: canvasEntityEdges.sourceType,
  sourceId: canvasEntityEdges.sourceId,
  targetType: canvasEntityEdges.targetType,
  targetId: canvasEntityEdges.targetId
}

/**
 * Several arrows can join the same two cards on one canvas; they are one
 * connection. The same pair on two canvases stays two, one per canvas.
 */
function dedupe(rows: CanvasEdgeRow[]): CanvasEdgeRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = [row.canvasId, row.sourceType, row.sourceId, row.targetType, row.targetId].join(
      '\u0000'
    )
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Every edge on a live canvas. */
export function listCanvasEdges(db: DataDb): CanvasEdgeRow[] {
  return dedupe(
    db
      .select(edgeColumns)
      .from(canvasEntityEdges)
      .innerJoin(canvases, eq(canvases.id, canvasEntityEdges.canvasId))
      .where(isNull(canvases.deletedAt))
      .all()
  )
}

/**
 * Edges on a live canvas with either end among `ids`, as one of `types`. The
 * type is part of the filter so both lookups can use the (type, id) indexes.
 * Callers keep `ids` under SQLite's bound-parameter ceiling.
 */
export function getCanvasEdgesTouching(
  db: DataDb,
  types: CanvasEntityType[],
  ids: string[]
): CanvasEdgeRow[] {
  if (ids.length === 0 || types.length === 0) return []
  return dedupe(
    db
      .select(edgeColumns)
      .from(canvasEntityEdges)
      .innerJoin(canvases, eq(canvases.id, canvasEntityEdges.canvasId))
      .where(
        and(
          isNull(canvases.deletedAt),
          or(
            and(
              inArray(canvasEntityEdges.sourceType, types),
              inArray(canvasEntityEdges.sourceId, ids)
            ),
            and(
              inArray(canvasEntityEdges.targetType, types),
              inArray(canvasEntityEdges.targetId, ids)
            )
          )
        )
      )
      .all()
  )
}

/** Edges on a live canvas that start or end at this entity. */
export function getCanvasEdgesForEntity(
  db: DataDb,
  entityType: CanvasEntityType,
  entityId: string
): CanvasEdgeRow[] {
  return dedupe(
    db
      .select(edgeColumns)
      .from(canvasEntityEdges)
      .innerJoin(canvases, eq(canvases.id, canvasEntityEdges.canvasId))
      .where(
        and(
          isNull(canvases.deletedAt),
          or(
            and(
              eq(canvasEntityEdges.sourceType, entityType),
              eq(canvasEntityEdges.sourceId, entityId)
            ),
            and(
              eq(canvasEntityEdges.targetType, entityType),
              eq(canvasEntityEdges.targetId, entityId)
            )
          )
        )
      )
      .all()
  )
}
