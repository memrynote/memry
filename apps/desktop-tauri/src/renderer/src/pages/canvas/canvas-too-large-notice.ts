/**
 * Session-scoped record of which canvases have already announced that they are
 * too large to sync (§5.6).
 *
 * The notice is edge-triggered (#1626): announced when a canvas stops syncing,
 * re-armed once one of its saves syncs again. That edge was tracked in a ref
 * inside CanvasEditor — but only the active tab is mounted, so switching away
 * from a canvas destroys the editor and coming back builds a fresh one with the
 * ref cleared. Every return to the tab therefore re-announced (#1643), and it
 * did so without the user touching anything: the stored scene of a canvas that
 * has externalized images carries a top-level `memryAssets` sidecar that the
 * renderer's serializer never reproduces, so the first autosave after mount
 * always differs from the loaded scene and always runs.
 *
 * The edge therefore lives here, outside React, so it survives unmount:
 * - announced at most once per canvas per app session,
 * - re-armed for that canvas when one of its saves syncs again, so shrinking a
 *   canvas back under the ceiling and growing it past it again warns anew,
 * - kept per canvas id, so a different canvas still gets its own notice,
 * - never persisted: a restart re-announces, so the divergence is never
 *   silenced, only de-duplicated.
 *
 * Keyed by canvas id alone — ids are minted per canvas, not per vault, so two
 * vaults cannot collide here. Same shape (and same lifetime) as the failed
 * upload registry in canvas-externalize.
 */

const announcedCanvasIds = new Set<string>()

/**
 * Claims the one notice this canvas gets. True exactly once per canvas until
 * something re-arms it — the caller shows the toast only when it wins the claim.
 */
export function claimTooLargeNotice(canvasId: string): boolean {
  if (announcedCanvasIds.has(canvasId)) {
    return false
  }
  announcedCanvasIds.add(canvasId)
  return true
}

/** A save that synced re-arms this canvas's notice for the next time it stops. */
export function rearmTooLargeNotice(canvasId: string): void {
  announcedCanvasIds.delete(canvasId)
}

/** Test seam: forget every announcement, as a fresh app session would. */
export function resetTooLargeNotices(): void {
  announcedCanvasIds.clear()
}
