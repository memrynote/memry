import { describe, it, expect } from 'vitest'
import { createDateMentionContent, formatDateMentionLabel } from './date-mention'

// Wednesday. Local-time ISO (no trailing Z) keeps the calendar-day math
// stable regardless of the machine's timezone.
const now = new Date('2026-06-17T12:00:00')

describe('date-mention content', () => {
  it('builds inline content from token data', () => {
    const c = createDateMentionContent({
      anchorId: 'dm_1',
      dateISO: '2026-06-20T09:00:00.000Z',
      hasTime: true,
      remind: true,
      lead: '1h'
    })
    expect(c.type).toBe('dateMention')
    expect(c.props.anchorId).toBe('dm_1')
    expect(c.props.remind).toBe(true)
  })
})

describe('formatDateMentionLabel', () => {
  it('uses Today / Tomorrow / Yesterday', () => {
    expect(formatDateMentionLabel('2026-06-17T15:00:00', false, { now })).toBe('Today')
    expect(formatDateMentionLabel('2026-06-18T15:00:00', false, { now })).toBe('Tomorrow')
    expect(formatDateMentionLabel('2026-06-16T15:00:00', false, { now })).toBe('Yesterday')
  })

  it('labels later days this week as "This <Weekday>"', () => {
    // Fri 2026-06-19 — same week as Wed 06-17 (Monday start)
    expect(formatDateMentionLabel('2026-06-19T15:00:00', false, { now, weekStartsOn: 1 })).toBe(
      'This Friday'
    )
  })

  it('labels next-week days as "Next <Weekday>"', () => {
    // Mon 2026-06-22 — next week
    expect(formatDateMentionLabel('2026-06-22T15:00:00', false, { now, weekStartsOn: 1 })).toBe(
      'Next Monday'
    )
  })

  it('labels last-week days as "Last <Weekday>"', () => {
    // Fri 2026-06-12 — last week
    expect(formatDateMentionLabel('2026-06-12T15:00:00', false, { now, weekStartsOn: 1 })).toBe(
      'Last Friday'
    )
  })

  it('labels earlier-this-week past days as a bare weekday', () => {
    // Mon 2026-06-15 — this week but already passed (now is Wed)
    expect(formatDateMentionLabel('2026-06-15T15:00:00', false, { now, weekStartsOn: 1 })).toBe(
      'Monday'
    )
  })

  it('formats far dates as "D Mon, YYYY" with the year', () => {
    const far = new Date('2026-01-01T12:00:00')
    expect(formatDateMentionLabel('2026-06-24T12:00:00', false, { now: far })).toBe('24 Jun, 2026')
  })

  it('honors the week-start setting for the this/next boundary', () => {
    // Sun 2026-06-21: this week under Monday start, next week under Sunday start
    expect(formatDateMentionLabel('2026-06-21T15:00:00', false, { now, weekStartsOn: 1 })).toBe(
      'This Sunday'
    )
    expect(formatDateMentionLabel('2026-06-21T15:00:00', false, { now, weekStartsOn: 0 })).toBe(
      'Next Sunday'
    )
  })

  it('appends the time to every label when hasTime is set', () => {
    expect(formatDateMentionLabel('2026-06-17T12:00:00', true, { now, clockFormat: '24h' })).toBe(
      'Today 12:00'
    )
    expect(
      formatDateMentionLabel('2026-06-19T12:00:00', true, {
        now,
        weekStartsOn: 1,
        clockFormat: '24h'
      })
    ).toBe('This Friday 12:00')
  })

  it('honors the clock-format setting', () => {
    const far = new Date('2026-01-01T12:00:00')
    expect(
      formatDateMentionLabel('2026-06-24T12:00:00', true, { now: far, clockFormat: '24h' })
    ).toBe('24 Jun, 2026 12:00')
    expect(
      formatDateMentionLabel('2026-06-24T12:00:00', true, { now: far, clockFormat: '12h' })
    ).toBe('24 Jun, 2026 12:00 PM')
  })

  it('falls back to OS-locale time when no clock format is given', () => {
    const label = formatDateMentionLabel('2026-06-18T09:30:00', true, { now })
    expect(label).toMatch(/^Tomorrow /)
    expect(label).toMatch(/:/)
  })
})
