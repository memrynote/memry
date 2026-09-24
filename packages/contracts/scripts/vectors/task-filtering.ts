/**
 * Class: task filtering (`task-filtering.json`) — spec 004 TP015.
 *
 * Every `TaskFilters` dimension, every sort field × direction, and the group
 * output of every grouping mode, recorded from the real
 * `@memry/domain-tasks/filtering` functions the desktop renderer runs. Groups
 * carry label **keys**, never display text. An unknown sort field (a saved
 * filter from a newer build) must leave the order untouched and yield no groups.
 *
 * Determinism: TZ pinned to UTC for the build; `now` and the week start are
 * explicit. Titles and project names order by `localeCompare` (ICU root).
 */
import {
  applyFiltersAndSort,
  countActiveFilters,
  filterByCompletion,
  filterByDueDateRange,
  filterByHasTime,
  filterByPriorities,
  filterByProjects,
  filterByRepeatType,
  filterBySearch,
  filterByStatuses,
  filterByTags,
  groupTasksForSort,
  hasActiveFilters,
  sortTasksAdvanced,
  type DueDateFilter,
  type FilterTask,
  type SortField,
  type TaskFilters,
  type TaskNoteInfo,
  type TaskSort
} from '../../../domain-tasks/src/filtering/index.ts'
import { parseDateKey } from '../../../domain-tasks/src/parsing/index.ts'
import {
  FILTER_CASES,
  FILTER_NOTES,
  FILTER_NOWS,
  FILTER_PROJECTS,
  FILTER_TASKS,
  type WireDueDateFilter,
  type WireFilters,
  type WireTask
} from './task-filtering-cases'

const SORT_FIELDS: readonly string[] = [
  'dueDate',
  'priority',
  'status',
  'createdAt',
  'title',
  'project',
  'completedAt',
  'folder',
  'note',
  'bogus'
]

const DUE_TYPES: readonly WireDueDateFilter[] = [
  { type: 'any' },
  { type: 'none' },
  { type: 'overdue' },
  { type: 'today' },
  { type: 'tomorrow' },
  { type: 'this-week' },
  { type: 'next-week' },
  { type: 'this-month' },
  { type: 'custom', customStart: '2026-01-15', customEnd: '2026-01-20' },
  { type: 'custom', customStart: '2026-01-15', customEnd: null },
  { type: 'bogus' }
]

const toTask = (task: WireTask): FilterTask => ({
  ...task,
  dueDate: task.dueDate === null ? null : parseDateKey(task.dueDate),
  createdAt: new Date(task.createdAt),
  completedAt: task.completedAt === null ? null : new Date(task.completedAt),
  archivedAt: task.archivedAt === null ? null : new Date(task.archivedAt)
})

const toDue = (wire: WireDueDateFilter): DueDateFilter =>
  ({
    type: wire.type,
    customStart: wire.customStart ? parseDateKey(wire.customStart) : null,
    customEnd: wire.customEnd ? parseDateKey(wire.customEnd) : null
  }) as DueDateFilter

const toFilters = (wire: WireFilters): TaskFilters => ({ ...wire, dueDate: toDue(wire.dueDate) })

const ids = (list: readonly FilterTask[]): string[] => list.map((task) => task.id)

function build() {
  const tasks = FILTER_TASKS.map(toTask)
  const noteIndex = new Map<string, TaskNoteInfo>(FILTER_NOTES.map((note) => [note.id, note]))

  const dimensions = {
    search: ['', '  ', 'report', 'REPORT', 'draft', 'zzz', 'Ünï'].map((query) => ({
      query,
      expected: ids(filterBySearch(tasks, query))
    })),
    projects: [[], ['p1'], ['p1', 'p2'], ['nope']].map((projectIds) => ({
      projectIds,
      expected: ids(filterByProjects(tasks, projectIds))
    })),
    priorities: [[], ['urgent'], ['high', 'none'], ['low', 'medium']].map((priorities) => ({
      priorities,
      expected: ids(filterByPriorities(tasks, priorities as TaskFilters['priorities']))
    })),
    tags: [[], ['work'], ['WORK', 'home'], ['missing']].map((tags) => ({
      tags,
      expected: ids(filterByTags(tasks, tags))
    })),
    statuses: [[], ['p1-doing'], ['p1-todo', 'p2-done']].map((statusIds) => ({
      statusIds,
      expected: ids(filterByStatuses(tasks, statusIds))
    })),
    completion: ['active', 'completed', 'all', 'archived', 'bogus'].map((completion) => ({
      completion,
      expected: ids(
        filterByCompletion(tasks, completion as TaskFilters['completion'], FILTER_PROJECTS)
      )
    })),
    repeatType: ['all', 'repeating', 'one-time', 'bogus'].map((repeatType) => ({
      repeatType,
      expected: ids(filterByRepeatType(tasks, repeatType as TaskFilters['repeatType']))
    })),
    hasTime: ['all', 'with-time', 'without-time', 'bogus'].map((hasTime) => ({
      hasTime,
      expected: ids(filterByHasTime(tasks, hasTime as TaskFilters['hasTime']))
    })),
    dueDate: Object.entries(FILTER_NOWS).flatMap(([nowKey, now]) =>
      ([0, 1] as const).flatMap((weekStartsOn) =>
        DUE_TYPES.map((filter) => ({
          now,
          nowKey,
          weekStartsOn,
          filter,
          expected: ids(filterByDueDateRange(tasks, toDue(filter), new Date(now), weekStartsOn))
        }))
      )
    )
  }

  const sorts = SORT_FIELDS.flatMap((field) =>
    (['asc', 'desc'] as const).map((direction) => ({
      field,
      direction,
      expected: ids(sortTasksAdvanced(tasks, { field, direction } as TaskSort, FILTER_PROJECTS))
    }))
  )

  const groups = Object.entries(FILTER_NOWS).flatMap(([nowKey, now]) =>
    SORT_FIELDS.flatMap((field) =>
      (['asc', 'desc'] as const).flatMap((direction) =>
        [true, false].map((withNotes) => ({
          now,
          nowKey,
          field,
          direction,
          withNotes,
          expected: groupTasksForSort(
            tasks.filter((task) => task.parentId === null),
            field as SortField,
            direction,
            FILTER_PROJECTS,
            new Date(now),
            withNotes ? noteIndex : undefined
          ).map((group) => ({
            key: group.key,
            labelKey: group.labelKey,
            name: group.name,
            color: group.color ?? null,
            variant: group.variant ?? null,
            taskIds: ids(group.tasks)
          }))
        }))
      )
    )
  )

  const applied = FILTER_CASES.map((c) => ({
    ...c,
    expected: {
      taskIds: ids(
        applyFiltersAndSort(
          tasks,
          toFilters(c.filters),
          c.sort as TaskSort,
          FILTER_PROJECTS,
          new Date(FILTER_NOWS[c.now]),
          c.weekStartsOn
        )
      ),
      hasActiveFilters: hasActiveFilters(toFilters(c.filters)),
      countActiveFilters: countActiveFilters(toFilters(c.filters))
    }
  }))

  return {
    meta: {
      spec: '004-ios-tasks-parity',
      source: 'packages/domain-tasks/src/filtering',
      timeZone: 'UTC',
      dates:
        'dueDate and custom range are YYYY-MM-DD local keys; instants local YYYY-MM-DDTHH:MM:SS',
      collation: 'title/project/folder/note order uses String.prototype.localeCompare (ICU root)'
    },
    nows: FILTER_NOWS,
    projects: FILTER_PROJECTS,
    notes: FILTER_NOTES,
    tasks: FILTER_TASKS,
    dimensions,
    sorts,
    groups,
    applied
  }
}

export function buildTaskFiltering(): unknown {
  const previous = process.env.TZ
  process.env.TZ = 'UTC'
  try {
    return build()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}
