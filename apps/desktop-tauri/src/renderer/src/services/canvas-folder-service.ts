/**
 * Canvas Folder Service
 *
 * Renderer-side access to the canvas folder IPC surface
 * (window.api.canvasFolder). Mirrors canvas-service: a lazy forwarder over the
 * generated RPC client plus thin event-subscription wrappers returning
 * unsubscribe closures.
 */

import type {
  CanvasFolder,
  CanvasFolderClientAPI,
  CanvasFolderCreatedEvent,
  CanvasFolderUpdatedEvent,
  CanvasFolderDeletedEvent
} from '@memry/rpc/canvas-folder'
import { createWindowApiForwarder } from './window-api-forwarder'

export type { CanvasFolder }

export const canvasFolderService: CanvasFolderClientAPI = createWindowApiForwarder(
  () => window.api.canvasFolder
)

export function onCanvasFolderCreated(
  callback: (event: CanvasFolderCreatedEvent) => void
): () => void {
  return window.api.onCanvasFolderCreated(callback)
}

export function onCanvasFolderUpdated(
  callback: (event: CanvasFolderUpdatedEvent) => void
): () => void {
  return window.api.onCanvasFolderUpdated(callback)
}

export function onCanvasFolderDeleted(
  callback: (event: CanvasFolderDeletedEvent) => void
): () => void {
  return window.api.onCanvasFolderDeleted(callback)
}
