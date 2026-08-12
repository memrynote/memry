/**
 * Canvas folder IPC contract.
 *
 * A canvas folder is a real directory under `<vault>/canvases`. Placement of a
 * canvas lives on the canvas row (`folder`), so these rows carry only the
 * folder's icon and its existence — which is what lets an EMPTY folder reach
 * another device.
 *
 * @module contracts/canvas-folder-api
 */

import { z } from 'zod'
// (.ts extension required: this file runs under node --experimental-strip-types
// via the rpc bindings generator.)
import { CanvasFolderChannels } from './ipc-channels.ts'
export { CanvasFolderChannels }

export interface CanvasFolder {
  /** Deterministic, derived from `path` — see canvasFolderSyncId. */
  id: string
  /** Path relative to `canvases/`, forward-slashed. Never null: root is not a row. */
  path: string
  icon: string | null
  createdAt: number
  updatedAt: number
}

export const CanvasFolderCreateSchema = z.object({
  /** Parent folder, or null to create at the canvases root. */
  parent: z.string().nullable().optional(),
  name: z.string().min(1)
})

export const CanvasFolderRenameSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1)
})

export const CanvasFolderMoveSchema = z.object({
  path: z.string().min(1),
  /** New parent, or null for the canvases root. */
  parent: z.string().nullable()
})

export const CanvasFolderSetIconSchema = z.object({
  path: z.string().min(1),
  icon: z.string().nullable()
})

export const CanvasFolderDeleteSchema = z.object({
  path: z.string().min(1)
})

export interface CanvasFolderListResponse {
  folders: CanvasFolder[]
}

export interface CanvasFolderMutationResponse {
  folder: CanvasFolder | null
}

export interface CanvasFolderDeleteResponse {
  success: boolean
  /** Canvases tombstoned along with the folder. */
  deletedCanvasIds: string[]
}

export interface CanvasFolderCreatedEvent {
  folder: CanvasFolder
}

export interface CanvasFolderUpdatedEvent {
  folder: CanvasFolder
  /** Set when the change moved the folder, so listeners can re-key state. */
  previousPath?: string
}

export interface CanvasFolderDeletedEvent {
  path: string
}
