import { useReducer, type Dispatch } from 'react'

export interface GraphFilterState {
  showNotes: boolean
  showTasks: boolean
  showJournals: boolean
  showProjects: boolean
  showTags: boolean
  showOrphans: boolean
  selectedTags: string[]
  focusNodeId: string | null
  focusDepth: number
  searchQuery: string
}

export type GraphFilterAction =
  | { type: 'TOGGLE_ENTITY_TYPE'; entityType: 'note' | 'task' | 'journal' | 'project' | 'tag' }
  | { type: 'TOGGLE_ORPHANS' }
  | { type: 'SET_SELECTED_TAGS'; tags: string[] }
  | { type: 'SET_FOCUS_NODE'; nodeId: string; depth?: number }
  | { type: 'SET_FOCUS_DEPTH'; depth: number }
  | { type: 'CLEAR_FOCUS' }
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'RESET_FILTERS' }

const INITIAL_STATE: GraphFilterState = {
  showNotes: true,
  showTasks: true,
  showJournals: true,
  showProjects: true,
  showTags: true,
  showOrphans: true,
  selectedTags: [],
  focusNodeId: null,
  focusDepth: 2,
  searchQuery: ''
}

const ENTITY_TYPE_KEYS = {
  note: 'showNotes',
  task: 'showTasks',
  journal: 'showJournals',
  project: 'showProjects',
  tag: 'showTags'
} as const

function filterReducer(state: GraphFilterState, action: GraphFilterAction): GraphFilterState {
  switch (action.type) {
    case 'TOGGLE_ENTITY_TYPE': {
      const key = ENTITY_TYPE_KEYS[action.entityType]
      return { ...state, [key]: !state[key] }
    }
    case 'TOGGLE_ORPHANS':
      return { ...state, showOrphans: !state.showOrphans }
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
      return INITIAL_STATE
  }
}

export function useGraphFilters(): {
  filterState: GraphFilterState
  dispatch: Dispatch<GraphFilterAction>
  isFiltered: boolean
} {
  const [filterState, dispatch] = useReducer(filterReducer, INITIAL_STATE)

  const isFiltered =
    !filterState.showNotes ||
    !filterState.showTasks ||
    !filterState.showJournals ||
    !filterState.showProjects ||
    !filterState.showTags ||
    !filterState.showOrphans ||
    filterState.selectedTags.length > 0 ||
    filterState.focusNodeId !== null ||
    filterState.searchQuery.length > 0

  return { filterState, dispatch, isFiltered }
}
