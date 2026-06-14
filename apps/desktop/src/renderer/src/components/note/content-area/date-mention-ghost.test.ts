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

  it('stays active (no ghost) while the "at" connector is being typed', () => {
    const r = findActiveDateQuery('@today at', now)
    expect(r).not.toBeNull()
    expect(r?.query).toBe('today at')
    expect(r?.prediction).toBeNull()
  })

  it('ghosts the time typed after the "at" connector', () => {
    const r = findActiveDateQuery('@today at 23', now)
    expect(r?.query).toBe('today at 23')
    expect(r?.prediction).toBe('today at 23:00')
  })

  it('keeps padding the minutes alive once the colon is typed', () => {
    const r = findActiveDateQuery('@today 23:', now)
    expect(r?.query).toBe('today 23:')
    expect(r?.prediction).toBe('today 23:00')
  })

  it('stays active (no ghost) while a single minute digit is being typed', () => {
    const r = findActiveDateQuery('@today at 23:3', now)
    expect(r).not.toBeNull()
    expect(r?.query).toBe('today at 23:3')
    expect(r?.prediction).toBeNull()
  })

  it('stays active for a complete "<date> at <time>" phrase', () => {
    const r = findActiveDateQuery('@today at 23:00', now)
    expect(r).not.toBeNull()
    expect(r?.query).toBe('today at 23:00')
    expect(r?.prediction).toBeNull()
  })

  it('stays active (no ghost) while a meridiem is typed after the hour', () => {
    const r = findActiveDateQuery('@today at 14p', now)
    expect(r).not.toBeNull()
    expect(r?.query).toBe('today at 14p')
    expect(r?.prediction).toBeNull()
  })

  it('stays active for a 24-hour hour written with a redundant meridiem', () => {
    const r = findActiveDateQuery('@next monday at 14pm', now)
    expect(r).not.toBeNull()
    expect(r?.query).toBe('next monday at 14pm')
  })

  // The emoji-picker-suppression contract: the `:` emoji menu opens at
  // minQueryLength 2 (after the 2nd minute digit), so the mention MUST read as
  // active at exactly these states for `shouldOpen` to keep clock emojis away.
  it('stays active for a fully-typed "<date> HH:MM" time (emoji-trigger state)', () => {
    const r = findActiveDateQuery('@today 23:20', now)
    expect(r).not.toBeNull()
    expect(r?.query).toBe('today 23:20')
  })

  // Boundary: a bare `@HH:MM` with no day cannot resolve to a date pill, so it is
  // NOT an active date mention — emoji suppression covers only real reminders
  // like `@today 23:20`. (Out of scope; documented so the boundary is explicit.)
  it('does not treat a bare "@HH:MM" with no day as a date mention', () => {
    expect(findActiveDateQuery('@23:20', now)).toBeNull()
  })

  it('leaves a bare prose time (no @) untouched — emoji stays available there', () => {
    expect(findActiveDateQuery('meeting at 3:20 today', now)).toBeNull()
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

  it('fills the time typed after the "at" connector', () => {
    expect(resolveTabAction('today at 23', now)).toEqual({
      kind: 'fill',
      text: 'today at 23:00'
    })
  })

  it('inserts a timed pill for a complete "<date> at <time>" phrase', () => {
    const action = resolveTabAction('today at 23:00', now)
    expect(action?.kind).toBe('pill')
    if (action?.kind === 'pill') {
      expect(action.value.hasTime).toBe(true)
      expect(new Date(action.value.dateISO).getHours()).toBe(23)
    }
  })

  it('inserts a timed pill for a 24-hour hour written with a meridiem', () => {
    const action = resolveTabAction('next monday at 14pm', now)
    expect(action?.kind).toBe('pill')
    if (action?.kind === 'pill') {
      expect(action.value.hasTime).toBe(true)
      expect(new Date(action.value.dateISO).getHours()).toBe(14)
    }
  })
})
