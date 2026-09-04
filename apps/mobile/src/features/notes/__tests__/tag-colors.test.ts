import { describe, expect, it } from 'vitest'

import {
  COLOR_NAMES,
  TAG_COLORS,
  defaultTagColorName,
  getTagColors
} from '@memry/contracts/tag-colors'
import { normalizeTagKey } from '../note-ops'
import { optionColor, tagColor } from '@/theme/colors/tag-colors'

/**
 * The bug these pin: mobile shipped its own six-hue palette and its own string
 * fold, so a tag desktop painted orange came out purple here. Parity is the
 * assertion, not aesthetics — anything that re-derives a hue locally fails.
 */
describe('tagColor', () => {
  it('paints the hue the shared table hands the same tag', () => {
    for (const tag of ['Commons', 'roadmap', 'q3-planning', 'x', 'work']) {
      const shared = getTagColors('', normalizeTagKey(tag))
      expect(tagColor(tag).text).toBe(shared.text)
    }
  })

  it('fills with the hue at 12 percent, in the #rrggbbaa form React Native reads', () => {
    const chip = tagColor('roadmap')
    expect(chip.fill).toBe(`${chip.text}1f`)
  })

  it('honours the colour off the tag_definition row over the hash', () => {
    const authored = tagColor('roadmap', 'tangerine')
    expect(authored.text).toBe(TAG_COLORS.tangerine.text)
    expect(authored.text).not.toBe(tagColor('roadmap').text)
  })

  it('takes a user-picked hex verbatim', () => {
    expect(tagColor('roadmap', '#ff8800').text).toBe('#ff8800')
  })

  it('ignores case, the way tag identity does', () => {
    expect(tagColor('Commons').text).toBe(tagColor('commons').text)
    expect(tagColor('  ROADMAP ').text).toBe(tagColor('roadmap').text)
    expect(normalizeTagKey('Commons')).toBe('commons')
  })

  it('only ever returns a hue from the shared table', () => {
    const hues = new Set(COLOR_NAMES.map((name) => TAG_COLORS[name].text))
    for (const tag of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
      expect(hues.has(tagColor(tag).text)).toBe(true)
    }
  })

  it('falls back to the same hue the shared fold picks, name for name', () => {
    for (const tag of ['alpha', 'beta', 'gamma', 'delta']) {
      expect(tagColor(tag).text).toBe(TAG_COLORS[defaultTagColorName(tag)].text)
    }
  })
})

describe('optionColor', () => {
  it('resolves a select option colour name off the same table', () => {
    expect(optionColor('indigo').text).toBe(TAG_COLORS.indigo.text)
    expect(optionColor('indigo').fill).toBe(`${TAG_COLORS.indigo.text}1f`)
  })

  it('lands on stone for an option colour nobody set', () => {
    expect(optionColor('').text).toBe(TAG_COLORS.stone.text)
  })
})
