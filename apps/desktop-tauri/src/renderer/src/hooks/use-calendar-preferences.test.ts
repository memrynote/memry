import { describe, it, expect } from 'vitest'
import { resolveDayCellClickBehavior } from './use-calendar-preferences'
import type { CalendarSettings } from '@memry/contracts/settings-schemas'

const make = (overrides: Partial<CalendarSettings> = {}): CalendarSettings => ({
  dayCellClickBehavior: 'journal',
  calendarPageClickOverride: 'calendar',
  ...overrides
})

describe('resolveDayCellClickBehavior', () => {
  describe('non-calendar tab', () => {
    it('uses global journal', () => {
      const s = make({ dayCellClickBehavior: 'journal' })
      expect(resolveDayCellClickBehavior(s, false)).toBe('journal')
    })

    it('uses global calendar', () => {
      const s = make({ dayCellClickBehavior: 'calendar' })
      expect(resolveDayCellClickBehavior(s, false)).toBe('calendar')
    })

    it('ignores the calendar-page override', () => {
      const s = make({ dayCellClickBehavior: 'journal', calendarPageClickOverride: 'calendar' })
      expect(resolveDayCellClickBehavior(s, false)).toBe('journal')
    })
  })

  describe('calendar tab', () => {
    it('override=calendar wins over global=journal', () => {
      const s = make({ dayCellClickBehavior: 'journal', calendarPageClickOverride: 'calendar' })
      expect(resolveDayCellClickBehavior(s, true)).toBe('calendar')
    })

    it('override=journal wins over global=calendar', () => {
      const s = make({ dayCellClickBehavior: 'calendar', calendarPageClickOverride: 'journal' })
      expect(resolveDayCellClickBehavior(s, true)).toBe('journal')
    })

    it('override=inherit falls through to global=journal', () => {
      const s = make({ dayCellClickBehavior: 'journal', calendarPageClickOverride: 'inherit' })
      expect(resolveDayCellClickBehavior(s, true)).toBe('journal')
    })

    it('override=inherit falls through to global=calendar', () => {
      const s = make({ dayCellClickBehavior: 'calendar', calendarPageClickOverride: 'inherit' })
      expect(resolveDayCellClickBehavior(s, true)).toBe('calendar')
    })
  })
})
