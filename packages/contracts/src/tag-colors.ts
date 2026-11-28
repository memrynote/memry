import { foldTag } from '@memry/shared/tag-fold'

/**
 * The one tag/chip palette every Memry surface paints from.
 *
 * It lived in the desktop renderer and was re-derived, differently, on mobile:
 * six hues instead of twenty and a different hash, so a tag that was orange on
 * the desktop came out purple on the phone. Shipping it from contracts is what
 * makes that class of drift impossible rather than merely fixed once.
 *
 * `background` and `text` are the same hex for every entry. Chips paint the
 * hue at 12 percent for the fill and the hue itself for the label. On a light
 * theme the hue alone is too pale to read on that fill, so the label uses
 * `tagTextOnLight` there instead.
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
 * Hashes the tag fold (`@memry/shared/tag-fold`, protocol §13.7.7), because
 * every spelling of one tag (`#Work`/`#work`, `#İş`/`#iş`) must share a colour.
 * The fold equals `toLowerCase` except for `İ`, `ς` and a dot above after `i`,
 * so only tags containing those changed colour when the hash moved to the fold.
 */
export function defaultTagColorName(tagName: string): string {
  const name = foldTag(tagName)
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

// The darkest light-theme surface a chip sits on (`--surface-active` on the
// paper theme). A label that clears AA on the fill composited over it clears it
// on every lighter surface too.
const LIGHT_CHIP_BASE = '#e4e4de'
// WCAG AA for normal text is 4.5:1. The margin absorbs rounding to a hex byte
// and fills a little denser than TAG_CHIP_FILL_ALPHA (some chips use 0x1F).
const LIGHT_LABEL_CONTRAST = 4.6

type Rgb = [number, number, number]

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

function linearChannel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b)
}

/** WCAG contrast ratio between two opaque colours. */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a))
  const lb = relativeLuminance(hexToRgb(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `hex` painted at `opacity` over an opaque `base`, as the browser composites it. */
function compositeOver(hex: string, opacity: number, base: string): string {
  const top = hexToRgb(hex)
  const under = hexToRgb(base)
  const mix = (i: 0 | 1 | 2): number => top[i] * opacity + under[i] * (1 - opacity)
  return rgbToHex([mix(0), mix(1), mix(2)])
}

function rgbToHsl([r, g, b]: Rgb): Rgb {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / d + 2
        : (rn - gn) / d + 4
  return [h / 6, s, l]
}

function hslToRgb([h, s, l]: Rgb): Rgb {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t0: number): number => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255]
}

const lightLabelCache = new Map<string, string>()

/**
 * The label colour for a chip of `hex` on a light theme: the same hue and
 * saturation, darkened only as far as it takes to read at WCAG AA (4.5:1) on
 * the chip's own fill. Dark themes keep the hue itself, which already reads.
 * Works for any `#rrggbb`, so a user's custom colour gets the same guarantee.
 */
export function tagTextOnLight(hex: string): string {
  const cached = lightLabelCache.get(hex)
  if (cached) return cached
  const fill = compositeOver(hex, TAG_CHIP_FILL_ALPHA, LIGHT_CHIP_BASE)
  let result = hex
  if (contrastRatio(hex, fill) < LIGHT_LABEL_CONTRAST) {
    const [h, s, l] = rgbToHsl(hexToRgb(hex))
    // Contrast rises as lightness falls, so search for the lightest shade that passes.
    let lo = 0
    let hi = l
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2
      if (contrastRatio(rgbToHex(hslToRgb([h, s, mid])), fill) >= LIGHT_LABEL_CONTRAST) lo = mid
      else hi = mid
    }
    result = rgbToHex(hslToRgb([h, s, lo]))
  }
  lightLabelCache.set(hex, result)
  return result
}
