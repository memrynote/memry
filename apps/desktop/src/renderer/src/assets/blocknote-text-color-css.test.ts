import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AA_SMALL_TEXT,
  contrastRatio,
  resolveColor,
  type ThemeSelector
} from '@tests/utils/contrast'

const BASE_CSS = join(dirname(fileURLToPath(import.meta.url)), 'base.css')

const SWATCHES = ['gray', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']

/**
 * BlockNote paints text colours from `--bn-colors-highlights-<hue>-text` and
 * ships Notion's legacy palette. Measured against our backgrounds it carried
 * three separate defects — swatches below WCAG AA, swatches with so little
 * chroma they read as grey whatever their name, and swatches sitting on top of
 * the body text. base.css re-cuts all nine; the floors below are the acceptance
 * criteria that re-cut was designed to hit.
 *
 * jsdom has no cascade, and the palette lives in a third-party stylesheet we
 * never load in unit tests, so a source-level parse-and-assert is the honest
 * guard. It catches the override being deleted and, because these are floors
 * rather than frozen hexes, it also catches a future re-theme that quietly
 * drops a swatch back toward grey or under AA.
 */
const LIGHT_SELECTOR = ':root .bn-container'
const DARK_SELECTOR = ":root .bn-container[data-color-scheme='dark']"

/** Below this, OKLCH chroma stops reading as a nameable hue and looks grey. */
const MIN_CHROMA = 0.05
/** OKLab distance a swatch needs from the body text to look like a choice. */
const MIN_DISTANCE_FROM_BODY = 0.15
/** OKLab distance two swatches need from each other to stay tellable apart. */
const MIN_DISTANCE_BETWEEN_SWATCHES = 0.06

const PARSED = new Map<string, Map<string, string>>()

/**
 * Every custom property `selector` sets, merged across all of its rules in
 * document order (last wins, as the cascade would have it). base.css spreads
 * one selector over several blocks — `:root .bn-container` carries the palette
 * vars up top and the editor chrome further down — so reading only the last
 * matching block would miss declarations that are genuinely in effect.
 *
 * Memoised: the pairwise checks ask for the same selector ~80 times, and
 * re-reading and re-parsing a 70 KB stylesheet each time cost ~35s.
 */
function customProperties(selector: string): Map<string, string> {
  const cached = PARSED.get(selector)
  if (cached) return cached

  const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ')
  const css = readFileSync(BASE_CSS, 'utf8')
    // Statement at-rules first, and before comments: `@source
    // "…/streamdown/dist/*.js";` contains a literal `/*`, so a naive comment
    // strip reads it as a comment opener and eats every line up to the next
    // `*/` — about sixty of them, including the rule under test.
    .replace(/^[ \t]*@[a-z-]+[^;{}\n]*;[ \t]*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const merged = new Map<string, string>()

  for (const [, selectorList, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(normalize).includes(normalize(selector))) continue
    for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      merged.set(name, value.trim())
    }
  }
  PARSED.set(selector, merged)
  return merged
}

function swatch(selector: string, name: string): string {
  const value = customProperties(selector).get(`--bn-colors-highlights-${name}-text`)

  expect(value, `\`${selector}\` does not set the ${name} text colour`).toBeDefined()
  expect(value, `${name} must be a hex literal`).toMatch(/^#[0-9a-f]{6}$/i)
  return value as string
}

/** Oklab coordinates of an `#rrggbb`, per the Oklab spec. */
function oklab(hex: string): { l: number; a: number; b: number } {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const cbrt = (v: number): number => Math.cbrt(v)
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

const chroma = (hex: string): number => Math.hypot(oklab(hex).a, oklab(hex).b)

function distance(x: string, y: string): number {
  const p = oklab(x)
  const q = oklab(y)
  return Math.hypot(p.l - q.l, p.a - q.a, p.b - q.b)
}

// The stock palette, kept so the guard can say "this is BlockNote's, not ours"
// rather than only checking a shape the stock values might accidentally satisfy.
const STOCK = {
  light: [
    '#9b9a97',
    '#64473a',
    '#e03e3e',
    '#d9730d',
    '#dfab01',
    '#4d6461',
    '#0b6e99',
    '#6940a5',
    '#ad1a72'
  ],
  dark: [
    '#bebdb8',
    '#8e6552',
    '#ec4040',
    '#e3790d',
    '#dfab01',
    '#6b8b87',
    '#0e87bc',
    '#8552d7',
    '#da208f'
  ]
}

const MODES = [
  {
    mode: 'light' as const,
    selector: LIGHT_SELECTOR,
    // Both light themes share this block, and paper is darker than white, so
    // paper is the binding constraint. Assert against both anyway.
    themes: [':root', '.white'] as ThemeSelector[],
    body: '#37352f'
  },
  {
    mode: 'dark' as const,
    selector: DARK_SELECTOR,
    themes: ['.dark'] as ThemeSelector[],
    body: '#bcbab6'
  }
]

describe('BlockNote text colour palette', () => {
  describe.each(MODES)('$mode', ({ mode, selector, themes, body }) => {
    it('overrides every swatch rather than inheriting BlockNote stock', () => {
      const ours = SWATCHES.map((name) => swatch(selector, name).toLowerCase())

      expect(ours).toHaveLength(STOCK[mode].length)
      for (const [index, hex] of ours.entries()) {
        expect(hex, `${SWATCHES[index]} is still the stock value`).not.toBe(STOCK[mode][index])
      }
    })

    it.each(SWATCHES)('%s carries enough chroma to name a hue', (name) => {
      // Gray is the one deliberate neutral, so it is the one exemption.
      if (name === 'gray') {
        expect(chroma(swatch(selector, name))).toBeLessThan(MIN_CHROMA)
        return
      }
      expect(chroma(swatch(selector, name))).toBeGreaterThanOrEqual(MIN_CHROMA)
    })

    it.each(SWATCHES)('%s stays clear of the body text', (name) => {
      expect(distance(swatch(selector, name), body)).toBeGreaterThanOrEqual(MIN_DISTANCE_FROM_BODY)
    })

    it.each(themes)('every swatch clears AA for small text on %s', (theme) => {
      const background = resolveColor(theme, '--background')

      for (const name of SWATCHES) {
        const ratio = contrastRatio(swatch(selector, name), background)
        expect(ratio, `${name} on ${theme} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          AA_SMALL_TEXT
        )
      }
    })

    it('keeps every pair of swatches tellable apart', () => {
      for (let i = 0; i < SWATCHES.length; i++) {
        for (let j = i + 1; j < SWATCHES.length; j++) {
          const gap = distance(swatch(selector, SWATCHES[i]), swatch(selector, SWATCHES[j]))
          expect(
            gap,
            `${SWATCHES[i]} and ${SWATCHES[j]} are ${gap.toFixed(4)} apart`
          ).toBeGreaterThanOrEqual(MIN_DISTANCE_BETWEEN_SWATCHES)
        }
      }
    })

    it('keeps brown darker than orange darker than yellow', () => {
      // They share the warm hue arc; lightness order is the only thing stopping
      // brown from reading as a dull orange.
      const lightness = (name: string): number => oklab(swatch(selector, name)).l

      expect(lightness('brown')).toBeLessThan(lightness('orange'))
      expect(lightness('orange')).toBeLessThan(lightness('yellow'))
    })
  })
})
