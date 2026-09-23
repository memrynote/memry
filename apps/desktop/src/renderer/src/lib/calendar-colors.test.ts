import { describe, expect, it } from 'vitest'
import { CALENDAR_COLORS, calendarColorHex } from '@memry/contracts/calendar-colors'

import {
  CALENDAR_COLOR_FILL_PERCENT,
  CALENDAR_COLOR_META_PERCENT,
  calendarColorChipVars,
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
  const ink = resolveColor(theme, '--cal-ink')

  it.each(ALL)('keeps a resting %s chip title at AA', (_name, hex) => {
    const fill = blend(hex, background, CALENDAR_COLOR_FILL_PERCENT / 100)

    expect(contrastRatio(ink, fill)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it.each(ALL)('keeps a resting %s chip time at AA', (_name, hex) => {
    const fill = blend(hex, background, CALENDAR_COLOR_FILL_PERCENT / 100)
    const meta = blend(hex, ink, CALENDAR_COLOR_META_PERCENT / 100)

    expect(contrastRatio(meta, fill)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })
})

describe('selected calendar colour chips', () => {
  it.each(ALL)('keeps a selected %s chip title at AA', (_name, hex) => {
    expect(contrastRatio(inkOnCalendarColor(hex), hex)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it('tints at rest and goes solid with readable ink when selected', () => {
    expect(calendarColorChipVars('#d50000')).toEqual({
      '--chip-rail': '#d50000',
      '--chip-surface': 'color-mix(in srgb, #d50000 25%, var(--background))',
      '--chip-meta': 'color-mix(in srgb, #d50000 35%, var(--cal-ink))',
      '--chip-solid': '#d50000',
      '--chip-solid-ink': '#ffffff'
    })
    expect(calendarColorChipVars('#f6bf26')['--chip-solid-ink']).toBe('#000000')
  })
})
