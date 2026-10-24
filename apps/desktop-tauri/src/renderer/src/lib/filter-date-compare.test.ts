import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runInTz } from './test-support/run-in-tz'

// The renderer project cannot move its own clock (see run-in-tz.ts), so the zone-dependent
// comparison runs in a child `node` with a real TZ.
const MODULE_URL = pathToFileURL(
  resolve(dirname(expect.getState().testPath!), 'filter-date-compare.ts')
).href

/** Sign of compareDates(stored, picked) where picked is the date picker's value for `day`. */
function compareInTz(tz: string, stored: string, day: [number, number, number]): number {
  const source = `
    const { compareDates } = await import(${JSON.stringify(MODULE_URL)})
    const picked = new Date(${day.join(', ')}).toISOString()
    process.stdout.write(JSON.stringify(Math.sign(compareDates(${JSON.stringify(stored)}, picked))))
  `
  return runInTz(tz, source)
}

describe('compareDates with a date-only value', () => {
  it.each(['UTC', 'Europe/Istanbul', 'America/Los_Angeles', 'Pacific/Kiritimati'])(
    'compares calendar days in %s',
    (tz) => {
      expect(compareInTz(tz, '2026-10-07', [2026, 9, 7])).toBe(0)
      expect(compareInTz(tz, '2026-10-07', [2026, 9, 6])).toBe(1)
      expect(compareInTz(tz, '2026-10-07', [2026, 9, 8])).toBe(-1)
    }
  )
})

describe('the date picker value', () => {
  it.each(['UTC', 'Europe/Istanbul', 'America/Los_Angeles', 'Pacific/Kiritimati'])(
    'stores the picked day as a plain date and shows it back as that day in %s',
    (tz) => {
      const source = `
        const { toPlainDay, parseFilterDay } = await import(${JSON.stringify(MODULE_URL)})
        const stored = toPlainDay(new Date(2026, 9, 7))
        const shown = parseFilterDay(stored)
        const legacy = parseFilterDay(new Date(2026, 9, 7).toISOString())
        process.stdout.write(JSON.stringify([stored, shown.getDate(), legacy.getDate()]))
      `
      expect(runInTz(tz, source)).toEqual(['2026-10-07', 7, 7])
    }
  )
})
