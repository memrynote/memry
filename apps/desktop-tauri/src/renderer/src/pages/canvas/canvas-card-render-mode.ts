/**
 * Level-of-detail decision for canvas cards.
 *
 * Cards render their entity exactly as the editor does (rich mode). That mounts
 * a real BlockNote/editor tree per visible card, so two escape hatches keep the
 * M2/M7 perf gate (200 cards, heavy ink, smooth pan/zoom) intact:
 *
 * - Zoomed far out, card text is physically unreadable, so the cheap summary
 *   render is indistinguishable to the user.
 * - Past a visible-card count, the mount cost dominates; the whole layer drops
 *   to summaries at once (never a mixed set, which would look like a bug).
 *
 * Pure + Excalidraw-free so it unit-tests without the library, matching
 * canvas-active.ts / canvas-note-lock.ts.
 */

/** Below this zoom the rich render is illegible, so summaries are free. */
export const RICH_MIN_ZOOM = 0.4

/** Above this many mounted cards, the layer falls back to summaries. */
export const RICH_MAX_CARDS = 16

export interface RenderModeInput {
  /** appState.zoom.value */
  zoom: number
  /** Number of cards currently mounted in the overlay. */
  visibleCount: number
}

/** True when cards should render their full editor-fidelity body. */
export function shouldRenderRich({ zoom, visibleCount }: RenderModeInput): boolean {
  if (!Number.isFinite(zoom) || zoom < RICH_MIN_ZOOM) {
    return false
  }
  return visibleCount <= RICH_MAX_CARDS
}
