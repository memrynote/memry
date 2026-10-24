import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  resolveJournalTemplateId,
  orderedWeekdays,
  weekdayLabel
} from './journal-template-resolution'
import { runInTz } from './test-support/run-in-tz'

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
    // resolveJournalTemplateId's only timezone-sensitive step is parseISODate, which builds the
    // Date from the string's Y/M/D parts rather than parsing it as UTC — so the weekday it reads
    // back is the same in every zone by construction. Assigning `process.env.TZ` and calling
    // resolveJournalTemplateId in-process (the previous version of this test) could not have
    // caught a regression to `new Date(isoDate)` even with a working TZ knob, because the
    // renderer project runs on vitest's `threads` pool, where `process.env` is a per-worker copy
    // and assigning `TZ` never reaches the C++ `tzset` that would move the clock. So this proves
    // the invariant for real, in a child `node` with a real `TZ`, on the exact date where a UTC
    // parse would disagree with a local one (2026-08-17 00:00 UTC is 2026-08-16 in any
    // negative-offset zone).
    const MODULE_URL = pathToFileURL(
      resolve(dirname(expect.getState().testPath!), 'journal-utils.ts')
    ).href

    function localWeekdayIn(tz: string, isoDate: string): number {
      const source = `
        const { parseISODate } = await import(${JSON.stringify(MODULE_URL)})
        process.stdout.write(JSON.stringify(parseISODate(${JSON.stringify(isoDate)}).getDay()))
      `
      return runInTz(tz, source)
    }

    it.each(['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati'])(
      'reads 2026-08-17 as Monday in %s',
      (tz) => {
        expect(localWeekdayIn(tz, '2026-08-17')).toBe(1)
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
