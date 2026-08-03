/**
 * Which window currently has a canvas mounted in its editor.
 *
 * An agent write to a canvas the user has open must reach that live Excalidraw
 * instance rather than a headless read-modify-write, or the editor's next
 * autosave serializes its own stale element list and silently overwrites the
 * agent's change (#916 hazard 2e).
 *
 * Fed by canvas:live-opened / canvas:live-closed from CanvasEditor. A stale
 * entry is not dangerous: the write falls through to the headless path, which
 * is guarded by expectedUpdatedAt.
 *
 * @module canvas/live-registry
 */

const canvasToWindow = new Map<string, number>()

export function markCanvasOpen(canvasId: string, windowId: number): void {
  canvasToWindow.set(canvasId, windowId)
}

/**
 * Only the current owner may release a canvas. A window that unmounts AFTER
 * another has already opened the same canvas must not evict the newer owner.
 */
export function markCanvasClosed(canvasId: string, windowId: number): void {
  if (canvasToWindow.get(canvasId) === windowId) canvasToWindow.delete(canvasId)
}

export function forgetWindow(windowId: number): void {
  for (const [canvasId, owner] of canvasToWindow) {
    if (owner === windowId) canvasToWindow.delete(canvasId)
  }
}

export function getCanvasWindowId(canvasId: string): number | null {
  return canvasToWindow.get(canvasId) ?? null
}
