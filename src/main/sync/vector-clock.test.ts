import { describe, expect, it } from 'vitest'

import { compare, createClock, getTick, increment, merge } from './vector-clock'

describe('vector-clock', () => {
  it('creates an empty clock', () => {
    expect(createClock()).toEqual({})
  })

  it('increments ticks immutably', () => {
    const base = { deviceA: 1 }
    const next = increment(base, 'deviceA')

    expect(base).toEqual({ deviceA: 1 })
    expect(next).toEqual({ deviceA: 2 })
    expect(increment(base, 'deviceB')).toEqual({ deviceA: 1, deviceB: 1 })
  })

  it('merges by taking max tick per device', () => {
    const merged = merge({ a: 1, b: 4 }, { a: 3, c: 2 })
    expect(merged).toEqual({ a: 3, b: 4, c: 2 })
  })

  it('compares equal, before, after, and concurrent clocks', () => {
    expect(compare({ a: 1 }, { a: 1 })).toBe('equal')
    expect(compare({ a: 1 }, { a: 2 })).toBe('before')
    expect(compare({ a: 3 }, { a: 2 })).toBe('after')
    expect(compare({ a: 2, b: 1 }, { a: 1, b: 2 })).toBe('concurrent')
  })

  it('returns 0 for missing ticks', () => {
    expect(getTick({}, 'missing')).toBe(0)
    expect(getTick({ known: 3 }, 'known')).toBe(3)
  })
})
