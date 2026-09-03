import { describe, expect, it } from 'vitest'

import { normalizeTagKey } from '../note-ops'
import { tagColor, tagColors } from '@/theme/colors/tag-colors'

/**
 * sRGB relative luminance, computed here rather than trusted from the palette's
 * comment: a copied literal would stay green after someone edited a hex.
 */
function channel(value: number): number {
  const s = value / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The pill's real background: the hue at its alpha, over the white canvas. */
function overWhite(fill: string): [number, number, number] {
  const alpha = parseInt(fill.slice(7, 9), 16) / 255
  return rgb(fill.slice(0, 7)).map((v) => Math.round(255 * (1 - alpha) + v * alpha)) as [
    number,
    number,
    number
  ]
}

describe('tag palette', () => {
  it('clears AA against the composited pill fill, not against bare white', () => {
    for (const entry of tagColors) {
      expect(contrast(rgb(entry.text), overWhite(entry.fill))).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('tagColor', () => {
  it('returns the same palette entry for the same tag every time', () => {
    for (const tag of ['Commons', 'roadmap', 'q3-planning', 'x', '']) {
      expect(tagColor(tag)).toBe(tagColor(tag))
    }
  })

  it('ignores case, the way tag identity does', () => {
    expect(tagColor('Commons')).toBe(tagColor('commons'))
    expect(tagColor('  ROADMAP ')).toBe(tagColor('roadmap'))
    expect(normalizeTagKey('Commons')).toBe('commons')
  })

  it('only ever returns an entry from the palette', () => {
    for (const tag of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
      expect(tagColors).toContain(tagColor(tag))
    }
  })
})
