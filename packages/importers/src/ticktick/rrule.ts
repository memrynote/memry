import type { RepeatConfig } from './types'

const FREQ: Record<string, RepeatConfig['frequency']> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly'
}
const DAY: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

function untilToDate(until: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(until.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

function dayToken(token: string): number | undefined {
  return DAY[token.replace(/^[+-]?\d+/, '').toUpperCase()]
}

/** Convert a TickTick RRULE string to Memry RepeatConfig, or null if unsupported. */
export function rruleToRepeatConfig(rrule: string, now: string): RepeatConfig | null {
  const body = rrule.trim().replace(/^RRULE:/i, '')
  if (!body) return null
  const parts: Record<string, string> = {}
  for (const kv of body.split(';')) {
    const [k, v] = kv.split('=')
    if (k) parts[k.toUpperCase()] = v ?? ''
  }
  const frequency = FREQ[(parts.FREQ ?? '').toUpperCase()]
  if (!frequency) return null

  const cfg: RepeatConfig = {
    frequency,
    interval: Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1),
    endType: 'never',
    completedCount: 0,
    createdAt: now
  }

  if (parts.BYDAY && frequency === 'weekly') {
    cfg.daysOfWeek = parts.BYDAY.split(',')
      .map(dayToken)
      .filter((n): n is number => n !== undefined)
  }
  if (parts.BYMONTHDAY && frequency === 'monthly') {
    cfg.monthlyType = 'dayOfMonth'
    cfg.dayOfMonth = parseInt(parts.BYMONTHDAY, 10)
  } else if (parts.BYDAY && parts.BYSETPOS && frequency === 'monthly') {
    cfg.monthlyType = 'weekPattern'
    cfg.weekOfMonth = parseInt(parts.BYSETPOS, 10)
    cfg.dayOfWeekForMonth = dayToken(parts.BYDAY)
  }

  if (parts.COUNT) {
    cfg.endType = 'count'
    cfg.endCount = parseInt(parts.COUNT, 10)
  } else if (parts.UNTIL) {
    const endDate = untilToDate(parts.UNTIL)
    if (endDate) {
      cfg.endType = 'date'
      cfg.endDate = endDate
    }
  }
  return cfg
}
