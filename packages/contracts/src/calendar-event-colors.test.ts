import { describe, expect, it } from 'vitest'

import {
  CALENDAR_EVENT_COLORS,
  CalendarEventColorSchema,
  calendarEventColorFromColorId,
  colorIdForCalendarEventColor
} from './calendar-event-colors'

describe('calendar event colours', () => {
  it('writes the Google colour id of the picked colour', () => {
    expect(colorIdForCalendarEventColor('red')).toBe('11')
    expect(colorIdForCalendarEventColor('gray')).toBe('8')
    expect(colorIdForCalendarEventColor(null)).toBeNull()
  })

  it('reads every Google colour id as a Memry colour', () => {
    const read = Array.from({ length: 11 }, (_, i) => calendarEventColorFromColorId(String(i + 1)))

    expect(read).toEqual([
      'purple',
      'green',
      'purple',
      'pink',
      'yellow',
      'orange',
      'blue',
      'gray',
      'blue',
      'green',
      'red'
    ])
  })

  it('reads a missing or unknown id as no colour', () => {
    expect(calendarEventColorFromColorId(null)).toBeNull()
    expect(calendarEventColorFromColorId('')).toBeNull()
    expect(calendarEventColorFromColorId('12')).toBeNull()
    expect(calendarEventColorFromColorId('__proto__')).toBeNull()
  })

  it('reads back every colour it writes', () => {
    for (const color of CALENDAR_EVENT_COLORS) {
      expect(calendarEventColorFromColorId(colorIdForCalendarEventColor(color))).toBe(color)
    }
  })

  it('accepts palette names and rejects anything else', () => {
    expect(CalendarEventColorSchema.safeParse('blue').success).toBe(true)
    expect(CalendarEventColorSchema.safeParse('11').success).toBe(false)
    expect(CalendarEventColorSchema.safeParse('#ff0000').success).toBe(false)
  })
})
