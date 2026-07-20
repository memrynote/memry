/**
 * Canvas IPC API Contract (spatial canvas)
 *
 * A canvas is one Excalidraw scene stored as a single encrypted snapshot in
 * the data db. Item cards inside the scene reference real entities
 * (note / task / calendar_event) by id only — content is never snapshotted.
 * See docs/superpowers/specs/2026-07-17-spatial-canvas-design.md.
 *
 * @module contracts/canvas-api
 */

import { z } from 'zod'

// Import and re-export channels from the contract-local surface.
// (.ts extension required: this file runs under node --experimental-strip-types
// via the rpc bindings generator.)
import { CanvasChannels } from './ipc-channels.ts'
export { CanvasChannels }

// ============================================================================
// Types
// ============================================================================

/** Entity kinds a canvas card can reference. */
export const CANVAS_ENTITY_TYPES = ['note', 'task', 'calendar_event'] as const
export type CanvasEntityType = (typeof CANVAS_ENTITY_TYPES)[number]

/**
 * Canvas metadata without the scene payload (list views, events).
 */
export interface CanvasSummary {
  id: string
  title: string | null
  createdAt: number
  updatedAt: number
}

/**
 * Full canvas record with the decrypted scene.
 */
export interface Canvas extends CanvasSummary {
  /**
   * Serialized Excalidraw scene JSON (serializeAsJSON output). Empty string
   * for a canvas that has not been drawn on yet.
   */
  scene: string
}

// ============================================================================
// Request Schemas
// ============================================================================

/**
 * One advisory entity reference extracted from the scene's card rectangles.
 * The renderer computes the full set on save; the store rewrites the
 * canvas_entity_refs rows from it.
 */
export const CanvasEntityRefSchema = z.object({
  entityType: z.enum(CANVAS_ENTITY_TYPES),
  entityId: z.string().min(1)
})
export type CanvasEntityRef = z.infer<typeof CanvasEntityRefSchema>

export const CanvasCreateSchema = z.object({
  title: z.string().nullable().optional(),
  scene: z.string().optional()
})

export const CanvasUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  scene: z.string().optional(),
  entityRefs: z.array(CanvasEntityRefSchema).optional()
})

// ============================================================================
// Responses & Events
// ============================================================================

export interface CanvasListResponse {
  canvases: CanvasSummary[]
}

export interface CanvasDeleteResponse {
  success: boolean
}

export interface CanvasCreatedEvent {
  canvas: CanvasSummary
}

export interface CanvasUpdatedEvent {
  canvas: CanvasSummary
}

export interface CanvasDeletedEvent {
  id: string
}

/** A local canvas save whose scene is too large to sync (see §5.6). */
export interface CanvasTooLargeEvent {
  id: string
}
