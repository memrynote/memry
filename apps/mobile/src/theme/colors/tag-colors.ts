import type { Color } from '@/theme/colors'
import { normalizeTagKey } from '@/features/notes/note-ops'

/**
 * The tag chip palette.
 *
 * Mobile has no `tag_definition` sync handler, so no server-side colour exists
 * to read and the hue has to be derived locally from the tag itself.
 *
 * Each entry is a hue at 12 percent alpha (`1f`, which React Native accepts as
 * `#RRGGBBAA`) plus a darkened step of the SAME hue for the label. The label is
 * solved against the fill COMPOSITED OVER `#ffffff`, which is the pill's real
 * background and a stricter target than the raw canvas. Measured ratios, label
 * on composited fill then label on `#ffffff`:
 *
 *   slate  4.63 / 5.19    teal   4.62 / 5.08    blue   4.64 / 5.50
 *   cyan   4.61 / 5.31    purple 4.75 / 5.70    green  4.64 / 5.30
 *
 * Six hues, not eight. `dot.orange` is excluded because an orange tag reads as
 * the `tint` accent, and the destructive red because a red tag reads as danger.
 * slate and teal come off the board; blue, cyan, purple and green are darkened
 * steps of `dot.blue`, `dot.cyan`, `dot.purple` and `dot.green` in `white.ts`.
 */
export interface TagColor {
  fill: Color
  text: Color
}

interface TagColorSource {
  fill: string
  text: string
}

const sources: readonly TagColorSource[] = [
  { fill: '#8494A81f', text: '#626e7d' },
  { fill: '#4CC0AC1f', text: '#307a6e' },
  { fill: '#2563eb1f', text: '#245fe3' },
  { fill: '#0891b21f', text: '#067590' },
  { fill: '#7c3aed1f', text: '#7c3aed' },
  { fill: '#16a34a1f', text: '#117c38' }
]

// The one place raw hex becomes a branded `Color` here, the same single-step
// boundary `brandTheme` is for the theme itself. A double assertion would let
// any string through and the brand would stop meaning anything.
export const tagColors = sources as readonly TagColor[]

/**
 * The same tag gets the same colour on every screen and across launches, so
 * the hash is a plain deterministic string fold — no `Math.random`, no clock.
 * Keyed on the normalized tag, so `Commons` and `commons` are one colour just
 * as they are one tag.
 */
export function tagColor(tag: string): TagColor {
  const key = normalizeTagKey(tag)
  let hash = 0
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 0xffffffff
  }
  return tagColors[hash % tagColors.length]
}
