/**
 * Inputs for the `task-filtering` class. Inputs only: every expected value is
 * recorded from `@memry/domain-tasks/filtering` by `task-filtering.ts`.
 */

export const FILTER_NOWS = {
  /** Wednesday 2026-01-14. */
  wednesday: '2026-01-14T12:00:00',
  /** Sunday 2026-01-18: the week boundary differs by week start. */
  sunday: '2026-01-18T09:00:00',
  /** Month end. */
  monthEnd: '2026-01-31T18:00:00'
} as const

export type FilterNowKey = keyof typeof FILTER_NOWS

export const FILTER_PROJECTS = [
  {
    id: 'p1',
    name: 'Work',
    color: '#ef4444',
    statuses: [
      { id: 'p1-todo', type: 'todo', color: '#6b7280', order: 0 },
      { id: 'p1-doing', type: 'in_progress', color: '#F59E0B', order: 1 },
      { id: 'p1-review', type: 'in_progress', color: '#8b5cf6', order: 2 },
      { id: 'p1-done', type: 'done', color: '#22c55e', order: 3 }
    ]
  },
  {
    id: 'p2',
    name: 'alpha',
    color: '#3b82f6',
    statuses: [
      { id: 'p2-todo', type: 'todo', color: '#111111', order: 0 },
      { id: 'p2-done', type: 'done', color: '#222222', order: 1 }
    ]
  },
  {
    id: 'p3',
    name: 'Éclair',
    color: '#10b981',
    statuses: [{ id: 'p3-todo', type: 'todo', color: '#333333', order: 0 }]
  }
] as const

export const FILTER_NOTES = [
  { id: 'n-roadmap', title: 'Roadmap', folderPath: 'Acme/Planning' },
  { id: 'n-standup', title: 'standup', folderPath: 'Acme' },
  { id: 'n-loose', title: 'Loose note', folderPath: '' },
  { id: 'n-budget', title: 'Budget', folderPath: 'Acme/Planning' },
  { id: 'n-zeta', title: 'Zeta', folderPath: 'beta' }
] as const

export interface WireTask {
  id: string
  title: string
  description: string | null
  projectId: string
  statusId: string
  parentId: string | null
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  dueDate: string | null
  dueTime: string | null
  createdAt: string
  completedAt: string | null
  archivedAt: string | null
  isRepeating: boolean
  tags: string[]
  sourceNoteId: string | null
  linkedNoteIds: string[]
}

const t = (id: string, fields: Partial<Omit<WireTask, 'id'>> = {}): WireTask => ({
  id,
  title: id,
  description: null,
  projectId: 'p1',
  statusId: 'p1-todo',
  parentId: null,
  priority: 'none',
  dueDate: null,
  dueTime: null,
  createdAt: '2026-01-10T10:00:00',
  completedAt: null,
  archivedAt: null,
  isRepeating: false,
  tags: [],
  sourceNoteId: null,
  linkedNoteIds: [],
  ...fields
})

export const FILTER_TASKS: readonly WireTask[] = [
  t('a', {
    title: 'Write report',
    description: 'Quarterly numbers',
    priority: 'high',
    dueDate: '2026-01-14',
    dueTime: '09:00',
    tags: ['work', 'Writing'],
    sourceNoteId: 'n-roadmap',
    createdAt: '2026-01-14T08:00:00'
  }),
  t('b', {
    title: 'banana bread',
    priority: 'low',
    dueDate: '2026-01-12',
    projectId: 'p2',
    statusId: 'p2-todo',
    tags: ['home'],
    createdAt: '2026-01-13T08:00:00'
  }),
  t('c', {
    title: 'Apple pie',
    priority: 'urgent',
    dueDate: '2026-01-14',
    dueTime: '08:30',
    statusId: 'p1-doing',
    linkedNoteIds: ['n-standup', 'n-roadmap'],
    createdAt: '2026-01-07T08:00:00'
  }),
  t('d', {
    title: 'draft email',
    description: 'REPORT draft for review',
    priority: 'medium',
    dueDate: '2026-01-15',
    statusId: 'p1-review',
    isRepeating: true,
    tags: ['WORK'],
    sourceNoteId: 'n-loose'
  }),
  t('e', {
    title: 'Banana split',
    dueDate: '2026-01-21',
    projectId: 'p3',
    statusId: 'p3-todo',
    sourceNoteId: 'n-missing',
    createdAt: '2025-12-01T08:00:00'
  }),
  t('f', {
    title: 'Éclair tasting',
    priority: 'high',
    dueDate: '2026-01-19',
    dueTime: '14:00',
    sourceNoteId: 'n-zeta'
  }),
  t('g', {
    title: 'done thing',
    statusId: 'p1-done',
    dueDate: '2026-01-13',
    completedAt: '2026-01-13T10:00:00',
    sourceNoteId: 'n-budget'
  }),
  t('h', {
    title: 'archived thing',
    statusId: 'p1-done',
    dueDate: '2026-01-10',
    completedAt: '2026-01-10T10:00:00',
    archivedAt: '2026-01-11T10:00:00'
  }),
  t('i', { title: 'orphan status', statusId: 'gone', dueDate: '2026-02-20' }),
  t('j', { title: 'unknown project', projectId: 'nope', statusId: 'nope-todo' }),
  t('k', {
    title: 'report subtask',
    parentId: 'a',
    priority: 'urgent',
    dueDate: '2026-01-13'
  }),
  t('l', { title: 'sub of b', parentId: 'b', projectId: 'p2', statusId: 'p2-todo' }),
  t('m', {
    title: 'monthly review',
    dueDate: '2026-01-31',
    isRepeating: true,
    priority: 'medium',
    createdAt: '2026-01-14T11:00:00'
  }),
  t('n', { title: 'next week plan', dueDate: '2026-01-26', dueTime: '10:00' }),
  t('o', {
    title: 'write report',
    dueDate: '2026-01-14',
    dueTime: '09:00',
    priority: 'high',
    createdAt: '2026-01-14T08:00:00'
  })
]

export interface WireDueDateFilter {
  type: string
  customStart?: string | null
  customEnd?: string | null
}

export interface WireFilters {
  search: string
  projectIds: string[]
  priorities: Array<'urgent' | 'high' | 'medium' | 'low' | 'none'>
  tags: string[]
  dueDate: WireDueDateFilter
  statusIds: string[]
  completion: 'active' | 'completed' | 'all' | 'archived'
  repeatType: 'all' | 'repeating' | 'one-time'
  hasTime: 'all' | 'with-time' | 'without-time'
}

const defaults: WireFilters = {
  search: '',
  projectIds: [],
  priorities: [],
  tags: [],
  dueDate: { type: 'any', customStart: null, customEnd: null },
  statusIds: [],
  completion: 'active',
  repeatType: 'all',
  hasTime: 'all'
}

export const FILTER_CASES: ReadonlyArray<{
  name: string
  now: FilterNowKey
  weekStartsOn: 0 | 1
  filters: WireFilters
  sort: { field: string; direction: 'asc' | 'desc' }
}> = [
  {
    name: 'defaults',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: defaults,
    sort: { field: 'dueDate', direction: 'asc' }
  },
  {
    name: 'overdue-high',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, dueDate: { type: 'overdue' }, priorities: ['urgent', 'high', 'low'] },
    sort: { field: 'priority', direction: 'asc' }
  },
  {
    name: 'this-week-sunday-start',
    now: 'sunday',
    weekStartsOn: 0,
    filters: { ...defaults, dueDate: { type: 'this-week' } },
    sort: { field: 'title', direction: 'asc' }
  },
  {
    name: 'this-week-monday-start',
    now: 'sunday',
    weekStartsOn: 1,
    filters: { ...defaults, dueDate: { type: 'this-week' } },
    sort: { field: 'title', direction: 'desc' }
  },
  {
    name: 'repeating-all-completion',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, repeatType: 'repeating', completion: 'all' },
    sort: { field: 'createdAt', direction: 'desc' }
  },
  {
    name: 'completed-with-subtask-parent',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, completion: 'completed' },
    sort: { field: 'completedAt', direction: 'asc' }
  },
  {
    name: 'archived-scope',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, completion: 'archived' },
    sort: { field: 'status', direction: 'asc' }
  },
  {
    name: 'search-tags-project',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, search: 'report', tags: ['work'], projectIds: ['p1'] },
    sort: { field: 'project', direction: 'asc' }
  },
  {
    name: 'status-and-time',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, statusIds: ['p1-todo', 'p1-doing'], hasTime: 'with-time' },
    sort: { field: 'dueDate', direction: 'desc' }
  },
  {
    name: 'no-due-without-time',
    now: 'monthEnd',
    weekStartsOn: 1,
    filters: { ...defaults, dueDate: { type: 'none' }, hasTime: 'without-time', completion: 'all' },
    sort: { field: 'folder', direction: 'asc' }
  },
  {
    name: 'custom-range',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: {
      ...defaults,
      dueDate: { type: 'custom', customStart: '2026-01-12', customEnd: '2026-01-15' }
    },
    sort: { field: 'note', direction: 'asc' }
  },
  {
    name: 'unknown-sort-field',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, completion: 'all' },
    sort: { field: 'bogus', direction: 'desc' }
  },
  {
    name: 'next-week-month',
    now: 'monthEnd',
    weekStartsOn: 1,
    filters: { ...defaults, dueDate: { type: 'this-month' } },
    sort: { field: 'dueDate', direction: 'asc' }
  }
]
