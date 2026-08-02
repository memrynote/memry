/**
 * The mounted Excalidraw instance for a canvas, reachable from outside React.
 *
 * The agent MCP write handler is not in the canvas component tree, so it needs
 * a way to reach the live editor: applying an agent write to the live instance
 * is what keeps the editor's next autosave from overwriting it (#916 §2e).
 * Registered by CanvasEditor for as long as it is mounted.
 */

import type { SceneEditElement } from './canvas-scene-edit'

export interface LiveCanvasHandle {
  getElements(): readonly SceneEditElement[]
  updateScene(elements: SceneEditElement[]): void
  /** Persist immediately rather than waiting out the autosave debounce. */
  flush(): Promise<void>
}

const live = new Map<string, LiveCanvasHandle>()

export function registerLiveCanvas(canvasId: string, handle: LiveCanvasHandle): void {
  live.set(canvasId, handle)
}

/**
 * Pass `handle` so a StrictMode double-mount — where the FIRST mount's cleanup
 * runs after the second has already registered — cannot unregister the live
 * editor out from under itself.
 */
export function unregisterLiveCanvas(canvasId: string, handle?: LiveCanvasHandle): void {
  if (handle && live.get(canvasId) !== handle) return
  live.delete(canvasId)
}

export function getLiveCanvas(canvasId: string): LiveCanvasHandle | null {
  return live.get(canvasId) ?? null
}
