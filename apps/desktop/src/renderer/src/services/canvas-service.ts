/**
 * Canvas Service
 *
 * Renderer-side access to the spatial canvas IPC surface (window.api.canvas).
 * Mirrors notes-service: a lazy forwarder over the generated RPC client plus
 * thin event-subscription wrappers returning unsubscribe closures.
 */

import type {
  Canvas,
  CanvasSummary,
  CanvasClientAPI,
  CanvasCreatedEvent,
  CanvasUpdatedEvent,
  CanvasDeletedEvent,
  CanvasTooLargeEvent
} from '@memry/rpc/canvas'
import { createWindowApiForwarder } from './window-api-forwarder'

export type { Canvas, CanvasSummary }

export const canvasService: CanvasClientAPI = createWindowApiForwarder(() => window.api.canvas)

export function onCanvasCreated(callback: (event: CanvasCreatedEvent) => void): () => void {
  return window.api.onCanvasCreated(callback)
}

export function onCanvasUpdated(callback: (event: CanvasUpdatedEvent) => void): () => void {
  return window.api.onCanvasUpdated(callback)
}

export function onCanvasDeleted(callback: (event: CanvasDeletedEvent) => void): () => void {
  return window.api.onCanvasDeleted(callback)
}

export function onCanvasTooLarge(callback: (event: CanvasTooLargeEvent) => void): () => void {
  return window.api.onCanvasTooLarge(callback)
}
