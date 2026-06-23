import { describe, it, expect } from 'vitest'
import { rruleToRepeatConfig } from './rrule'

const NOW = '2026-06-15T00:00:00.000Z'

describe('rruleToRepeatConfig', () => {
  it('maps yearly', () => {
    expect(rruleToRepeatConfig('FREQ=YEARLY;INTERVAL=1', NOW)).toMatchObject({
      frequency: 'yearly',
      interval: 1,
      endType: 'never',
      completedCount: 0,
      createdAt: NOW
    })
  })
  it('maps monthly day-of-month', () => {
    expect(rruleToRepeatConfig('FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15', NOW)).toMatchObject({
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: 15
    })
  })
  it('maps weekly BYDAY to daysOfWeek', () => {
    expect(rruleToRepeatConfig('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', NOW)).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3, 5]
    })
  })
  it('maps COUNT and UNTIL endings', () => {
    expect(rruleToRepeatConfig('FREQ=DAILY;COUNT=10', NOW)).toMatchObject({
      endType: 'count',
      endCount: 10
    })
    expect(rruleToRepeatConfig('FREQ=DAILY;UNTIL=20261231T000000Z', NOW)).toMatchObject({
      endType: 'date',
      endDate: '2026-12-31'
    })
  })
  it('returns null for empty or unsupported frequency', () => {
    expect(rruleToRepeatConfig('', NOW)).toBeNull()
    expect(rruleToRepeatConfig('FREQ=HOURLY', NOW)).toBeNull()
  })
})
