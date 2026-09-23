import { describe, expect, it } from 'vitest'
import { CALENDAR_COLORS, calendarColorHex } from '@memry/contracts/calendar-colors'

import {
  CALENDAR_COLOR_FILL_PERCENT,
  calendarColorChipStyle,
  inkOnCalendarColor
} from './calendar-colors'
import { AA_SMALL_TEXT, THEMES, blend, contrastRatio, resolveColor } from '@tests/utils/contrast'

const PALETTE = CALENDAR_COLORS.map((color) => [color, calendarColorHex(color)] as const)
/** A custom Google calendar colour can be any hex; these are the extremes. */
const CUSTOM = [
  ['custom black', '#000000'],
  ['custom white', '#ffffff'],
  ['custom mid grey', '#777777']
] as const
const ALL = [...PALETTE, ...CUSTOM]

describe.each(THEMES)('calendar colours in %s', (theme) => {
  const background = resolveColor(theme, '--background')

  it.each(ALL)('keeps a resting %s chip title at AA', (_name, hex) => {
    const fill = blend(hex, background, CALENDAR_COLOR_FILL_PERCENT / 100)

    expect(contrastRatio(resolveColor(theme, '--foreground'), fill)).toBeGreaterThanOrEqual(
      AA_SMALL_TEXT
    )
  })
})

describe('selected calendar colour chips', () => {
  it.each(ALL)('keeps a selected %s chip title at AA', (_name, hex) => {
    expect(contrastRatio(inkOnCalendarColor(hex), hex)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it('tints at rest and goes solid when selected', () => {
    expect(calendarColorChipStyle('#d50000', false)).toEqual({
      backgroundColor: 'color-mix(in srgb, #d50000 20%, var(--background))',
      color: 'var(--foreground)'
    })
    expect(calendarColorChipStyle('#d50000', true)).toEqual({
      backgroundColor: '#d50000',
      color: '#ffffff'
    })
    expect(calendarColorChipStyle('#f6bf26', true)).toEqual({
      backgroundColor: '#f6bf26',
      color: '#000000'
    })
  })
})
