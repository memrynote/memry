import { getISOWeek } from 'date-fns'

export function getISOWeekNumber(date: Date): number {
  return getISOWeek(date)
}
