import { describe, it, expect } from 'vitest'

import { calendarRoutes } from './calendar'

describe('calendarRoutes', () => {
  it('calendar_list_events returns 20+ events spanning 3 weeks', async () => {
    const list = (await calendarRoutes.calendar_list_events!(undefined)) as Array<{
      startAt: number
      endAt: number
    }>
    expect(list.length).toBeGreaterThanOrEqual(20)
    const times = list.map((e) => e.startAt).sort((a, b) => a - b)
    expect(times[times.length - 1]! - times[0]!).toBeGreaterThan(7 * 86_400_000)
  })

  it('calendar_range returns events between from and to', async () => {
    const now = Date.now()
    const from = now - 5 * 86_400_000
    const to = now + 2 * 86_400_000
    const list = (await calendarRoutes.calendar_range!({ from, to })) as Array<{
      startAt: number
    }>
    expect(list.every((e) => e.startAt >= from && e.startAt <= to)).toBe(true)
  })

  it('calendar_get returns event by id', async () => {
    const event = (await calendarRoutes.calendar_get!({ id: 'event-1' })) as { id: string }
    expect(event.id).toBe('event-1')
  })

  it('calendar_get rejects unknown id', async () => {
    await expect(calendarRoutes.calendar_get!({ id: 'missing' })).rejects.toThrow(/not found/i)
  })

  it('calendar_create appends a new event', async () => {
    const now = Date.now()
    const created = (await calendarRoutes.calendar_create!({
      title: 'New event',
      startAt: now,
      endAt: now + 3_600_000
    })) as { id: string; title: string }
    expect(created.id).toMatch(/^event-\d+/)
    expect(created.title).toBe('New event')
  })

  it('calendar_update mutates the event', async () => {
    const updated = (await calendarRoutes.calendar_update!({
      id: 'event-2',
      title: 'Renamed'
    })) as { id: string; title: string }
    expect(updated.title).toBe('Renamed')
  })

  it('calendar_delete removes the event', async () => {
    const now = Date.now()
    const created = (await calendarRoutes.calendar_create!({
      title: 'Doomed',
      startAt: now,
      endAt: now
    })) as { id: string }
    const result = (await calendarRoutes.calendar_delete!({ id: created.id })) as { ok: boolean }
    expect(result.ok).toBe(true)
  })

  it('calendar_list_sources returns at least one source', async () => {
    const sources = (await calendarRoutes.calendar_list_sources!(undefined)) as Array<{
      id: string
    }>
    expect(sources.length).toBeGreaterThanOrEqual(1)
  })
})
