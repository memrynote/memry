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
    tags: ['home', 'İş'],
    createdAt: '2026-01-13T08:00:00'
  }),
  t('c', {
    title: 'Apple pie',
    priority: 'urgent',
    dueDate: '2026-01-14',
    dueTime: '08:30',
    statusId: 'p1-doing',
    tags: ['ΟΔΟΣ'],
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
  // Below the first level: matches on its own only through a narrowing filter.
  t('p', { title: 'grandchild of report', parentId: 'k', tags: ['deep'], priority: 'low' }),
  // A parent loop: the smaller id is the top-level task.
  t('q', { title: 'loop head', parentId: 'r', dueDate: '2026-01-16' }),
  t('r', { title: 'loop tail', parentId: 'q', tags: ['deep'] }),
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
  /** Advanced rules (`TaskFilterGroup`), untyped so cases can carry a newer build's rule. */
  expression?: unknown
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
    name: 'deep-match-keeps-ancestors',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, tags: ['deep'] },
    sort: { field: 'title', direction: 'asc' }
  },
  {
    name: 'blank-search-does-not-reach-deeper',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: { ...defaults, search: '  ' },
    sort: { field: 'title', direction: 'asc' }
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
  },
  {
    name: 'expression-or-group-and-not',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: {
      ...defaults,
      expression: {
        match: 'all',
        rules: [
          {
            match: 'any',
            rules: [
              { field: 'priority', op: 'any', values: ['urgent'] },
              { field: 'due', op: 'is', values: ['overdue'] }
            ]
          },
          { field: 'tags', op: 'none', values: ['home'] }
        ]
      }
    },
    sort: { field: 'title', direction: 'asc' }
  },
  {
    name: 'expression-with-chips-reaches-deeper',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: {
      ...defaults,
      projectIds: ['p1'],
      expression: { match: 'all', rules: [{ field: 'tags', op: 'any', values: ['deep'] }] }
    },
    sort: { field: 'title', direction: 'asc' }
  },
  {
    name: 'expression-only-skipped-rules',
    now: 'wednesday',
    weekStartsOn: 1,
    filters: {
      ...defaults,
      expression: {
        match: 'all',
        rules: [
          { field: 'priority', op: 'any', values: [] },
          { field: 'bogus', op: 'any', values: ['x'] }
        ]
      }
    },
    sort: { field: 'title', direction: 'asc' }
  }
]

/**
 * Advanced filter trees, each run task by task over every fixture task, with
 * and without the note index. Covers every field and operator, the three
 * group matches, nesting, and the rules a build skips: no value yet, a custom
 * range missing an end, and a field, operator or match a newer build wrote.
 */
export const EXPRESSION_CASES: ReadonlyArray<{
  name: string
  now: FilterNowKey
  weekStartsOn: 0 | 1
  expression: unknown
}> = [
  ...(
    [
      ['title-contains', { field: 'title', op: 'contains', values: ['REPORT'] }],
      ['title-not-contains', { field: 'title', op: 'notContains', values: ['report'] }],
      ['title-blank-skipped', { field: 'title', op: 'contains', values: ['  '] }],
      ['priority-any', { field: 'priority', op: 'any', values: ['urgent', 'high'] }],
      ['priority-none', { field: 'priority', op: 'none', values: ['none', 'low'] }],
      ['status-any', { field: 'status', op: 'any', values: ['p1-doing', 'p2-todo'] }],
      ['status-none', { field: 'status', op: 'none', values: ['p1-todo'] }],
      ['project-any', { field: 'project', op: 'any', values: ['p2', 'p3'] }],
      ['project-none', { field: 'project', op: 'none', values: ['p1'] }],
      ['tags-any-folded', { field: 'tags', op: 'any', values: ['WORK', 'iş'] }],
      ['tags-all', { field: 'tags', op: 'all', values: ['work', 'writing'] }],
      ['tags-none', { field: 'tags', op: 'none', values: ['work'] }],
      ['tags-empty', { field: 'tags', op: 'empty', values: [] }],
      ['tags-not-empty', { field: 'tags', op: 'notEmpty', values: [] }],
      ['due-is-multi', { field: 'due', op: 'is', values: ['overdue', 'today'] }],
      ['due-is-not-none', { field: 'due', op: 'isNot', values: ['none'] }],
      [
        'due-custom',
        {
          field: 'due',
          op: 'is',
          values: ['custom'],
          dueStart: '2026-01-13',
          dueEnd: '2026-01-15'
        }
      ],
      [
        'due-custom-missing-end-skipped',
        { field: 'due', op: 'is', values: ['custom'], dueStart: '2026-01-13', dueEnd: null }
      ],
      [
        'due-custom-bad-key-skipped',
        { field: 'due', op: 'is', values: ['custom'], dueStart: 'soon', dueEnd: '2026-01-15' }
      ],
      ['due-unknown-preset-skipped', { field: 'due', op: 'is', values: ['someday'] }],
      ['location-folder', { field: 'location', op: 'any', folderPaths: ['Acme'], noteIds: [] }],
      [
        'location-note-none',
        { field: 'location', op: 'none', folderPaths: [], noteIds: ['n-roadmap'] }
      ],
      ['location-empty-skipped', { field: 'location', op: 'any', folderPaths: [], noteIds: [] }],
      ['repeat-repeating', { field: 'repeat', op: 'is', values: ['repeating'] }],
      ['repeat-one-time', { field: 'repeat', op: 'is', values: ['one-time'] }],
      ['has-time-with', { field: 'hasTime', op: 'is', values: ['with-time'] }],
      ['has-time-without', { field: 'hasTime', op: 'is', values: ['without-time'] }],
      ['unknown-field-skipped', { field: 'estimate', op: 'any', values: ['x'] }],
      ['unknown-op-skipped', { field: 'priority', op: 'atLeast', values: ['high'] }],
      ['values-not-strings-skipped', { field: 'project', op: 'any', values: [1, null] }]
    ] as const
  ).map(([name, rule]) => ({
    name,
    now: 'wednesday' as const,
    weekStartsOn: 1 as const,
    expression: { match: 'all', rules: [rule] }
  })),
  {
    name: 'match-any',
    now: 'wednesday',
    weekStartsOn: 1,
    expression: {
      match: 'any',
      rules: [
        { field: 'priority', op: 'any', values: ['urgent'] },
        { field: 'repeat', op: 'is', values: ['repeating'] }
      ]
    }
  },
  {
    name: 'match-none',
    now: 'wednesday',
    weekStartsOn: 1,
    expression: {
      match: 'none',
      rules: [
        { field: 'project', op: 'any', values: ['p1'] },
        { field: 'tags', op: 'empty', values: [] }
      ]
    }
  },
  {
    name: 'nested-groups',
    now: 'sunday',
    weekStartsOn: 0,
    expression: {
      match: 'all',
      rules: [
        { field: 'due', op: 'isNot', values: ['none'] },
        {
          match: 'any',
          rules: [
            { field: 'due', op: 'is', values: ['this-week'] },
            {
              match: 'none',
              rules: [{ field: 'priority', op: 'any', values: ['none', 'low', 'medium'] }]
            }
          ]
        }
      ]
    }
  },
  {
    name: 'skipped-group-drops-out',
    now: 'wednesday',
    weekStartsOn: 1,
    expression: {
      match: 'all',
      rules: [
        { field: 'priority', op: 'any', values: ['high'] },
        { match: 'none', rules: [{ field: 'status', op: 'any', values: [] }] }
      ]
    }
  },
  {
    name: 'unknown-match-skipped',
    now: 'wednesday',
    weekStartsOn: 1,
    expression: {
      match: 'all',
      rules: [
        { field: 'priority', op: 'any', values: ['high'] },
        { match: 'most', rules: [{ field: 'priority', op: 'any', values: ['low'] }] }
      ]
    }
  },
  {
    name: 'empty-root',
    now: 'wednesday',
    weekStartsOn: 1,
    expression: { match: 'all', rules: [] }
  },
  {
    name: 'unknown-root-match',
    now: 'wednesday',
    weekStartsOn: 1,
    expression: { match: 'most', rules: [{ field: 'priority', op: 'any', values: ['high'] }] }
  }
]

/**
 * Location filter options (`buildTaskLocationOptions`). Its own small vault:
 * nested folders, a root note, a task linked to a note without being typed in
 * it, a subtask that is the only task in its folder, and links to notes the
 * index does not know. `infra-2` sorts before `Infra` (`-` < `/`), and a
 * folder's notes sort before its subfolders.
 */
export const LOCATION_NOTES = [
  { id: 'roof', title: 'Roof', folderPath: 'Infra/House/Stage 1' },
  { id: 'stage-notes', title: 'Stage notes', folderPath: 'Infra/House/Stage 1' },
  { id: 'brief', title: 'Brief', folderPath: 'Infra/House' },
  { id: 'apple', title: 'apple', folderPath: 'Infra/House' },
  { id: 'inbox', title: 'Inbox', folderPath: '' },
  { id: 'empty', title: 'Empty', folderPath: 'Infra' },
  { id: 'zed', title: 'Zed', folderPath: 'infra-2' },
  { id: 'old', title: 'Old', folderPath: 'Archive' }
] as const

export interface WireLocationTask {
  id: string
  parentId: string | null
  sourceNoteId: string | null
  linkedNoteIds: string[]
}

const lt = (id: string, fields: Partial<Omit<WireLocationTask, 'id'>> = {}): WireLocationTask => ({
  id,
  parentId: null,
  sourceNoteId: null,
  linkedNoteIds: [],
  ...fields
})

export const LOCATION_TASKS: readonly WireLocationTask[] = [
  lt('t1', { sourceNoteId: 'roof' }),
  lt('t2', { sourceNoteId: 'roof' }),
  lt('t3', { sourceNoteId: 'brief', linkedNoteIds: ['roof'] }),
  lt('sub', { sourceNoteId: 'old', parentId: 't3' }),
  lt('t4', { sourceNoteId: 'inbox' }),
  lt('t5', { linkedNoteIds: ['apple', 'ghost'] }),
  lt('t6', { sourceNoteId: 'zed', linkedNoteIds: ['zed'] }),
  lt('t7', { sourceNoteId: 'ghost' })
]

const SELECTED_GONE = {
  folderPaths: ['Infra/House', 'Gone/Deep'],
  noteIds: ['empty', 'ghost', 'old', 'stage-notes']
}

export const LOCATION_CASES: ReadonlyArray<{
  name: string
  selected: { folderPaths: string[]; noteIds: string[] }
  query: string
}> = [
  { name: 'tree', selected: { folderPaths: [], noteIds: [] }, query: '' },
  { name: 'selected-kept', selected: SELECTED_GONE, query: '' },
  { name: 'search-folder', selected: { folderPaths: [], noteIds: [] }, query: 'stage' },
  { name: 'search-trimmed-folded', selected: SELECTED_GONE, query: '  E ' },
  { name: 'search-note', selected: { folderPaths: [], noteIds: [] }, query: 'ROOF' },
  { name: 'search-blank', selected: { folderPaths: [], noteIds: [] }, query: '   ' },
  { name: 'search-miss', selected: SELECTED_GONE, query: 'zzz' }
]
