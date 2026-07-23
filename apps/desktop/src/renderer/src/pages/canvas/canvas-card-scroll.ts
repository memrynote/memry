/**
 * Wheel routing for idle canvas cards.
 *
 * An idle card body is `pointer-events: none` (canvas pan/draw/select must pass
 * through to the Excalidraw rectangle underneath), so it can never receive a
 * wheel event itself. The overlay therefore hit-tests the card under the cursor
 * on a capture-phase wheel listener and scrolls it imperatively — but only when
 * that scroll would actually move. At the top/bottom edge the event is left
 * alone so the gesture keeps zooming the canvas instead of dead-ending on a
 * card.
 *
 * Pure (no DOM, no Excalidraw) so the decision unit-tests directly.
 */

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * How far to scroll the card for this wheel delta, in the card's own (unscaled)
 * pixels — 0 means "don't consume the event, let the canvas zoom".
 *
 * The overlay is CSS-scaled by the canvas zoom, so a screen-space delta covers
 * `delta / zoom` card pixels; without that division a zoomed-out card would
 * scroll absurdly fast.
 */
export function wheelScrollDelta(metrics: ScrollMetrics, deltaY: number, zoom: number): number {
  const maxScroll = metrics.scrollHeight - metrics.clientHeight
  // A 1px slack absorbs sub-pixel layout rounding, which would otherwise report
  // a permanently "scrollable" card that never moves.
  if (maxScroll <= 1 || deltaY === 0) {
    return 0
  }
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const desired = deltaY / scale
  const next = Math.min(Math.max(metrics.scrollTop + desired, 0), maxScroll)
  const applied = next - metrics.scrollTop
  // Already pinned at the edge in this direction → hand the gesture back.
  return Math.abs(applied) < 0.5 ? 0 : applied
}
