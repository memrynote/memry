/**
 * Recurrence and due-window inputs for the `task-parsing` class. Inputs only.
 *
 * Configs use the **wire** shape (`use-task-queries.ts` `toServiceRepeatConfig`):
 * `endDate` a `YYYY-MM-DD` key, `createdAt` a full ISO string.
 */

export interface WireRepeat {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  daysOfWeek?: number[]
  monthlyType?: 'dayOfMonth' | 'weekPattern'
  dayOfMonth?: number
  weekOfMonth?: number
  dayOfWeekForMonth?: number
  endType: 'never' | 'date' | 'count'
  endDate?: string | null
  endCount?: number
  completedCount: number
  createdAt: string
}

const base = { endType: 'never', completedCount: 0, createdAt: '2026-01-01T00:00:00.000Z' } as const

export const REPEAT_CONFIGS: Record<string, WireRepeat> = {
  daily: { ...base, frequency: 'daily', interval: 1 },
  every3Days: { ...base, frequency: 'daily', interval: 3 },
  weekly: { ...base, frequency: 'weekly', interval: 1 },
  biweekly: { ...base, frequency: 'weekly', interval: 2 },
  weekdays: { ...base, frequency: 'weekly', interval: 1, daysOfWeek: [1, 2, 3, 4, 5] },
  monWedFri: { ...base, frequency: 'weekly', interval: 1, daysOfWeek: [5, 1, 3] },
  everyOtherTue: { ...base, frequency: 'weekly', interval: 2, daysOfWeek: [2] },
  sundays: { ...base, frequency: 'weekly', interval: 1, daysOfWeek: [0] },
  weekend3: { ...base, frequency: 'weekly', interval: 3, daysOfWeek: [0, 6] },
  monthly31: {
    ...base,
    frequency: 'monthly',
    interval: 1,
    monthlyType: 'dayOfMonth',
    dayOfMonth: 31
  },
  monthly15: {
    ...base,
    frequency: 'monthly',
    interval: 1,
    monthlyType: 'dayOfMonth',
    dayOfMonth: 15
  },
  bimonthly30: {
    ...base,
    frequency: 'monthly',
    interval: 2,
    monthlyType: 'dayOfMonth',
    dayOfMonth: 30
  },
  monthlyPlain: { ...base, frequency: 'monthly', interval: 1 },
  firstMonday: {
    ...base,
    frequency: 'monthly',
    interval: 1,
    monthlyType: 'weekPattern',
    weekOfMonth: 1,
    dayOfWeekForMonth: 1
  },
  thirdFriday: {
    ...base,
    frequency: 'monthly',
    interval: 1,
    monthlyType: 'weekPattern',
    weekOfMonth: 3,
    dayOfWeekForMonth: 5
  },
  lastSunday: {
    ...base,
    frequency: 'monthly',
    interval: 1,
    monthlyType: 'weekPattern',
    weekOfMonth: 5,
    dayOfWeekForMonth: 0
  },
  lastFridayQuarterly: {
    ...base,
    frequency: 'monthly',
    interval: 3,
    monthlyType: 'weekPattern',
    weekOfMonth: 5,
    dayOfWeekForMonth: 5
  },
  yearly: { ...base, frequency: 'yearly', interval: 1 },
  everyOtherYear: { ...base, frequency: 'yearly', interval: 2 },
  dailyUntil: { ...base, frequency: 'daily', interval: 1, endType: 'date', endDate: '2026-01-20' },
  weeklyUntil: {
    ...base,
    frequency: 'weekly',
    interval: 1,
    endType: 'date',
    endDate: '2026-02-01'
  },
  dailyCount3: { ...base, frequency: 'daily', interval: 1, endType: 'count', endCount: 3 },
  dailyCount3Done2: {
    ...base,
    frequency: 'daily',
    interval: 1,
    endType: 'count',
    endCount: 3,
    completedCount: 2
  },
  dailyCount3Done3: {
    ...base,
    frequency: 'daily',
    interval: 1,
    endType: 'count',
    endCount: 3,
    completedCount: 3
  },
  countZero: { ...base, frequency: 'daily', interval: 1, endType: 'count', endCount: 0 },
  dateNull: { ...base, frequency: 'daily', interval: 1, endType: 'date', endDate: null }
}

/** Dates each config's next occurrence is computed from. */
export const NEXT_FROM_DATES: readonly string[] = [
  '2026-01-14', // Wednesday
  '2026-01-17', // Saturday
  '2026-01-18', // Sunday
  '2026-01-31', // month end
  '2026-02-28',
  '2024-02-29', // leap day
  '2026-12-31', // year end
  '2026-01-19' // after the dailyUntil end
]

/** `completeRepeatingTask` cases: config, due date, repeatFrom, completion instant. */
export const COMPLETE_CASES: ReadonlyArray<{
  config: string
  due: string
  repeatFrom: 'due' | 'completion' | null
  completedAt: string
}> = [
  { config: 'daily', due: '2026-01-12', repeatFrom: null, completedAt: '2026-01-15T10:00:00' },
  { config: 'daily', due: '2026-01-12', repeatFrom: 'due', completedAt: '2026-01-15T10:00:00' },
  {
    config: 'daily',
    due: '2026-01-12',
    repeatFrom: 'completion',
    completedAt: '2026-01-15T22:30:00'
  },
  {
    config: 'weekdays',
    due: '2026-01-16',
    repeatFrom: 'completion',
    completedAt: '2026-01-17T09:00:00'
  },
  { config: 'monthly31', due: '2026-01-31', repeatFrom: null, completedAt: '2026-01-31T09:00:00' },
  { config: 'dailyUntil', due: '2026-01-19', repeatFrom: null, completedAt: '2026-01-19T09:00:00' },
  { config: 'dailyUntil', due: '2026-01-20', repeatFrom: null, completedAt: '2026-01-20T09:00:00' },
  { config: 'dailyUntil', due: '2026-01-18', repeatFrom: null, completedAt: '2026-01-21T09:00:00' },
  {
    config: 'dailyCount3',
    due: '2026-01-14',
    repeatFrom: null,
    completedAt: '2026-01-14T09:00:00'
  },
  {
    config: 'dailyCount3Done2',
    due: '2026-01-14',
    repeatFrom: null,
    completedAt: '2026-01-14T09:00:00'
  },
  {
    config: 'dailyCount3Done3',
    due: '2026-01-14',
    repeatFrom: null,
    completedAt: '2026-01-14T09:00:00'
  },
  { config: 'yearly', due: '2024-02-29', repeatFrom: null, completedAt: '2024-02-29T09:00:00' },
  {
    config: 'lastSunday',
    due: '2026-01-25',
    repeatFrom: 'completion',
    completedAt: '2026-02-03T09:00:00'
  }
]

/** One due-window fixture: projects with typed statuses, and tasks. */
export const WINDOW_PROJECTS = [
  {
    id: 'p1',
    statuses: [
      { id: 'p1-todo', type: 'todo' },
      { id: 'p1-doing', type: 'in_progress' },
      { id: 'p1-done', type: 'done' }
    ]
  },
  {
    id: 'p2',
    statuses: [
      { id: 'p2-todo', type: 'todo' },
      { id: 'p2-done', type: 'done' }
    ]
  }
] as const

export interface WindowTask {
  id: string
  projectId: string
  statusId: string
  parentId: string | null
  dueDate: string | null
  startDate: string | null
  completedAt: string | null
  archivedAt: string | null
}

const t = (id: string, fields: Partial<Omit<WindowTask, 'id'>> = {}): WindowTask => ({
  id,
  projectId: 'p1',
  statusId: 'p1-todo',
  parentId: null,
  dueDate: null,
  startDate: null,
  completedAt: null,
  archivedAt: null,
  ...fields
})

/** Evaluated at `NOWS.wednesday` (2026-01-14) and `NOWS.sunday` (2026-01-18). */
export const WINDOW_TASKS: readonly WindowTask[] = [
  t('undated'),
  t('overdue-far', { dueDate: '2025-12-01' }),
  t('overdue-yesterday', { dueDate: '2026-01-13' }),
  t('due-today', { dueDate: '2026-01-14' }),
  t('due-today-p2', { projectId: 'p2', statusId: 'p2-todo', dueDate: '2026-01-14' }),
  t('due-tomorrow', { dueDate: '2026-01-15' }),
  t('due-plus6', { dueDate: '2026-01-20' }),
  t('due-plus7', { dueDate: '2026-01-21' }),
  t('due-plus30', { dueDate: '2026-02-13' }),
  t('in-progress-today', { statusId: 'p1-doing', dueDate: '2026-01-14' }),
  t('done-today', {
    statusId: 'p1-done',
    dueDate: '2026-01-14',
    completedAt: '2026-01-14T09:00:00'
  }),
  t('done-status-no-completedAt', { statusId: 'p1-done', dueDate: '2026-01-15' }),
  t('completedAt-but-todo', { dueDate: '2026-01-16', completedAt: '2026-01-13T09:00:00' }),
  t('archived-today', { dueDate: '2026-01-14', archivedAt: '2026-01-14T08:00:00' }),
  t('archived-done', {
    statusId: 'p1-done',
    dueDate: '2026-01-14',
    completedAt: '2026-01-14T07:00:00',
    archivedAt: '2026-01-14T08:00:00'
  }),
  t('started-no-due', { startDate: '2026-01-10' }),
  t('started-future-due', { startDate: '2026-01-14', dueDate: '2026-03-01' }),
  t('started-overdue', { startDate: '2026-01-01', dueDate: '2026-01-05' }),
  t('starts-tomorrow', { startDate: '2026-01-15' }),
  t('unknown-status', { statusId: 'gone', dueDate: '2026-01-14' }),
  t('unknown-project', { projectId: 'nope', statusId: 'nope-todo', dueDate: '2026-01-15' }),
  t('parent-today', { dueDate: '2026-01-14' }),
  t('sub-of-parent-today', { parentId: 'parent-today' }),
  t('sub-done-of-parent-today', {
    parentId: 'parent-today',
    statusId: 'p1-done',
    completedAt: '2026-01-14T10:00:00'
  }),
  t('sub-archived-of-parent-today', {
    parentId: 'parent-today',
    archivedAt: '2026-01-13T10:00:00'
  }),
  t('sub-due-today-of-undated', { parentId: 'undated', dueDate: '2026-01-14' }),
  t('parent-p2-tomorrow', { projectId: 'p2', statusId: 'p2-todo', dueDate: '2026-01-15' }),
  t('sub-of-p2-parent', { projectId: 'p2', statusId: 'p2-todo', parentId: 'parent-p2-tomorrow' }),
  t('done-sunday', {
    statusId: 'p1-done',
    dueDate: '2026-01-18',
    completedAt: '2026-01-18T08:00:00'
  }),
  t('due-sunday', { dueDate: '2026-01-18' }),
  t('due-saturday', { dueDate: '2026-01-17' }),
  t('timestamp-due', { dueDate: '2026-01-14T09:00:00.000Z' })
]

export const VIEW_IDS = [
  'all',
  'today',
  'upcoming',
  'tomorrow',
  'week',
  'completed',
  'bogus'
] as const
