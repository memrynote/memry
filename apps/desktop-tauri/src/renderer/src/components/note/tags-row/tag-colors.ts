/**
 * The palette moved to `@memry/contracts/tag-colors` so mobile paints the same
 * hues from the same table. This file stays as the renderer's import path —
 * every call site here already reaches for it, and a second copy of the hex
 * values is exactly how the two platforms drifted apart in the first place.
 */
import { isHexColor, tagTextOnLight } from '@memry/contracts/tag-colors'

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

/**
 * CSS colour for text painted in a tag's hue on its chip: the hue itself on dark
 * themes, and on light ones the darker shade that reads at WCAG AA. Picks by the
 * `color-scheme` base.css sets per theme. Fills, dots and swatches keep the hue.
 */
export function tagLabelColor(hex: string): string {
  return isHexColor(hex) ? `light-dark(${tagTextOnLight(hex)}, ${hex})` : hex
}
