import { describe, expect, it } from 'vitest'
import { assignLanes } from './overlap-layout'

type Item = { id: string; startAt: string; endAt: string | null }

const mk = (id: string, startAt: string, endAt: string | null): Item => ({ id, startAt, endAt })

describe('assignLanes', () => {
  it('returns an empty array for empty input', () => {
    // #given / #when
    const result = assignLanes<Item>([])
    // #then
    expect(result).toEqual([])
  })

  it('places a single event at lane 0 with laneCount 1', () => {
    // #given
    const items = [mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')]
    // #when
    const result = assignLanes(items)
    // #then
    expect(result).toEqual([{ item: items[0], lane: 0, laneCount: 1 }])
  })

  it('places two non-overlapping events each at lane 0 with laneCount 1', () => {
    // #given
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')
    const b = mk('b', '2026-04-20T11:00:00Z', '2026-04-20T12:00:00Z')
    // #when
    const result = assignLanes([a, b])
    // #then
    expect(result).toEqual([
      { item: a, lane: 0, laneCount: 1 },
      { item: b, lane: 0, laneCount: 1 }
    ])
  })

  it('treats events that touch at the boundary as non-overlapping', () => {
    // #given — B starts exactly when A ends
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')
    const b = mk('b', '2026-04-20T10:00:00Z', '2026-04-20T11:00:00Z')
    // #when
    const result = assignLanes([a, b])
    // #then
    expect(result.every((r) => r.laneCount === 1)).toBe(true)
  })

  it('splits two overlapping events into lanes 0 and 1', () => {
    // #given
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')
    const b = mk('b', '2026-04-20T09:30:00Z', '2026-04-20T10:30:00Z')
    // #when
    const result = assignLanes([a, b])
    // #then
    const byId = Object.fromEntries(result.map((r) => [r.item.id, r]))
    expect(byId.a.lane).toBe(0)
    expect(byId.a.laneCount).toBe(2)
    expect(byId.b.lane).toBe(1)
    expect(byId.b.laneCount).toBe(2)
  })

  it('reuses a lane when an earlier event in that lane has already ended (chain overlap)', () => {
    // #given — A (9-10), B (9:30-10:30), C (10:15-11)
    // A and C do not overlap so C should reuse A's lane
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')
    const b = mk('b', '2026-04-20T09:30:00Z', '2026-04-20T10:30:00Z')
    const c = mk('c', '2026-04-20T10:15:00Z', '2026-04-20T11:00:00Z')
    // #when
    const result = assignLanes([a, b, c])
    // #then
    const byId = Object.fromEntries(result.map((r) => [r.item.id, r]))
    expect(byId.a.lane).toBe(0)
    expect(byId.b.lane).toBe(1)
    expect(byId.c.lane).toBe(0)
    // The cluster has 2 concurrent lanes at its peak
    expect(byId.a.laneCount).toBe(2)
    expect(byId.b.laneCount).toBe(2)
    expect(byId.c.laneCount).toBe(2)
  })

  it('keeps separate non-overlapping clusters independent', () => {
    // #given — [A,B overlap] then gap then [C alone]
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')
    const b = mk('b', '2026-04-20T09:30:00Z', '2026-04-20T10:30:00Z')
    const c = mk('c', '2026-04-20T14:00:00Z', '2026-04-20T15:00:00Z')
    // #when
    const result = assignLanes([a, b, c])
    // #then
    const byId = Object.fromEntries(result.map((r) => [r.item.id, r]))
    expect(byId.a.laneCount).toBe(2)
    expect(byId.b.laneCount).toBe(2)
    expect(byId.c.laneCount).toBe(1)
    expect(byId.c.lane).toBe(0)
  })

  it('assigns three overlapping events to lanes 0, 1, 2 with laneCount 3', () => {
    // #given — all three overlap at 9:45
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')
    const b = mk('b', '2026-04-20T09:15:00Z', '2026-04-20T10:15:00Z')
    const c = mk('c', '2026-04-20T09:30:00Z', '2026-04-20T10:30:00Z')
    // #when
    const result = assignLanes([a, b, c])
    // #then
    const lanes = result.map((r) => r.lane).sort()
    expect(lanes).toEqual([0, 1, 2])
    expect(result.every((r) => r.laneCount === 3)).toBe(true)
  })

  it('handles events whose endAt is null by treating duration as one hour', () => {
    // #given — A has null endAt (default 1h), B starts 30m in
    const a = mk('a', '2026-04-20T09:00:00Z', null)
    const b = mk('b', '2026-04-20T09:30:00Z', '2026-04-20T10:30:00Z')
    // #when
    const result = assignLanes([a, b])
    // #then — they overlap (A ends 10:00, B starts 9:30)
    expect(result.every((r) => r.laneCount === 2)).toBe(true)
  })

  it('is stable for input that is not pre-sorted by startAt', () => {
    // #given — intentionally reversed order
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T10:00:00Z')
    const b = mk('b', '2026-04-20T09:30:00Z', '2026-04-20T10:30:00Z')
    // #when
    const result = assignLanes([b, a])
    // #then
    const byId = Object.fromEntries(result.map((r) => [r.item.id, r]))
    expect(byId.a.lane).toBe(0)
    expect(byId.b.lane).toBe(1)
  })

  it('handles a nested event (short inside a longer one) with two lanes', () => {
    // #given — big A (9-12), tiny B (10-11) fully inside A
    const a = mk('a', '2026-04-20T09:00:00Z', '2026-04-20T12:00:00Z')
    const b = mk('b', '2026-04-20T10:00:00Z', '2026-04-20T11:00:00Z')
    // #when
    const result = assignLanes([a, b])
    // #then
    const byId = Object.fromEntries(result.map((r) => [r.item.id, r]))
    expect(byId.a.lane).toBe(0)
    expect(byId.b.lane).toBe(1)
    expect(byId.a.laneCount).toBe(2)
    expect(byId.b.laneCount).toBe(2)
  })
})
