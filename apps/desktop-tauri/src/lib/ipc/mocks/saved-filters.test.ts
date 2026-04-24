import { describe, it, expect } from 'vitest'

import { savedFiltersRoutes } from './saved-filters'

describe('savedFiltersRoutes', () => {
  it('saved_filters_list returns at least 5 fixture filters', async () => {
    const list = (await savedFiltersRoutes.saved_filters_list!(undefined)) as Array<{
      id: string
    }>
    expect(list.length).toBeGreaterThanOrEqual(5)
  })

  it('saved_filters_get returns filter by id', async () => {
    const f = (await savedFiltersRoutes.saved_filters_get!({ id: 'filter-1' })) as {
      id: string
    }
    expect(f.id).toBe('filter-1')
  })

  it('saved_filters_get rejects unknown id', async () => {
    await expect(savedFiltersRoutes.saved_filters_get!({ id: 'missing' })).rejects.toThrow(
      /not found/i
    )
  })

  it('saved_filters_create adds a filter', async () => {
    const created = (await savedFiltersRoutes.saved_filters_create!({
      name: 'Urgent work',
      query: { priority: 'urgent' }
    })) as { id: string; name: string }
    expect(created.id).toMatch(/^filter-\d+/)
    expect(created.name).toBe('Urgent work')
  })

  it('saved_filters_update mutates the filter', async () => {
    const updated = (await savedFiltersRoutes.saved_filters_update!({
      id: 'filter-2',
      name: 'Renamed'
    })) as { name: string }
    expect(updated.name).toBe('Renamed')
  })

  it('saved_filters_delete removes the filter', async () => {
    const created = (await savedFiltersRoutes.saved_filters_create!({
      name: 'Doomed',
      query: {}
    })) as { id: string }
    const res = (await savedFiltersRoutes.saved_filters_delete!({ id: created.id })) as {
      ok: boolean
    }
    expect(res.ok).toBe(true)
  })

  it('saved_filters_pin toggles pinned flag', async () => {
    const pinned = (await savedFiltersRoutes.saved_filters_pin!({
      id: 'filter-1',
      pinned: true
    })) as { pinned: boolean }
    expect(pinned.pinned).toBe(true)
  })
})
