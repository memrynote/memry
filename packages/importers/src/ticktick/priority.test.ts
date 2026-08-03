import { describe, it, expect } from 'vitest'
import { mapPriority } from './priority'

describe('mapPriority', () => {
  it('maps TickTick 0/1/3/5 to Memry 0/1/2/3', () => {
    expect(mapPriority(0)).toEqual({ priority: 0 })
    expect(mapPriority(1)).toEqual({ priority: 1 })
    expect(mapPriority(3)).toEqual({ priority: 2 })
    expect(mapPriority(5)).toEqual({ priority: 3 })
  })
  it('falls back to 0 with a warning for unknown values', () => {
    const r = mapPriority(9)
    expect(r.priority).toBe(0)
    expect(r.warning?.message).toMatch(/priority/i)
  })
})
