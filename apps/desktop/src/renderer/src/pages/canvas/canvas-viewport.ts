/**
 * Canvas viewport — the tab's camera.
 *
 * Excalidraw's `serializeAsJSON` exports a CLEANED appState, and `scrollX`,
 * `scrollY` and `zoom` are deliberately not in it. The stored scene has
 * therefore never carried a viewport, so every mount fell back to
 * `scrollToContent`: coming back to a canvas tab reset the zoom to 100% and
 * jumped to whatever happens to sit in the middle of the drawing.
 *
 * The camera belongs to the TAB, not to the document. The same canvas open in
 * two split panes is two viewpoints, and where one device is looking is not
 * something to push to the others. So it is stored exactly like the PDF page
 * number and the image zoom: an entity-stamped `Tab.viewState` entry (see
 * `hooks/use-tab-entity-view-state.ts`), which survives a tab switch and a
 * session restore without touching the scene payload or the sync protocol.
 */

/** Slot in `Tab.viewState`. */
export const CANVAS_VIEWPORT_KEY = 'canvasViewport'

export interface CanvasViewport {
  scrollX: number
  scrollY: number
  /** Excalidraw's `appState.zoom.value`; `1` is 100%. */
  zoom: number
}

/**
 * Excalidraw's own zoom bounds, restated rather than imported: they live in the
 * library's internal constants, which are not part of its public API.
 */
const MIN_ZOOM = 0.1
const MAX_ZOOM = 30

/** The shape this module needs out of an Excalidraw appState. */
export interface ViewportAppState {
  scrollX?: number
  scrollY?: number
  zoom?: { value: number }
}

/**
 * Total parse for a persisted viewport, as `useTabViewState` requires: tab state
 * can have been written by an older build, so anything unrecognised has to be
 * rejected rather than trusted.
 *
 * A zoom outside Excalidraw's range is REJECTED, not clamped. Clamping would
 * drop the user at a position they never left the canvas at; rejecting falls
 * back to first-open behaviour, which is the honest answer for a record we
 * cannot trust.
 */
export function parseCanvasViewport(raw: unknown): CanvasViewport | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { scrollX, scrollY, zoom } = raw as Record<string, unknown>
  if (typeof scrollX !== 'number' || !Number.isFinite(scrollX)) return undefined
  if (typeof scrollY !== 'number' || !Number.isFinite(scrollY)) return undefined
  if (typeof zoom !== 'number' || !Number.isFinite(zoom)) return undefined
  if (zoom < MIN_ZOOM || zoom > MAX_ZOOM) return undefined
  return { scrollX, scrollY, zoom }
}

/**
 * The viewport a live appState is showing, or `undefined` while Excalidraw has
 * not put real numbers there yet. Routed through the same parse as the stored
 * value so a live reading and a restored one can never disagree about what
 * counts as a viewport.
 */
export function viewportFromAppState(appState: ViewportAppState): CanvasViewport | undefined {
  return parseCanvasViewport({
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    zoom: appState.zoom?.value
  })
}

/** Whether two viewports describe the same camera, so a no-op write is skipped. */
export function sameViewport(a: CanvasViewport | null, b: CanvasViewport | null): boolean {
  if (a === null || b === null) return a === b
  return a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom
}
