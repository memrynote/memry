import { describe, expect, it } from 'vitest'

import { EVENT_HUES, EVENT_TYPE_HUES, eventTypeChipVars } from './event-type-colors'
import { AA_SMALL_TEXT, THEMES, contrastRatio, resolveColor } from '@tests/utils/contrast'

describe.each(THEMES)('calendar item hues in %s', (theme) => {
  const ink = resolveColor(theme, '--cal-ink')

  it.each(EVENT_HUES)('keeps the %s chip title at AA on its surface', (hue) => {
    const surface = resolveColor(theme, `--cal-${hue}-surface`)
    expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it.each(EVENT_HUES)('keeps the %s chip time at AA on its surface', (hue) => {
    const surface = resolveColor(theme, `--cal-${hue}-surface`)
    const meta = resolveColor(theme, `--cal-${hue}-meta`)
    expect(contrastRatio(meta, surface)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })

  it.each(EVENT_HUES)('keeps the selected %s chip title at AA', (hue) => {
    const solid = resolveColor(theme, `--cal-${hue}-solid`)
    const solidInk = resolveColor(theme, `--cal-${hue}-solid-ink`)
    expect(contrastRatio(solidInk, solid)).toBeGreaterThanOrEqual(AA_SMALL_TEXT)
  })
})

describe('eventTypeChipVars', () => {
  it('points every chip variable at the item type hue', () => {
    expect(eventTypeChipVars('task')).toEqual({
      '--chip-rail': 'var(--cal-green-rail)',
      '--chip-surface': 'var(--cal-green-surface)',
      '--chip-meta': 'var(--cal-green-meta)',
      '--chip-solid': 'var(--cal-green-solid)',
      '--chip-solid-ink': 'var(--cal-green-solid-ink)'
    })
  })

  it('gives each item type its own hue, except a note date which shares the note hue', () => {
    const { note_date: noteDateHue, ...rest } = EVENT_TYPE_HUES
    expect(noteDateHue).toBe(rest.note)
    expect(new Set(Object.values(rest)).size).toBe(Object.keys(rest).length)
  })
})
