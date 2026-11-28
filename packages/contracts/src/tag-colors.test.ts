import { describe, expect, it } from 'vitest'
import { COLOR_NAMES, TAG_CHIP_FILL_ALPHA, TAG_COLORS, tagTextOnLight } from './tag-colors'

// An independent WCAG 2.x contrast oracle, so the test does not grade the
// implementation with its own arithmetic.
function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
}

function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(text: string, fill: number[]): number {
  const a = luminance(channels(text))
  const b = luminance(fill)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function chipFill(hue: string, alpha: number, surface: string): number[] {
  const top = channels(hue)
  return channels(surface).map((c, i) => top[i] * alpha + c * (1 - alpha))
}

// Every light-theme surface a chip can sit on (base.css paper and white themes:
// background, surface, surface-active, card).
const LIGHT_SURFACES = ['#ffffff', '#f6f5f0', '#efefe9', '#e4e4de', '#f5f5f5', '#ebebec']
// TAG_CHIP_FILL_ALPHA, and the `1F` byte some chips use.
const FILL_ALPHAS = [TAG_CHIP_FILL_ALPHA, 0x1f / 255]

function worstContrast(hue: string): number {
  const text = tagTextOnLight(hue)
  return Math.min(
    ...LIGHT_SURFACES.flatMap((surface) =>
      FILL_ALPHAS.map((alpha) => contrast(text, chipFill(hue, alpha, surface)))
    )
  )
}

describe('tagTextOnLight', () => {
  it.each(COLOR_NAMES)('makes the %s label read at WCAG AA on its light chip', (name) => {
    expect(worstContrast(TAG_COLORS[name].text)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['#ffff00', '#ffffff', '#00ff00', '#88ccff', '#ff00ff', '#000000', '#7f7f7f'])(
    'makes the custom colour %s read at WCAG AA on its light chip',
    (hex) => {
      expect(worstContrast(hex)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it('keeps the hue: only lightness drops', () => {
    // lemon is the palest palette colour; its label must darken, staying yellow-green.
    const ink = channels(tagTextOnLight(TAG_COLORS.lemon.text))
    const hue = channels(TAG_COLORS.lemon.text)
    expect(luminance(ink)).toBeLessThan(luminance(hue))
    expect(ink[0]).toBeGreaterThan(ink[2])
    expect(ink[1]).toBeGreaterThan(ink[2])
  })

  it('leaves a colour that already reads untouched', () => {
    expect(tagTextOnLight('#000000')).toBe('#000000')
  })
})
