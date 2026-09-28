/**
 * Writes the advisory `canvas_entity_edges` rows for one canvas.
 *
 * Shared by every place that already maintains `canvas_entity_refs` (local
 * save, sync apply, conflict copy, vault-open reconcile), so the two indexes
 * are always rebuilt from the same scene. Edges are always derived in main from
 * the scene itself; nothing the renderer sends is trusted for them.
 *
 * @module canvas/edge-index
 */

import { eq } from 'drizzle-orm'
import { canvasEntityEdges } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/db-schema/drizzle-db'
import { extractEntityEdgesFromScene } from './scene-refs'

type EdgeWriter = Pick<DrizzleDb, 'insert' | 'delete'>

export function clearCanvasEdges(db: EdgeWriter, canvasId: string): void {
  db.delete(canvasEntityEdges).where(eq(canvasEntityEdges.canvasId, canvasId)).run()
}

/** Replace a canvas's edges with the ones its scene draws. */
export function rewriteCanvasEdges(db: EdgeWriter, canvasId: string, scene: string): void {
  clearCanvasEdges(db, canvasId)
  for (const edge of extractEntityEdgesFromScene(scene)) {
    db.insert(canvasEntityEdges)
      .values({
        canvasId,
        arrowId: edge.arrowId,
        sourceType: edge.source.entityType,
        sourceId: edge.source.entityId,
        targetType: edge.target.entityType,
        targetId: edge.target.entityId
      })
      .onConflictDoNothing()
      .run()
  }
}
