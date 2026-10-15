/**
 * Placement for the `@` menu: below the caret, flipped above only when the room
 * below is too short to show a usable list.
 *
 * BlockNote's default uses `autoPlacement`, which picks whichever side has more
 * room. The full menu is taller than either side, so with the caret anywhere in
 * the lower half of the viewport it opens upward and covers the text being
 * written (#3043).
 */

import { detectOverflow, offset, shift, size, type Middleware } from '@floating-ui/react'

const GAP = 10
const PADDING = 10
/** Room below the caret that still shows a handful of rows. */
const MIN_HEIGHT_BELOW = 200

const preferBelow: Middleware = {
  name: 'preferBelow',
  async fn(state) {
    if (state.placement !== 'bottom-start') return {}
    const floating = await detectOverflow(state, { padding: PADDING })
    const reference = await detectOverflow(state, { padding: PADDING, elementContext: 'reference' })
    const roomBelow = state.rects.floating.height - floating.bottom
    const roomAbove = -reference.top - GAP
    const needed = Math.min(state.rects.floating.height, MIN_HEIGHT_BELOW)
    if (roomBelow >= needed || roomAbove <= roomBelow) return {}
    return { reset: { placement: 'top-start' } }
  }
}

export const MENTION_MENU_FLOATING_OPTIONS = {
  useFloatingOptions: {
    placement: 'bottom-start' as const,
    middleware: [
      offset(GAP),
      preferBelow,
      shift(),
      size({
        apply({ elements, availableHeight }) {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`
        },
        padding: PADDING
      })
    ]
  }
}
