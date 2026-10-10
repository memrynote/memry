import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect } from 'vitest'
import { formatDate, parseDateInput, type DateFormat } from './format-date'
import { runInTz } from './test-support/run-in-tz'

const FORMATS: DateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY']
const d = new Date(2026, 6, 2) // Jul 2 2026 (local)

describe('formatDate', () => {
  it('renders each style', () => {
    expect(formatDate(d, 'MM/DD/YYYY')).toBe('07/02/2026')
    expect(formatDate(d, 'DD/MM/YYYY')).toBe('02/07/2026')
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-07-02')
    expect(formatDate(d, 'DD.MM.YYYY')).toBe('02.07.2026')
  })

  // Regression: an unparseable date property reaches the note tab as
  // `new Date('...')` (Invalid Date). date-fns format() throws RangeError on it,
  // which escaped into render and crashed the whole tab via the error boundary.
  it('returns empty string instead of throwing on an invalid date', () => {
    expect(() => formatDate(new Date('not a date'), 'DD.MM.YYYY')).not.toThrow()
    expect(formatDate(new Date('not a date'), 'DD.MM.YYYY')).toBe('')
    expect(formatDate(new Date(NaN))).toBe('')
  })
})

describe('parseDateInput', () => {
  it('round-trips a formatted value for every style', () => {
    for (const f of FORMATS) {
      const parsed = parseDateInput(formatDate(d, f), f)
      expect(parsed, f).not.toBeNull()
      expect(formatDate(parsed as Date, f)).toBe(formatDate(d, f))
    }
  })

  it('rejects malformed, out-of-range, and wrong-separator input', () => {
    expect(parseDateInput('not a date', 'MM/DD/YYYY')).toBeNull()
    expect(parseDateInput('13/40/2026', 'MM/DD/YYYY')).toBeNull()
    expect(parseDateInput('2026/07/02', 'YYYY-MM-DD')).toBeNull()
    expect(parseDateInput('', 'DD.MM.YYYY')).toBeNull()
  })
})

describe('formatDateValue', () => {
  const MODULE_URL = pathToFileURL(
    resolve(dirname(expect.getState().testPath!), 'format-date.ts')
  ).href
  const formatInTz = (tz: string, value: string): string =>
    runInTz(
      tz,
      `const { formatDateValue } = await import(${JSON.stringify(MODULE_URL)})
       process.stdout.write(JSON.stringify(formatDateValue(${JSON.stringify(value)}, 'DD.MM.YYYY')))`
    )

  it.each(['UTC', 'Europe/Istanbul', 'America/Los_Angeles', 'Pacific/Kiritimati'])(
    'shows a date-only value as its calendar day with no time in %s',
    (tz) => {
      expect(formatInTz(tz, '2026-10-13')).toBe('13.10.2026')
    }
  )

  it('keeps the time for a timestamp', () => {
    expect(formatInTz('Europe/Istanbul', '2026-10-13T09:30:00.000Z')).toBe('13.10.2026 - 12:30:00')
  })

  it('shows an unparseable value as written', () => {
    expect(formatInTz('UTC', 'next week')).toBe('next week')
  })
})
