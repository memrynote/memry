import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { GRAPH_VIEW_STATE_DEFAULTS, type GraphViewState } from '@memry/contracts/graph-api'
import { parseStoredGraphTabView, useGraphFilters } from './use-graph-filters'

const seeded: GraphViewState = {
  ...GRAPH_VIEW_STATE_DEFAULTS,
  filters: { ...GRAPH_VIEW_STATE_DEFAULTS.filters, showTasks: false },
  colorBy: 'tag-category'
}

describe('useGraphFilters', () => {
  it('starts a tab with nothing stored from the state it is seeded with', () => {
    const { result } = renderHook(() => useGraphFilters(seeded))
    expect(result.current.viewState).toEqual(seeded)
    expect(result.current.activeViewId).toBeNull()
    expect(result.current.isFiltered).toBe(true)
  })

  it('toggles collapsed categories and applies a saved view', () => {
    const { result } = renderHook(() => useGraphFilters(GRAPH_VIEW_STATE_DEFAULTS))

    act(() => result.current.toggleCollapsed('work'))
    act(() => result.current.toggleCollapsed('home'))
    act(() => result.current.toggleCollapsed('work'))
    expect(result.current.viewState.collapsedCategoryIds).toEqual(['home'])

    act(() => result.current.setColorBy('tag-category'))
    act(() => result.current.dispatch({ type: 'SET_SEARCH_QUERY', query: 'alpha' }))
    expect(result.current.viewState.colorBy).toBe('tag-category')
    expect(result.current.filterState.searchQuery).toBe('alpha')

    act(() => result.current.applyView(seeded, 'view-1'))
    expect(result.current.viewState).toEqual(seeded)
    expect(result.current.activeViewId).toBe('view-1')
  })
})

describe('parseStoredGraphTabView', () => {
  it('rejects a non-object so the tab falls back to its seed', () => {
    expect(parseStoredGraphTabView(undefined)).toBeUndefined()
    expect(parseStoredGraphTabView('x')).toBeUndefined()
  })

  it('restores what it can from a partial record', () => {
    expect(
      parseStoredGraphTabView({ state: { colorBy: 'tag-category' }, activeViewId: 7 })
    ).toEqual({
      state: { ...GRAPH_VIEW_STATE_DEFAULTS, colorBy: 'tag-category' },
      activeViewId: null
    })
  })
})
