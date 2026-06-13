import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { findActiveDateQuery, resolveTabAction } from './date-mention-ghost'

// Fixed clock: Wednesday 2026-06-17. "today's weekday" is Wednesday. Fake timers
// keep buildDateSuggestions/parseNaturalDate (which read the real clock) aligned
// with the `now` we pass to the prediction helpers.
const now = new Date('2026-06-17T12:00:00')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('findActiveDateQuery', () => {
  it('returns null when there is no @', () => {
    expect(findActiveDateQuery('hello world', now)).toBeNull()
  })

  it('detects a bare @ with an empty query (defaults to Today)', () => {
    expect(findActiveDateQuery('@', now)).toEqual({ atIndex: 0, query: '', prediction: 'Today' })
  })

  it('detects a partial date query after preceding text', () => {
    const r = findActiveDateQuery('see you @to', now)
    expect(r?.atIndex).toBe(8)
    expect(r?.query).toBe('to')
    expect(r?.prediction).toBe('Today')
  })

  it('ignores an @ not preceded by whitespace (emails/handles)', () => {
    expect(findActiveDateQuery('email me@to', now)).toBeNull()
  })

  it('treats an inline-atom placeholder as a valid boundary before @', () => {
    // A preceding pill serializes to ￼ in textBetween; typing @to after it
    // is still a fresh mention.
    const r = findActiveDateQuery('￼@to', now)
    expect(r?.atIndex).toBe(1)
    expect(r?.query).toBe('to')
  })

  it('returns null for a non-date mention query', () => {
    expect(findActiveDateQuery('@meeting', now)).toBeNull()
  })

  it('keeps a multi-word date query active', () => {
    const r = findActiveDateQuery('@next mon', now)
    expect(r?.query).toBe('next mon')
    expect(r?.prediction).toBe('next Monday')
  })

  it('uses the rightmost @ token at the cursor', () => {
    const r = findActiveDateQuery('@today then @ne', now)
    expect(r?.query).toBe('ne')
    expect(r?.prediction).toBe('next Wednesday')
  })

  it('does not span across an inline atom inside the query', () => {
    expect(findActiveDateQuery('@to￼', now)).toBeNull()
  })

  it('turns off once the typed phrase stops being a clean date prefix', () => {
    expect(findActiveDateQuery('@next monday foo', now)).toBeNull()
  })

  it('stays active for a complete date that has no further completion', () => {
    // "today 12:00" parses but is not a prefix of any completion → keep the
    // highlight (prediction null = no ghost remainder).
    const r = findActiveDateQuery('@today 12:00', now)
    expect(r).not.toBeNull()
    expect(r?.query).toBe('today 12:00')
    expect(r?.prediction).toBeNull()
  })
})

describe('resolveTabAction', () => {
  it('fills the remaining ghost text when the prediction extends the query', () => {
    expect(resolveTabAction('to', now)).toEqual({ kind: 'fill', text: 'Today' })
    expect(resolveTabAction('ne', now)).toEqual({ kind: 'fill', text: 'next Wednesday' })
  })

  it('completes a bare hour by filling :00', () => {
    expect(resolveTabAction('12', now)).toEqual({ kind: 'fill', text: '12:00' })
  })

  it('inserts a pill when the query is already complete (nothing left to fill)', () => {
    const action = resolveTabAction('today', now)
    expect(action?.kind).toBe('pill')
    if (action?.kind === 'pill') {
      expect(action.value.remind).toBe('none')
      expect(action.value.hasTime).toBe(false)
      expect(new Date(action.value.dateISO).getDate()).toBe(17)
    }
  })

  it('inserts a pill with a time for a complete dated time', () => {
    const action = resolveTabAction('today 12:00', now)
    expect(action?.kind).toBe('pill')
    if (action?.kind === 'pill') {
      expect(action.value.hasTime).toBe(true)
      expect(new Date(action.value.dateISO).getHours()).toBe(12)
    }
  })

  it('returns null for a non-date query', () => {
    expect(resolveTabAction('meeting', now)).toBeNull()
  })

  it('returns null when a bare time cannot resolve to a date pill', () => {
    // "12:00" fills, then a 2nd Tab has nothing to anchor the time to.
    expect(resolveTabAction('12:00', now)).toBeNull()
  })
})
