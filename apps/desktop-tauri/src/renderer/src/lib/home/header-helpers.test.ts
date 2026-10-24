import { describe, it, expect } from 'vitest'
import { getGreetingKey, buildHeaderMetrics } from './header-helpers'

describe('getGreetingKey', () => {
  it('maps morning hours [5,12)', () => {
    expect(getGreetingKey(5)).toBe('morning')
    expect(getGreetingKey(11)).toBe('morning')
  })

  it('maps afternoon hours [12,18)', () => {
    expect(getGreetingKey(12)).toBe('afternoon')
    expect(getGreetingKey(17)).toBe('afternoon')
  })

  it('maps evening hours (18,24) and (0,5)', () => {
    expect(getGreetingKey(18)).toBe('evening')
    expect(getGreetingKey(23)).toBe('evening')
    expect(getGreetingKey(0)).toBe('evening')
    expect(getGreetingKey(4)).toBe('evening')
  })
})

describe('buildHeaderMetrics', () => {
  it('keeps order and drops zero/negative counts', () => {
    expect(buildHeaderMetrics({ tasksDue: 4, events: 2 })).toEqual([
      { key: 'tasksDue', count: 4 },
      { key: 'events', count: 2 }
    ])
    expect(buildHeaderMetrics({ tasksDue: 0, events: 3 })).toEqual([{ key: 'events', count: 3 }])
    expect(buildHeaderMetrics({ tasksDue: 0, events: 0 })).toEqual([])
  })
})
