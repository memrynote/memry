import { describe, expect, it } from 'vitest'

import {
  CALENDAR_COLORS,
  CALENDAR_EVENT_COLORS,
  CalendarEventColorSchema,
  calendarColorHex,
  calendarDisplayHex,
  calendarEventColorFromColorId,
  colorIdForCalendarEventColor
} from './calendar-colors'

describe('calendar colours', () => {
  it('offers the 24 Google calendar colours in calendar colour id order', () => {
    expect(CALENDAR_COLORS).toEqual([
      'cocoa',
      'flamingo',
      'tomato',
      'tangerine',
      'pumpkin',
      'mango',
      'eucalyptus',
      'basil',
      'pistachio',
      'avocado',
      'citron',
      'banana',
      'sage',
      'peacock',
      'cobalt',
      'blueberry',
      'lavender',
      'wisteria',
      'graphite',
      'birch',
      'radicchio',
      'cherry-blossom',
      'grape',
      'amethyst'
    ])
  })

  it('reads every Google event colour id as its own colour', () => {
    const read = Array.from({ length: 11 }, (_, i) => calendarEventColorFromColorId(String(i + 1)))

    expect(read).toEqual([
      'lavender',
      'sage',
      'grape',
      'flamingo',
      'banana',
      'tangerine',
      'peacock',
      'graphite',
      'blueberry',
      'basil',
      'tomato'
    ])
  })

  it('writes back the id of every event colour it reads', () => {
    for (let id = 1; id <= 11; id++) {
      expect(colorIdForCalendarEventColor(calendarEventColorFromColorId(String(id)))).toBe(
        String(id)
      )
    }
    expect(colorIdForCalendarEventColor(null)).toBeNull()
  })

  it('reads a missing or unknown event colour id as no colour', () => {
    expect(calendarEventColorFromColorId(null)).toBeNull()
    expect(calendarEventColorFromColorId('')).toBeNull()
    expect(calendarEventColorFromColorId('12')).toBeNull()
    expect(calendarEventColorFromColorId('__proto__')).toBeNull()
  })

  it('draws event colours from the calendar palette', () => {
    for (const color of CALENDAR_EVENT_COLORS) {
      expect(CALENDAR_COLORS).toContain(color)
    }
    expect(calendarColorHex('tomato')).toBe('#d50000')
    expect(calendarColorHex('graphite')).toBe('#616161')
  })

  it('shows a calendar colour the API reports in its 2012 hex as the current hex', () => {
    expect(calendarDisplayHex('#ac725e')).toBe('#795548')
    expect(calendarDisplayHex('#9FC6E7')).toBe('#4285f4')
    expect(calendarDisplayHex('#a47ae2')).toBe('#9e69af')
  })

  it('shows a custom calendar colour as itself and junk as no colour', () => {
    expect(calendarDisplayHex('#123ABC')).toBe('#123abc')
    expect(calendarDisplayHex(null)).toBeNull()
    expect(calendarDisplayHex('')).toBeNull()
    expect(calendarDisplayHex('red')).toBeNull()
    expect(calendarDisplayHex('#fff')).toBeNull()
  })

  it('accepts event colour names and rejects anything else', () => {
    expect(CalendarEventColorSchema.safeParse('peacock').success).toBe(true)
    expect(CalendarEventColorSchema.safeParse('cobalt').success).toBe(false)
    expect(CalendarEventColorSchema.safeParse('11').success).toBe(false)
    expect(CalendarEventColorSchema.safeParse('#ff0000').success).toBe(false)
  })
})
