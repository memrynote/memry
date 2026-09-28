/**
 * The graph tab's view state: filters, colouring, and collapsed tag categories.
 *
 * Lives in the tab's `viewState` under {@link GRAPH_VIEW_TAB_KEY}, so it
 * survives a tab switch and an app restart. A graph tab opened from scratch
 * has nothing stored and starts from `initialState` — the page passes the
 * last state any graph tab used, which is what makes filters survive closing
 * the tab and opening the graph again.
 */

import { useCallback, useMemo, type Dispatch } from 'react'
import {
  GRAPH_VIEW_FILTER_DEFAULTS,
  parseGraphViewState,
  type GraphColorBy,
  type GraphViewFilters,
  type GraphViewState
} from '@memry/contracts/graph-api'
import { useTabViewState } from '@/hooks/use-tab-view-state'

export type GraphFilterState = GraphViewFilters

export type GraphFilterAction =
  | { type: 'TOGGLE_ENTITY_TYPE'; entityType: 'note' | 'task' | 'journal' | 'project' | 'tag' }
  | { type: 'TOGGLE_ORPHANS' }
  | { type: 'TOGGLE_CANVAS_EDGES' }
  | { type: 'SET_SELECTED_TAGS'; tags: string[] }
  | { type: 'SET_FOCUS_NODE'; nodeId: string; depth?: number }
  | { type: 'SET_FOCUS_DEPTH'; depth: number }
  | { type: 'CLEAR_FOCUS' }
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'RESET_FILTERS' }

/**
 * Name inside `Tab.viewState`. Load-bearing for sessions on disk: renaming it
 * silently resets every open graph tab on upgrade.
 */
export const GRAPH_VIEW_TAB_KEY = 'graphView'

export interface StoredGraphTabView {
  state: GraphViewState
  /** The saved view this tab last applied, or null for an unsaved arrangement. */
  activeViewId: string | null
}

export function parseStoredGraphTabView(raw: unknown): StoredGraphTabView | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as { state?: unknown; activeViewId?: unknown }
  return {
    state: parseGraphViewState(record.state),
    activeViewId:
      typeof record.activeViewId === 'string' && record.activeViewId !== ''
        ? record.activeViewId
        : null
  }
}

const ENTITY_TYPE_KEYS = {
  note: 'showNotes',
  task: 'showTasks',
  journal: 'showJournals',
  project: 'showProjects',
  tag: 'showTags'
} as const

export function filterReducer(
  state: GraphFilterState,
  action: GraphFilterAction
): GraphFilterState {
  switch (action.type) {
    case 'TOGGLE_ENTITY_TYPE': {
      const key = ENTITY_TYPE_KEYS[action.entityType]
      return { ...state, [key]: !state[key] }
    }
    case 'TOGGLE_ORPHANS':
      return { ...state, showOrphans: !state.showOrphans }
    case 'TOGGLE_CANVAS_EDGES':
      return { ...state, showCanvasEdges: !state.showCanvasEdges }
    case 'SET_SELECTED_TAGS':
      return { ...state, selectedTags: action.tags }
    case 'SET_FOCUS_NODE':
      return { ...state, focusNodeId: action.nodeId, focusDepth: action.depth ?? state.focusDepth }
    case 'SET_FOCUS_DEPTH':
      return { ...state, focusDepth: action.depth }
    case 'CLEAR_FOCUS':
      return { ...state, focusNodeId: null }
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.query }
    case 'RESET_FILTERS':
      return GRAPH_VIEW_FILTER_DEFAULTS
  }
}

export function isGraphFiltered(filterState: GraphFilterState): boolean {
  return (
    !filterState.showNotes ||
    !filterState.showTasks ||
    !filterState.showJournals ||
    !filterState.showProjects ||
    !filterState.showTags ||
    !filterState.showOrphans ||
    !filterState.showCanvasEdges ||
    filterState.selectedTags.length > 0 ||
    filterState.focusNodeId !== null ||
    filterState.searchQuery.length > 0
  )
}

export interface UseGraphFiltersResult {
  viewState: GraphViewState
  activeViewId: string | null
  filterState: GraphFilterState
  dispatch: Dispatch<GraphFilterAction>
  isFiltered: boolean
  setColorBy: (colorBy: GraphColorBy) => void
  toggleCollapsed: (categoryId: string) => void
  /** Replace the whole view state, e.g. when a saved view is applied or re-saved. */
  applyView: (state: GraphViewState, activeViewId: string | null) => void
}

export function useGraphFilters(initialState: GraphViewState): UseGraphFiltersResult {
  const defaultValue = useMemo<StoredGraphTabView>(
    () => ({ state: initialState, activeViewId: null }),
    [initialState]
  )
  const [stored, setStored] = useTabViewState<StoredGraphTabView>({
    key: GRAPH_VIEW_TAB_KEY,
    defaultValue,
    parse: parseStoredGraphTabView
  })

  const updateState = useCallback(
    (update: (state: GraphViewState) => GraphViewState) =>
      setStored((previous) => ({ ...previous, state: update(previous.state) })),
    [setStored]
  )

  const dispatch = useCallback<Dispatch<GraphFilterAction>>(
    (action) =>
      updateState((state) => ({ ...state, filters: filterReducer(state.filters, action) })),
    [updateState]
  )

  const setColorBy = useCallback(
    (colorBy: GraphColorBy) => updateState((state) => ({ ...state, colorBy })),
    [updateState]
  )

  const toggleCollapsed = useCallback(
    (categoryId: string) =>
      updateState((state) => ({
        ...state,
        collapsedCategoryIds: state.collapsedCategoryIds.includes(categoryId)
          ? state.collapsedCategoryIds.filter((id) => id !== categoryId)
          : [...state.collapsedCategoryIds, categoryId]
      })),
    [updateState]
  )

  const applyView = useCallback(
    (state: GraphViewState, activeViewId: string | null) => setStored({ state, activeViewId }),
    [setStored]
  )

  return {
    viewState: stored.state,
    activeViewId: stored.activeViewId,
    filterState: stored.state.filters,
    dispatch,
    isFiltered: isGraphFiltered(stored.state.filters),
    setColorBy,
    toggleCollapsed,
    applyView
  }
}
