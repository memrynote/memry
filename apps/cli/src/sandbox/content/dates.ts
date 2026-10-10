import type { Clock } from '../clock.ts'

/** Offset of the most recent Monday strictly before today. */
export const lastMonday = (clock: Clock): number => -((clock.weekday(0) + 6) % 7 || 7)

/** First workday at or after `offset`. */
export const workdayFrom = (clock: Clock, offset: number): number =>
  clock.workdays(offset, offset + 6)[0]

/** The Aurora design review: the first workday two or more days out. */
export const reviewDay = (clock: Clock): number => workdayFrom(clock, 2)

/** Aurora 1.0 launch day, about five weeks out. */
export const launchDay = (clock: Clock): number => workdayFrom(clock, 35)
