/**
 * The palette moved to `@memry/contracts/tag-colors` so mobile paints the same
 * hues from the same table. This file stays as the renderer's import path —
 * every call site here already reaches for it, and a second copy of the hex
 * values is exactly how the two platforms drifted apart in the first place.
 */
export {
  TAG_COLORS,
  COLOR_NAMES,
  COLOR_ROWS,
  defaultTagColorName,
  isHexColor,
  getTagColors,
  withAlpha,
  type TagColorConfig
} from '@memry/contracts/tag-colors'
