import {
  TAG_CHIP_FILL_ALPHA,
  getTagColors,
  withAlpha,
  type TagColorConfig
} from '@memry/contracts/tag-colors'
import type { Color } from '@/theme/colors'
import { normalizeTagKey } from '@/features/notes/note-ops'

/**
 * The tag chip palette, resolved from the SHARED table in contracts.
 *
 * This file used to hold six locally-invented hues and its own string fold, so
 * a tag the desktop painted orange came out purple here. Both halves of that
 * were wrong: the palette (20 named hues) and the fold (`| 0` truncation over
 * `COLOR_NAMES` in insertion order) are wire contract, not styling, and now
 * live in one module both platforms import.
 *
 * The label is the hue itself rather than a darkened step. That is the desktop
 * chip, exactly, and the fills are light enough that only the LABEL misses
 * WCAG AA — the same miss desktop already ships. Darkening it here is what
 * produced the mismatch Kaan reported, so parity wins and the contrast debt is
 * one fix on the shared table rather than two divergent ones.
 */
export interface TagColor {
  fill: Color
  text: Color
}

function toChip(config: TagColorConfig): TagColor {
  return {
    fill: withAlpha(config.text, TAG_CHIP_FILL_ALPHA) as Color,
    text: config.text as Color
  }
}

/**
 * The chip colours for a tag.
 *
 * `authoredColor` is the `color` field off the tag's synced `tag_definition`
 * row — a palette name, or a `#rrggbb` the user picked. Absent (no row pulled
 * yet, or a vault that never named a colour) falls back to the shared hash,
 * which is what desktop shows for exactly the same tag.
 */
export function tagColor(tag: string, authoredColor?: string | null): TagColor {
  return toChip(getTagColors(authoredColor ?? '', normalizeTagKey(tag)))
}

/** A select/status/multiselect option chip. Same table, same alpha. */
export function optionColor(colorName: string): TagColor {
  return toChip(getTagColors(colorName))
}
