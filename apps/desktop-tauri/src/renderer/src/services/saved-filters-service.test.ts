import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  savedFiltersService,
  onSavedFilterCreated,
  onSavedFilterUpdated,
  onSavedFilterDeleted
} from './saved-filters-service'

describe('saved-filters-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    api.savedFilters.list = vi.fn().mockResolvedValue({ savedFilters: [] })
    api.savedFilters.create = vi.fn().mockResolvedValue({ success: true, savedFilter: null })
    api.savedFilters.update = vi.fn().mockResolvedValue({ success: true, savedFilter: null })
    api.savedFilters.delete = vi.fn().mockResolvedValue({ success: true })
    api.savedFilters.reorder = vi.fn().mockResolvedValue({ success: true })

    api.onSavedFilterCreated = vi.fn().mockReturnValue(() => {})
    api.onSavedFilterUpdated = vi.fn().mockReturnValue(() => {})
    api.onSavedFilterDeleted = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards saved filter CRUD and reorder operations', async () => {
    await savedFiltersService.list()
    expect(api.savedFilters.list).toHaveBeenCalled()

    const createInput = { name: 'My Filter', config: { filters: {}, sort: undefined } }
    await savedFiltersService.create(createInput)
    expect(api.savedFilters.create).toHaveBeenCalledWith(createInput)

    const updateInput = { id: 'filter-1', name: 'Updated' }
    await savedFiltersService.update(updateInput)
    expect(api.savedFilters.update).toHaveBeenCalledWith(updateInput)

    await savedFiltersService.delete('filter-1')
    expect(api.savedFilters.delete).toHaveBeenCalledWith('filter-1')

    await savedFiltersService.reorder(['filter-1', 'filter-2'], [0, 1])
    expect(api.savedFilters.reorder).toHaveBeenCalledWith(['filter-1', 'filter-2'], [0, 1])
  })

  it('registers saved filter event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onSavedFilterCreated = vi.fn(() => unsubscribe)
    api.onSavedFilterUpdated = vi.fn(() => unsubscribe)
    api.onSavedFilterDeleted = vi.fn(() => unsubscribe)

    expect(onSavedFilterCreated(vi.fn())).toBe(unsubscribe)
    expect(onSavedFilterUpdated(vi.fn())).toBe(unsubscribe)
    expect(onSavedFilterDeleted(vi.fn())).toBe(unsubscribe)
  })
})
