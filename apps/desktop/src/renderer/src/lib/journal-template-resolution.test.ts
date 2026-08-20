import { describe, it, expect, afterEach } from 'vitest'
import {
  resolveJournalTemplateId,
  orderedWeekdays,
  weekdayLabel
} from './journal-template-resolution'

describe('resolveJournalTemplateId', () => {
  it('prefers the weekday override over the default', () => {
    // 2026-08-17 is a Monday (getDay() === 1).
    expect(
      resolveJournalTemplateId(
        { defaultTemplate: 'morning-pages', weekdayTemplates: { '1': 'daily-standup' } },
        '2026-08-17'
      )
    ).toBe('daily-standup')
  })

  it('falls back to the default for a day with no entry', () => {
    expect(
      resolveJournalTemplateId(
        { defaultTemplate: 'morning-pages', weekdayTemplates: { '1': 'daily-standup' } },
        '2026-08-18'
      )
    ).toBe('morning-pages')
  })

  it('treats an explicit null day as cleared, falling back to the default', () => {
    expect(
      resolveJournalTemplateId(
        { defaultTemplate: 'morning-pages', weekdayTemplates: { '1': null } },
        '2026-08-17'
      )
    ).toBe('morning-pages')
  })

  it('returns null when neither the day nor the default is set', () => {
    expect(
      resolveJournalTemplateId({ defaultTemplate: null, weekdayTemplates: {} }, '2026-08-17')
    ).toBeNull()
  })

  it('tolerates settings written before weekday templates existed', () => {
    expect(resolveJournalTemplateId({ defaultTemplate: 'morning-pages' }, '2026-08-17')).toBe(
      'morning-pages'
    )
  })

  describe('timezone', () => {
    const originalTZ = process.env.TZ

    afterEach(() => {
      process.env.TZ = originalTZ
    })

    // `new Date('2026-08-17')` is UTC midnight, which in any negative-offset zone
    // reads back as Sunday the 16th — Monday would open with Sunday's template.
    it.each(['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'])(
      'resolves the local weekday in %s',
      (tz) => {
        process.env.TZ = tz
        expect(
          resolveJournalTemplateId(
            {
              defaultTemplate: null,
              weekdayTemplates: { '0': 'sunday-tpl', '1': 'monday-tpl' }
            },
            '2026-08-17'
          )
        ).toBe('monday-tpl')
      }
    )
  })
})

describe('orderedWeekdays', () => {
  it('starts on Sunday when the preference is 0', () => {
    expect(orderedWeekdays(0)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('starts on Monday when the preference is 1', () => {
    expect(orderedWeekdays(1)).toEqual([1, 2, 3, 4, 5, 6, 0])
  })

  it('reorders without renaming: the same key is the same day either way', () => {
    // The guard against a positional model. Flipping the first-day-of-week
    // preference must move rows around, never move a template onto another day.
    const settings = { defaultTemplate: null, weekdayTemplates: { '1': 'monday-tpl' } }
    for (const weekStartsOn of [0, 1] as const) {
      expect(orderedWeekdays(weekStartsOn)).toContain(1)
      expect(resolveJournalTemplateId(settings, '2026-08-17')).toBe('monday-tpl')
    }
  })
})

describe('weekdayLabel', () => {
  it('names absolute weekdays from the locale', () => {
    expect(weekdayLabel(0, 'en-US')).toBe('Sunday')
    expect(weekdayLabel(1, 'en-US')).toBe('Monday')
    expect(weekdayLabel(6, 'en-US')).toBe('Saturday')
  })

  it('localizes without translation keys', () => {
    expect(weekdayLabel(1, 'tr')).toBe('Pazartesi')
  })
})
