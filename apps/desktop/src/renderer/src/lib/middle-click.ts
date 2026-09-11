/**
 * Middle-click gesture.
 *
 * A middle click never produces a `click` event, so "open in a background tab"
 * has to be read off `mousedown`. `preventDefault` also suppresses Chromium's
 * autoscroll cursor, which would otherwise latch onto the scroll container.
 *
 * @module lib/middle-click
 */

/** Run `open` when `event` is a middle click; ignore every other button. */
export function handleMiddleClick(event: React.MouseEvent, open: () => void): void {
  if (event.button !== 1) return
  event.preventDefault()
  open()
}

export default handleMiddleClick
