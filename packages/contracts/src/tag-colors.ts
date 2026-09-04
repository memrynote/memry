/**
 * The one tag/chip palette every Memry surface paints from.
 *
 * It lived in the desktop renderer and was re-derived, differently, on mobile:
 * six hues instead of twenty and a different hash, so a tag that was orange on
 * the desktop came out purple on the phone. Shipping it from contracts is what
 * makes that class of drift impossible rather than merely fixed once.
 *
 * `background` and `text` are the same hex for every entry. Chips paint the
 * hue at 12 percent for the fill and the hue itself for the label.
 */
export interface TagColorConfig {
  background: string
  text: string
}

export const TAG_COLORS: Record<string, TagColorConfig> = {
  // Row 1: Warm spectrum (red → yellow → green)
  rose: { background: '#E07888', text: '#E07888' },
  coral: { background: '#D8846C', text: '#D8846C' },
  tangerine: { background: '#CC9456', text: '#CC9456' },
  amber: { background: '#C4A44E', text: '#C4A44E' },
  lemon: { background: '#B8B44C', text: '#B8B44C' },
  sage: { background: '#7CB86C', text: '#7CB86C' },
  emerald: { background: '#50B888', text: '#50B888' },

  // Row 2: Cool spectrum (green → blue → purple)
  mint: { background: '#4CC0AC', text: '#4CC0AC' },
  teal: { background: '#4AB8BE', text: '#4AB8BE' },
  cyan: { background: '#52AACC', text: '#52AACC' },
  sky: { background: '#64A0D8', text: '#64A0D8' },
  cobalt: { background: '#748CE0', text: '#748CE0' },
  indigo: { background: '#8A7CD6', text: '#8A7CD6' },
  violet: { background: '#A470D0', text: '#A470D0' },

  // Row 3: Purple → Pink + Neutrals
  plum: { background: '#C06CB0', text: '#C06CB0' },
  magenta: { background: '#D46C96', text: '#D46C96' },
  slate: { background: '#8494A8', text: '#8494A8' },
  sand: { background: '#ADA088', text: '#ADA088' },
  stone: { background: '#949490', text: '#949490' },
  mauve: { background: '#A494AA', text: '#A494AA' }
}

export const COLOR_NAMES = Object.keys(TAG_COLORS)

export const COLOR_ROWS = [
  ['rose', 'coral', 'tangerine', 'amber', 'lemon', 'sage', 'emerald'],
  ['mint', 'teal', 'cyan', 'sky', 'cobalt', 'indigo', 'violet'],
  ['plum', 'magenta', 'slate', 'sand', 'stone', 'mauve']
]

/**
 * The colour a tag gets when nobody picked one.
 *
 * Every byte of this — the multiplier, the `| 0` truncation, `Math.abs`, and
 * `COLOR_NAMES` in insertion order — is part of the wire contract: two devices
 * that fold the same name differently disagree about the colour of a tag no
 * `tag_definition` row covers. Hashes the lowercased name, because tag identity
 * is case-insensitive and `#Work` and `#work` are one tag.
 */
export function defaultTagColorName(tagName: string): string {
  const name = tagName.toLowerCase()
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return COLOR_NAMES[Math.abs(hash) % COLOR_NAMES.length]
}

// A user-picked custom color, stored verbatim as the tag's color value.
// Native <input type="color"> always emits 6-digit #rrggbb.
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value)
}

/**
 * Resolve to a palette config. An explicit palette name wins; a custom hex is
 * used as-is; otherwise a stable colour is derived from the tag name.
 */
export function getTagColors(colorName: string, tagName?: string): TagColorConfig {
  if (colorName && TAG_COLORS[colorName]) return TAG_COLORS[colorName]
  if (isHexColor(colorName)) return { background: colorName, text: colorName }
  if (tagName) return TAG_COLORS[defaultTagColorName(tagName)]
  return TAG_COLORS.stone
}

/** `#rrggbb` plus an alpha byte. React Native and CSS both read this form. */
export function withAlpha(hex: string, opacity: number): string {
  const alpha = Math.round(opacity * 255)
    .toString(16)
    .padStart(2, '0')
  return `${hex}${alpha}`
}

/** The alpha every chip fill uses, so the two platforms cannot pick different ones. */
export const TAG_CHIP_FILL_ALPHA = 0.12
