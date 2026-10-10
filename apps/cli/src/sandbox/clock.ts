// Every sandbox date is relative to the moment of generation, so today's tasks,
// the journal streak and next week's events stay current whenever it runs.
// Days are local calendar days, the way desktop shows due dates and journal days.

export interface Clock {
  now: Date
  timezone: string
  /** Local calendar day `offset` days from today, as `YYYY-MM-DD`. */
  date(offset: number): string
  /** Local wall time `hhmm` on that day, as an ISO instant. */
  at(offset: number, hhmm: string): string
  /** Instant `days` days before now, at local `hhmm`. */
  ago(days: number, hhmm?: string): string
  /** Day of week for that day, 0 = Sunday. */
  weekday(offset: number): number
  /** Offsets of the weekdays (Mon-Fri) in [from, to], ascending. */
  workdays(from: number, to: number): number[]
}

function localDay(now: Date, offset: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function createClock(now: Date): Clock {
  const clock: Clock = {
    now,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    date(offset) {
      const day = localDay(now, offset)
      return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`
    },
    at(offset, hhmm) {
      const [hours, minutes] = hhmm.split(':').map(Number)
      const day = localDay(now, offset)
      day.setHours(hours, minutes, 0, 0)
      return day.toISOString()
    },
    ago(days, hhmm = '10:00') {
      return clock.at(-days, hhmm)
    },
    weekday(offset) {
      return localDay(now, offset).getDay()
    },
    workdays(from, to) {
      const days: number[] = []
      for (let offset = from; offset <= to; offset++) {
        const weekday = clock.weekday(offset)
        if (weekday !== 0 && weekday !== 6) days.push(offset)
      }
      return days
    }
  }
  return clock
}
