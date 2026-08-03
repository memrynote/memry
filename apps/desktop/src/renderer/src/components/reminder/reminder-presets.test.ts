import i18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  formatRelativeTime,
  formatReminderDate,
  getInDays,
  getInMonths,
  getInWeeks,
  getLaterToday,
  getNextMonday,
  getNextOccurrenceOfHour,
  getNextWeekend,
  getReminderTimeLabel,
  getTomorrow,
  isOverdue,
  journalPresets,
  type ReminderPreset,
  snoozePresets,
  standardPresets
} from './reminder-presets'

describe('reminder-presets', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 6, 10, 30, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes next preset dates from the current local day', () => {
    expect(getNextOccurrenceOfHour(16, new Date(2026, 4, 6, 10, 45))).toMatchObject({
      getHours: expect.any(Function)
    })
    expect(getNextOccurrenceOfHour(16, new Date(2026, 4, 6, 10, 45)).getDate()).toBe(6)
    expect(getNextOccurrenceOfHour(16, new Date(2026, 4, 6, 16, 5)).getDate()).toBe(7)
    expect(getTomorrow().getDate()).toBe(7)
    expect(getTomorrow(14).getHours()).toBe(14)
    expect(getNextMonday().getDay()).toBe(1)
    expect(getNextWeekend().getDay()).toBe(6)
    expect(getInDays(3, 11).getDate()).toBe(9)
    expect(getInWeeks(2, 12).getDate()).toBe(20)
    expect(getInMonths(1, 13).getMonth()).toBe(5)
  })

  it('handles later-today branches and exposes preset collections', () => {
    expect(getLaterToday().getHours()).toBe(14)

    vi.setSystemTime(new Date(2026, 4, 6, 18, 5, 0, 0))
    expect(getLaterToday().getHours()).toBe(20)
    expect(getLaterToday().getDate()).toBe(6)

    vi.setSystemTime(new Date(2026, 4, 6, 21, 5, 0, 0))
    expect(getLaterToday().getHours()).toBe(9)
    expect(getLaterToday().getDate()).toBe(7)

    expect(standardPresets.map((preset) => preset.id)).toEqual([
      'later-today',
      'tomorrow',
      'next-week',
      'in-one-month'
    ])
    expect(journalPresets.at(-1)?.getDate().getFullYear()).toBe(2027)
    expect(snoozePresets[0].getDate().getMinutes()).toBe(20)
  })

  it('formats absolute and relative reminder labels', () => {
    expect(formatReminderDate(new Date(2026, 4, 6, 14, 0))).toBe('Today at 2:00 PM')
    expect(formatReminderDate(new Date(2026, 4, 7, 9, 30), '24h')).toBe('Tomorrow at 09:30')
    expect(formatReminderDate(new Date(2026, 4, 9, 8, 0))).toBe('Saturday at 8:00 AM')
    expect(formatReminderDate(new Date(2026, 5, 20, 8, 0))).toBe('Jun 20 at 8:00 AM')
    expect(formatReminderDate(new Date(2027, 0, 2, 8, 0))).toBe('Jan 2, 2027 at 8:00 AM')

    expect(formatRelativeTime(new Date(2026, 4, 6, 10, 29))).toBe('overdue')
    expect(formatRelativeTime(new Date(2026, 4, 6, 10, 31))).toBe('in 1 minute')
    expect(formatRelativeTime(new Date(2026, 4, 6, 12, 30))).toBe('in 2 hours')
    expect(formatRelativeTime(new Date(2026, 4, 8, 10, 30))).toBe('in 2 days')
    expect(formatRelativeTime(new Date(2026, 4, 20, 10, 30))).toBe('in 2 weeks')
    expect(formatRelativeTime(new Date(2026, 7, 6, 10, 30))).toBe('in 3 months')
    expect(formatRelativeTime(new Date(2027, 5, 6, 10, 30))).toBe('in 1 year')
    expect(isOverdue(new Date(2026, 4, 6, 10, 29))).toBe(true)
    expect(isOverdue(new Date(2026, 4, 6, 10, 31).toISOString())).toBe(false)
    expect(getReminderTimeLabel(new Date(2026, 4, 6, 10, 29))).toBe('Overdue')
    expect(getReminderTimeLabel(new Date(2026, 4, 6, 10, 31))).toBe('in 1 minute')
  })

  it('formats compact reminder labels for tight surfaces', () => {
    expect(formatReminderDate(new Date(2026, 4, 6, 14, 0), '12h', true)).toBe('Today, 2:00 PM')
    expect(formatReminderDate(new Date(2026, 4, 7, 9, 30), '24h', true)).toBe('Tomorrow, 09:30')
    expect(formatReminderDate(new Date(2026, 4, 9, 8, 0), '12h', true)).toBe('Sat, 8:00 AM')
    expect(formatReminderDate(new Date(2026, 5, 20, 8, 0), '12h', true)).toBe('Jun 20, 8:00 AM')
    expect(formatReminderDate(new Date(2027, 0, 2, 8, 0), '12h', true)).toBe('Jan 2, 2027, 8:00 AM')
  })
})

// ============================================================================
// Preset labels + the time each preset actually promises
// ============================================================================

interface TranslateCall {
  ns: string
  key: string
  options?: Record<string, unknown>
}

interface PresetExpectation {
  id: string
  labelKey: string
  labelOptions?: Record<string, unknown>
  label: string
  descriptionKey?: string
  descriptionOptions?: Record<string, unknown>
  description?: string
  date: Date
}

// Wednesday 2026-05-06 10:30 local. Mid-week and mid-day so "next Monday",
// "next Saturday" and "+4 hours" all stay inside their own week/day.
const BASE_NOW = new Date(2026, 4, 6, 10, 30, 0, 0)

const STANDARD_EXPECTATIONS: PresetExpectation[] = [
  {
    id: 'later-today',
    labelKey: 'reminder.presets.laterToday.label',
    label: 'Later Today',
    descriptionKey: 'reminder.presets.laterToday.description',
    descriptionOptions: { count: 4 },
    description: 'In 4 hours',
    date: new Date(2026, 4, 6, 14, 0, 0, 0)
  },
  {
    id: 'tomorrow',
    labelKey: 'reminder.presets.tomorrow.label',
    label: 'Tomorrow',
    descriptionKey: 'reminder.presets.tomorrow.description',
    description: 'Tomorrow at 9 AM',
    date: new Date(2026, 4, 7, 9, 0, 0, 0)
  },
  {
    id: 'next-week',
    labelKey: 'reminder.presets.nextWeek.label',
    label: 'Next Week',
    descriptionKey: 'reminder.presets.nextWeek.description',
    description: 'Monday at 9 AM',
    date: new Date(2026, 4, 11, 9, 0, 0, 0)
  },
  {
    id: 'in-one-month',
    labelKey: 'reminder.presets.inMonths.label',
    labelOptions: { count: 1 },
    label: 'In 1 Month',
    descriptionKey: 'reminder.presets.sameDayNextMonth',
    description: 'Same day next month',
    date: new Date(2026, 5, 6, 9, 0, 0, 0)
  }
]

const JOURNAL_EXPECTATIONS: PresetExpectation[] = [
  {
    id: 'in-one-week',
    labelKey: 'reminder.presets.inWeeks.label',
    labelOptions: { count: 1 },
    label: 'In 1 Week',
    descriptionKey: 'reminder.presets.reviewInAWeek',
    description: 'Review in a week',
    date: new Date(2026, 4, 13, 9, 0, 0, 0)
  },
  {
    id: 'in-one-month',
    labelKey: 'reminder.presets.inMonths.label',
    labelOptions: { count: 1 },
    label: 'In 1 Month',
    descriptionKey: 'reminder.presets.monthlyReflection',
    description: 'Monthly reflection',
    date: new Date(2026, 5, 6, 9, 0, 0, 0)
  },
  {
    id: 'in-three-months',
    labelKey: 'reminder.presets.inMonths.label',
    labelOptions: { count: 3 },
    label: 'In 3 Months',
    descriptionKey: 'reminder.presets.quarterlyReflection',
    description: 'Quarterly reflection',
    date: new Date(2026, 7, 6, 9, 0, 0, 0)
  },
  {
    id: 'in-one-year',
    labelKey: 'reminder.presets.inYears.label',
    labelOptions: { count: 1 },
    label: 'In 1 Year',
    descriptionKey: 'reminder.presets.anniversaryReminder',
    description: 'Anniversary reminder',
    date: new Date(2027, 4, 6, 9, 0, 0, 0)
  }
]

const SNOOZE_EXPECTATIONS: PresetExpectation[] = [
  {
    id: 'in-15-min',
    labelKey: 'reminder.presets.inMinutes.label',
    labelOptions: { count: 15 },
    label: 'In 15 Minutes',
    date: new Date(2026, 4, 6, 10, 45, 0, 0)
  },
  {
    id: 'in-1-hour',
    labelKey: 'reminder.presets.inHours.label',
    labelOptions: { count: 1 },
    label: 'In 1 Hour',
    date: new Date(2026, 4, 6, 11, 30, 0, 0)
  },
  {
    id: 'in-3-hours',
    labelKey: 'reminder.presets.inHours.label',
    labelOptions: { count: 3 },
    label: 'In 3 Hours',
    date: new Date(2026, 4, 6, 13, 30, 0, 0)
  },
  {
    id: 'tomorrow-morning',
    labelKey: 'reminder.presets.tomorrowMorning',
    label: 'Tomorrow Morning',
    date: new Date(2026, 4, 7, 9, 0, 0, 0)
  }
]

describe('reminder preset labels and offsets', () => {
  const originalGetFixedT = i18next.getFixedT
  let calls: TranslateCall[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE_NOW)

    // Wrap the shared i18next instance so every preset getter records the key +
    // interpolation options it asked for, while still returning the real
    // translation. Lets one assertion pin both the key and what it renders to.
    calls = []
    const realGetFixedT = originalGetFixedT.bind(i18next) as (
      lng: string | null,
      ns: string,
      keyPrefix?: string
    ) => (key: string, options?: Record<string, unknown>) => string

    i18next.getFixedT = ((lng: string | null, ns: string, keyPrefix?: string) => {
      const t = realGetFixedT(lng, ns, keyPrefix)
      return (key: string, options?: Record<string, unknown>) => {
        calls.push({ ns, key, options })
        return t(key, options)
      }
    }) as unknown as typeof i18next.getFixedT
  })

  afterEach(() => {
    i18next.getFixedT = originalGetFixedT
    vi.useRealTimers()
  })

  function assertPresets(presets: ReminderPreset[], expectations: PresetExpectation[]): void {
    expect(presets.map((preset) => preset.id)).toEqual(expectations.map((entry) => entry.id))

    expectations.forEach((expected, index) => {
      const preset = presets[index]

      calls.length = 0
      expect(preset.label).toBe(expected.label)
      expect(calls).toEqual([
        { ns: 'inbox', key: expected.labelKey, options: expected.labelOptions }
      ])

      calls.length = 0
      expect(preset.description).toBe(expected.description)
      expect(calls).toEqual(
        expected.descriptionKey
          ? [{ ns: 'inbox', key: expected.descriptionKey, options: expected.descriptionOptions }]
          : []
      )

      expect(preset.getDate()).toEqual(expected.date)
    })
  }

  it('resolves standard preset labels and lands on the promised time', () => {
    assertPresets(standardPresets, STANDARD_EXPECTATIONS)
  })

  it('resolves journal preset labels and lands on the promised time', () => {
    assertPresets(journalPresets, JOURNAL_EXPECTATIONS)
  })

  it('resolves snooze preset labels and lands on the promised time', () => {
    assertPresets(snoozePresets, SNOOZE_EXPECTATIONS)
  })

  it('offsets snooze presets from the moment they are read, not from import time', () => {
    vi.setSystemTime(new Date(2026, 4, 6, 23, 50, 0, 0))

    expect(snoozePresets[0].getDate()).toEqual(new Date(2026, 4, 7, 0, 5, 0, 0))
    expect(snoozePresets[1].getDate()).toEqual(new Date(2026, 4, 7, 0, 50, 0, 0))
    expect(snoozePresets[2].getDate()).toEqual(new Date(2026, 4, 7, 2, 50, 0, 0))
    expect(snoozePresets[3].getDate()).toEqual(new Date(2026, 4, 7, 9, 0, 0, 0))
  })

  it('keeps the singular and plural forms of a count label apart', () => {
    // The one/other split is the thing an ICU message can silently get wrong,
    // so pin both arms of the same key.
    const [, , inThreeMonths] = journalPresets
    const [, inOneHour, inThreeHours] = snoozePresets

    expect(journalPresets[1].label).toBe('In 1 Month')
    expect(inThreeMonths.label).toBe('In 3 Months')
    expect(inOneHour.label).toBe('In 1 Hour')
    expect(inThreeHours.label).toBe('In 3 Hours')
  })
})

describe('reminder preset labels follow the active language', () => {
  afterEach(async () => {
    await i18next.changeLanguage('en')
  })

  it('re-reads every label from the language active at read time', async () => {
    expect(standardPresets[0].label).toBe('Later Today')
    expect(snoozePresets[0].label).toBe('In 15 Minutes')

    await i18next.changeLanguage('de')

    // Same getters, no re-import: the labels must follow the switch.
    expect(standardPresets[0].label).toBe('Später heute')
    expect(standardPresets[0].description).toBe('In 4 Stunden')
    expect(snoozePresets[0].label).toBe('In 15 Minuten')
    expect(snoozePresets[1].label).toBe('In 1 Stunde')
    expect(snoozePresets[2].label).toBe('In 3 Stunden')
    expect(snoozePresets[3].label).toBe('Morgen früh')
    expect(journalPresets[3].label).toBe('In 1 Jahr')
  })
})
