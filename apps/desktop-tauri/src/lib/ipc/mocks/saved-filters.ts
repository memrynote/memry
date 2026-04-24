import type { MockRouteMap } from './types'
import { mockId, mockTimestamp } from './types'

interface MockSavedFilter {
  id: string
  name: string
  scope: 'notes' | 'tasks' | 'inbox' | 'calendar'
  query: Record<string, unknown>
  pinned: boolean
  createdAt: number
  updatedAt: number
}

const filters: MockSavedFilter[] = [
  {
    id: 'filter-1',
    name: 'Today',
    scope: 'tasks',
    query: { dueBefore: 'today' },
    pinned: true,
    createdAt: mockTimestamp(30),
    updatedAt: mockTimestamp(0)
  },
  {
    id: 'filter-2',
    name: 'Overdue',
    scope: 'tasks',
    query: { status: ['todo', 'in-progress'], dueBefore: 'now' },
    pinned: true,
    createdAt: mockTimestamp(28),
    updatedAt: mockTimestamp(0)
  },
  {
    id: 'filter-3',
    name: 'Starred notes',
    scope: 'notes',
    query: { starred: true },
    pinned: false,
    createdAt: mockTimestamp(25),
    updatedAt: mockTimestamp(1)
  },
  {
    id: 'filter-4',
    name: 'Unfiled inbox',
    scope: 'inbox',
    query: { status: 'unread' },
    pinned: true,
    createdAt: mockTimestamp(20),
    updatedAt: mockTimestamp(0)
  },
  {
    id: 'filter-5',
    name: 'This week',
    scope: 'calendar',
    query: { from: 'startOfWeek', to: 'endOfWeek' },
    pinned: false,
    createdAt: mockTimestamp(15),
    updatedAt: mockTimestamp(1)
  },
  {
    id: 'filter-6',
    name: 'Research tag',
    scope: 'notes',
    query: { tags: ['research'] },
    pinned: false,
    createdAt: mockTimestamp(10),
    updatedAt: mockTimestamp(0)
  }
]

export const savedFiltersRoutes: MockRouteMap = {
  // Contract: SavedFilterListResponse = { savedFilters: SavedFilter[] } where
  // each SavedFilter has { id, name, config: { filters: {search, projectIds,
  // priorities, dueDate: {type, customStart, customEnd}, statusIds, ...}, sort }}.
  // The M1 fixture above predates that schema and has a flatter `query` shape
  // that the renderer can't destructure (Hook:TaskFilters throws on
  // `config.filters.dueDate.type`). For M1 mount-parity we return an empty
  // list — the list is optional UX. M2+ either re-shapes the fixtures to the
  // real contract or removes the legacy fixtures entirely.
  saved_filters_list: async () => ({ savedFilters: [] as unknown[] }),
  saved_filters_get: async (args) => {
    const { id } = args as { id: string }
    const f = filters.find((x) => x.id === id)
    if (!f) throw new Error(`Saved filter ${id} not found`)
    return f
  },
  saved_filters_create: async (args) => {
    const input = args as Partial<MockSavedFilter> & { name: string; query: Record<string, unknown> }
    const now = Date.now()
    const f: MockSavedFilter = {
      id: mockId('filter'),
      name: input.name,
      scope: input.scope ?? 'notes',
      query: input.query,
      pinned: input.pinned ?? false,
      createdAt: now,
      updatedAt: now
    }
    filters.push(f)
    return f
  },
  saved_filters_update: async (args) => {
    const { id, ...changes } = args as { id: string } & Partial<MockSavedFilter>
    const f = filters.find((x) => x.id === id)
    if (!f) throw new Error(`Saved filter ${id} not found`)
    Object.assign(f, changes, { updatedAt: Date.now() })
    return f
  },
  saved_filters_delete: async (args) => {
    const { id } = args as { id: string }
    const idx = filters.findIndex((f) => f.id === id)
    if (idx >= 0) filters.splice(idx, 1)
    return { ok: true }
  },
  saved_filters_pin: async (args) => {
    const { id, pinned } = args as { id: string; pinned: boolean }
    const f = filters.find((x) => x.id === id)
    if (!f) throw new Error(`Saved filter ${id} not found`)
    f.pinned = pinned
    f.updatedAt = Date.now()
    return f
  }
}
