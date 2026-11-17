/**
 * Class: task completion spawn (`task-completion-spawn.json`) — #3538, spec 004 D3.
 *
 * Completing an open repeating task closes it and, while the series runs,
 * creates the next occurrence. Each row is recorded from the production
 * `rollRepeatingSeries` (`packages/domain-tasks/src/repeat-completion.ts`),
 * which calls `completeRepeatingTask`, over an in-memory repository: the
 * closed occurrence's `repeatConfig`, and the next occurrence's due date,
 * `completedCount` and copied fields.
 *
 * `nextId` has no TypeScript production path: desktop used random ids. It is
 * the chapter 13 §13.7.3 rule, `sha256("<taskId> spawn <completedCount>")`,
 * first 21 lowercase hex characters, computed here so the Rust core is held
 * to the chapter.
 *
 * Determinism: the process time zone is pinned to UTC for the build. Rows
 * marked `tzSensitive` give another answer under desktop west of UTC, which
 * reads the end date as UTC midnight; the Rust core reads it as the end day's
 * local midnight in every zone (chapter 13 §13.7.3).
 */
import { createHash } from 'node:crypto'

import type { TasksCommandRepository } from '../../../domain-tasks/src/commands-types.ts'
import { rollRepeatingSeries } from '../../../domain-tasks/src/repeat-completion.ts'
import type { RepeatConfig, Status, Task } from '../../../domain-tasks/src/types.ts'

const PROJECT_ID = 'p1'

const STATUSES: Status[] = [
  { id: 'p1-todo', name: 'To Do', position: 0, isDefault: true, isDone: false },
  { id: 'p1-doing', name: 'In Progress', position: 1, isDefault: false, isDone: false },
  { id: 'p1-done', name: 'Done', position: 2, isDefault: false, isDone: true }
].map((s) => ({
  ...s,
  projectId: PROJECT_ID,
  color: '#6b7280',
  createdAt: '2026-01-01T00:00:00.000Z'
}))

const LINKS = { tags: ['home'], linkedNoteIds: ['note-1'], linkedCanvasIds: ['canvas-1'] }
const LINK_KEYS = ['tags', 'linkedNoteIds', 'linkedCanvasIds'] as const

const base = { endType: 'never', completedCount: 0, createdAt: '2026-01-01T00:00:00.000Z' } as const

interface SpawnCase {
  name: string
  config: RepeatConfig
  due: string
  completedAt: string
  repeatFrom?: 'due' | 'completion' | null
  task?: Partial<Task>
  tzSensitive?: boolean
}

const daily: RepeatConfig = { ...base, frequency: 'daily', interval: 1 }
const dateEnd = (endDate: string): RepeatConfig => ({ ...daily, endType: 'date', endDate })
const counted = (endCount: number, completedCount: number): RepeatConfig => ({
  ...daily,
  endType: 'count',
  endCount,
  completedCount
})

/** The 18 rows of #3538's golden spawn table. Completion instants are local wall clock. */
const CASES: SpawnCase[] = [
  {
    name: 'daily-due-anchor',
    config: daily,
    due: '2026-03-10',
    completedAt: '2026-03-12T09:30:00',
    repeatFrom: 'due',
    task: { startDate: '2026-03-08' }
  },
  {
    name: 'daily-completion-anchor',
    config: daily,
    due: '2026-03-10',
    completedAt: '2026-03-12T09:30:00',
    repeatFrom: 'completion',
    task: { parentId: 'parent-1' }
  },
  {
    name: 'daily-null-anchor-interval-2',
    config: { ...daily, interval: 2 },
    due: '2026-03-10',
    completedAt: '2026-03-12T09:30:00'
  },
  {
    name: 'weekly-days-5-1-3',
    config: { ...base, frequency: 'weekly', interval: 1, daysOfWeek: [5, 1, 3] },
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00'
  },
  {
    name: 'weekly-interval-2-day-2',
    config: { ...base, frequency: 'weekly', interval: 2, daysOfWeek: [2] },
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00'
  },
  {
    name: 'weekly-no-days-completion-anchor',
    config: { ...base, frequency: 'weekly', interval: 2 },
    due: '2026-03-10',
    completedAt: '2026-03-14T09:30:00',
    repeatFrom: 'completion'
  },
  {
    name: 'monthly-day-31',
    config: {
      ...base,
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: 31
    },
    due: '2026-01-31',
    completedAt: '2026-01-31T09:30:00'
  },
  {
    name: 'monthly-without-type',
    config: { ...base, frequency: 'monthly', interval: 1 },
    due: '2026-01-31',
    completedAt: '2026-01-31T09:30:00'
  },
  {
    name: 'monthly-second-tuesday',
    config: {
      ...base,
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'weekPattern',
      weekOfMonth: 2,
      dayOfWeekForMonth: 2
    },
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00'
  },
  {
    name: 'monthly-last-friday',
    config: {
      ...base,
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'weekPattern',
      weekOfMonth: 5,
      dayOfWeekForMonth: 5
    },
    due: '2026-03-27',
    completedAt: '2026-03-27T09:30:00',
    task: { startDate: '2026-03-25' }
  },
  {
    name: 'yearly-leap-day',
    config: { ...base, frequency: 'yearly', interval: 1 },
    due: '2028-02-29',
    completedAt: '2028-02-29T09:30:00'
  },
  {
    name: 'count-3-done-2',
    config: counted(3, 2),
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00'
  },
  {
    name: 'count-3-done-1',
    config: counted(3, 1),
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00'
  },
  {
    name: 'count-0-done-5',
    config: counted(0, 5),
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00'
  },
  {
    name: 'end-date-equals-next-day',
    config: dateEnd('2026-03-11'),
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00',
    tzSensitive: true
  },
  {
    name: 'end-date-before-next-day',
    config: dateEnd('2026-03-10'),
    due: '2026-03-10',
    completedAt: '2026-03-10T09:30:00',
    tzSensitive: true
  },
  {
    name: 'monthly-completion-anchor',
    config: {
      ...base,
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: 15
    },
    due: '2026-02-15',
    completedAt: '2026-03-02T09:30:00',
    repeatFrom: 'completion'
  },
  {
    name: 'daily-across-2026-03-08',
    config: daily,
    due: '2026-03-07',
    completedAt: '2026-03-07T09:30:00'
  }
]

/** The fields the next occurrence carries over from the closed one. */
const COPIED = [
  'title',
  'description',
  'projectId',
  'parentId',
  'priority',
  'dueTime',
  'durationMinutes',
  'startDate',
  'repeatFrom',
  'tags',
  'linkedNoteIds',
  'linkedCanvasIds',
  'fields'
] as const

function taskFor(c: SpawnCase): Task {
  return {
    id: `spawn-${c.name}`,
    projectId: PROJECT_ID,
    statusId: 'p1-doing',
    parentId: null,
    title: 'Water the plants',
    description: 'Front porch',
    priority: 2,
    position: 0,
    dueDate: c.due,
    dueTime: '08:00',
    durationMinutes: 30,
    startDate: null,
    repeatConfig: c.config,
    repeatFrom: c.repeatFrom ?? null,
    sourceNoteId: 'note-src',
    completedAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    ...LINKS,
    fields: { 'Follow up': '2026-05-14' },
    ...c.task
  }
}

/** §13.7.3: the id of the occurrence that brings the series to `completedCount`. */
function nextId(taskId: string, completedCount: number): string {
  return createHash('sha256').update(`${taskId} spawn ${completedCount}`).digest('hex').slice(0, 21)
}

/** What one production roll writes, read back from an in-memory repository. */
function roll(before: Task, completedAt: string) {
  const tasks = new Map<string, Task>([[before.id, before]])
  const links = new Map<string, Record<keyof typeof LINKS, string[]>>([[before.id, { ...LINKS }]])
  let spawned = ''
  const setLinks = (id: string, key: keyof typeof LINKS, ids: string[]) => {
    const current = links.get(id)
    if (current) links.set(id, { ...current, [key]: ids })
  }
  const implemented: Partial<TasksCommandRepository> = {
    listStatuses: () => STATUSES,
    getNextTaskPosition: () => 0,
    updateTask: (id, updates) => {
      const task = tasks.get(id)
      if (!task) return undefined
      const next = { ...task, ...updates }
      tasks.set(id, next)
      return next
    },
    createTask: (task) => {
      tasks.set(task.id, task)
      links.set(task.id, { tags: [], linkedNoteIds: [], linkedCanvasIds: [] })
      return task
    },
    getTaskTags: (id) => links.get(id)?.tags ?? [],
    getTaskNoteIds: (id) => links.get(id)?.linkedNoteIds ?? [],
    getTaskCanvasIds: (id) => links.get(id)?.linkedCanvasIds ?? [],
    setTaskTags: (id, tags) => setLinks(id, 'tags', tags),
    setTaskNotes: (id, ids) => setLinks(id, 'linkedNoteIds', ids),
    setTaskCanvases: (id, ids) => setLinks(id, 'linkedCanvasIds', ids)
  }
  const methods: Record<string, unknown> = { ...implemented }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Proxy throws on any method it lacks, so a new call fails the build instead of reading undefined
  const repository = new Proxy(methods, {
    get(target, key: string) {
      if (Object.hasOwn(target, key)) return target[key]
      throw new Error(`rollRepeatingSeries called repository.${key}, which the generator lacks`)
    }
  }) as TasksCommandRepository
  const result = rollRepeatingSeries(
    repository,
    () => {
      spawned = nextId(before.id, (before.repeatConfig?.completedCount ?? 0) + 1)
      return spawned
    },
    before,
    completedAt
  )
  const closed = tasks.get(before.id)
  const next = result.nextOccurrence ? tasks.get(result.nextOccurrence.id) : undefined
  return {
    closedRepeatConfig: closed?.repeatConfig ?? null,
    next:
      next && result.nextOccurrence
        ? {
            id: spawned,
            dueDate: result.nextOccurrence.dueDate,
            statusId: next.statusId,
            completedCount: next.repeatConfig?.completedCount ?? null,
            repeatConfig: next.repeatConfig,
            sourceNoteId: next.sourceNoteId,
            copied: Object.fromEntries(
              COPIED.map((key) => {
                const linkKey = LINK_KEYS.find((k) => k === key)
                const value = linkKey ? links.get(next.id)?.[linkKey] : next[key]
                return [key, value ?? null]
              })
            )
          }
        : null
  }
}

export function buildTaskCompletionSpawn(): unknown {
  const previous = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    return {
      meta: {
        spec: '004-ios-tasks-parity',
        issue: '#3538',
        source: 'packages/domain-tasks/src/repeat-completion.ts rollRepeatingSeries',
        timeZone: 'UTC',
        dates: 'YYYY-MM-DD local calendar keys; completedAt is local YYYY-MM-DDTHH:MM:SS',
        nextId: 'chapter 13 §13.7.3: sha256("<taskId> spawn <completedCount>") hex, first 21',
        fields: 'plain values (desktop Task.fields); the wire carries them versioned (§13.7.3.1)',
        caseCount: CASES.length
      },
      statuses: STATUSES,
      copiedFields: COPIED,
      cases: CASES.map((c) => {
        const task = taskFor(c)
        return {
          name: c.name,
          tzSensitive: c.tzSensitive ?? false,
          task: { ...task },
          completedAt: c.completedAt,
          expected: roll(task, c.completedAt)
        }
      })
    }
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}
