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
  /** Path relative to `canvases/`, forward-slashed. Null means the root. */
  folder: string | null
  icon: string | null
  /**
   * The document could not be read — a pre-file legacy row whose encrypted
   * snapshot this device holds no key for, or a file moved/deleted outside the
   * app. On a full `Canvas` this also means `scene` is empty and the editor
   * must NOT mount: saving over it would erase recoverable ink. Carried on the
   * summary too so the sidebar can render it as degraded instead of pretending
   * it opens.
   */
  unreadable?: boolean
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
  scene: z.string().optional(),
  /** Path relative to `canvases/`, forward-slashed. Null/absent is the root. */
  folder: z.string().nullable().optional(),
  icon: z.string().nullable().optional()
})

export const CanvasUpdateSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable().optional(),
  scene: z.string().optional(),
  /**
   * Move the canvas. Path relative to `canvases/`, forward-slashed; null moves
   * it to the root. Absent leaves placement untouched — which is why every
   * pre-existing caller (autosave included) keeps working unchanged.
   */
  folder: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  entityRefs: z.array(CanvasEntityRefSchema).optional(),
  /**
   * Optimistic concurrency guard. When present the store compares it against
   * the stored `updatedAt` INSIDE its update transaction and rejects a
   * mismatch, so a writer that read the canvas earlier cannot clobber a change
   * that landed in between. Omitted — as the renderer's autosave and every
   * pre-existing caller do — means last-write-wins exactly as before.
   */
  expectedUpdatedAt: z.number().int().optional()
})

/** Why an update did not apply. */
export type CanvasUpdateFailure = 'not-found' | 'conflict'

/**
 * One Excalidraw LibraryItem. Only `id` is ours to reason about — it is the
 * per-item storage key and the reconciliation key across devices. Everything
 * else (elements, name, status, created) is stored verbatim and never
 * interpreted, so an Excalidraw upgrade that adds fields round-trips intact;
 * hence `looseObject` rather than a closed shape that would strip them.
 */
export const CanvasLibraryItemSchema = z.looseObject({
  id: z.string().min(1)
})
export type CanvasLibraryItem = z.infer<typeof CanvasLibraryItemSchema>

/**
 * The whole library as Excalidraw hands it to us. Excalidraw's persistence
 * adapter is blob-shaped (it always saves the full list); main diffs this
 * against the stored rows, so an item missing here is a delete.
 */
export const CanvasLibrarySaveSchema = z.object({
  libraryItems: z.array(CanvasLibraryItemSchema)
})

export const CanvasGetAssetSchema = z.object({
  canvasId: z.string().min(1),
  fileId: z.string().min(1)
})

export const CanvasListAssetsSchema = z.object({
  canvasId: z.string().min(1)
})

// ============================================================================
// Responses & Events
// ============================================================================

export interface CanvasListResponse {
  canvases: CanvasSummary[]
}

/** A canvas summary carrying how many entities sit on it (advisory refs). */
export interface CanvasSummaryWithCount extends CanvasSummary {
  itemCount: number
}

/**
 * canvas:update response. `tooLarge` mirrors CanvasTooLargeEvent for callers
 * with no event subscription (agent MCP writes): the scene was saved locally
 * but is too large to sync.
 */
export interface CanvasUpdateResponse extends CanvasSummary {
  tooLarge: boolean
}

/**
 * Descriptor for one asset (Excalidraw binary file) attached to a canvas
 * scene. Stored alongside the scene; content-addressed on disk via
 * AttachmentSyncService.
 */
export interface MemryAssetDescriptor {
  fileId: string // Excalidraw file id (per scene)
  attachmentId: string // random id from AttachmentSyncService.uploadAttachment
  contentHash: string // plaintext sha256 hex (dedup key)
  chunkHashes: string[] // encryptedHash[] from the upload manifest — for dereference
  mimeType: string
  sizeBytes: number
  filename: string // content-addressed on-disk filename
}

export interface CanvasUploadAssetResponse {
  ref: string // memry-file:// URL
  descriptor: MemryAssetDescriptor
  deduped: boolean
}

/**
 * Answer to the pre-upload gate. `false` means externalization must be a quiet
 * no-op this save (images stay inline and are retried once sync is available),
 * NOT that anything failed.
 */
export interface CanvasCanUploadAssetResponse {
  canUpload: boolean
}

export interface CanvasGetAssetResponse {
  ref: string | null
}

export interface CanvasListAssetsResponse {
  assets: MemryAssetDescriptor[]
}

export interface CanvasDeleteResponse {
  success: boolean
}

export interface CanvasLibraryListResponse {
  libraryItems: CanvasLibraryItem[]
}

export interface CanvasLibrarySaveResponse {
  /** Rows written (inserted + updated + tombstoned) — 0 means the save was a no-op. */
  changed: number
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
