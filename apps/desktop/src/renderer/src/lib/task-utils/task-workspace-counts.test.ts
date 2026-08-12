/**
 * getTaskWorkspaceCounts — the single-pass replacement for "call getFilteredTasks
 * once per sidebar view, then filter the task list once per project".
 *
 * A badge that stops counting a task is indistinguishable from a lost task, so
 * every assertion here is pinned against `getFilteredTasks` itself: whatever the
 * real filter would show, the badge must show. The mutation matrix at the bottom
 * walks every input that has to invalidate the counts.
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '@/data/task-model'
import type { Project, StatusType } from '@/data/tasks-data'
import { getFilteredTasks, getTaskWorkspaceCounts } from '.'
import { addDays, startOfDay } from './task-date-utils'

const ALL_VIEW_IDS = [
  'all',
  'today',
  'upcoming',
  'tomorrow',
  'week',
  'completed',
  'some-future-view'
] as const

const TODAY = startOfDay(new Date())

const createTask = (overrides: Partial<Task> & { id: string }): Task => ({
  title: overrides.id,
  description: '',
  projectId: 'project-a',
  statusId: 'todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: TODAY,
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const createProject = (id: string, statuses: { id: string; type: StatusType }[]): Project => ({
  id,
  name: id,
  description: '',
  icon: 'folder',
  color: '#000000',
  statuses: statuses.map((status, order) => ({
    id: status.id,
    name: status.id,
    color: '#000000',
    type: status.type,
    order
  })),
  isDefault: false,
  isArchived: false,
  createdAt: TODAY,
  taskCount: 0
})

const projects: Project[] = [
  createProject('project-a', [
    { id: 'todo', type: 'todo' },
    { id: 'doing', type: 'in_progress' },
    { id: 'done', type: 'done' }
  ]),
  createProject('project-b', [
    { id: 'todo', type: 'todo' },
    { id: 'done', type: 'done' }
  ])
]

/**
 * Covers every branch the counts depend on: both projects, all three status
 * types, overdue / today / tomorrow / this-week / next-week / no due date,
 * subtasks under open and under completed parents, an archived task, a task
 * pointing at a project that no longer exists, and a task whose status id is not
 * in its project (both of which the filter treats as incomplete).
 */
const baselineTasks = (): Task[] => [
  createTask({ id: 'overdue', dueDate: addDays(TODAY, -3) }),
  createTask({ id: 'overdue-sub', parentId: 'overdue' }),
  createTask({ id: 'due-today', dueDate: TODAY, statusId: 'doing' }),
  createTask({ id: 'due-tomorrow', dueDate: addDays(TODAY, 1) }),
  createTask({ id: 'due-in-3', dueDate: addDays(TODAY, 3) }),
  createTask({ id: 'due-in-20', dueDate: addDays(TODAY, 20) }),
  createTask({ id: 'no-due-date' }),
  createTask({ id: 'done-a', statusId: 'done' }),
  createTask({ id: 'done-a-sub', statusId: 'todo', parentId: 'done-a' }),
  createTask({ id: 'b-open', projectId: 'project-b', dueDate: TODAY }),
  createTask({ id: 'b-done', projectId: 'project-b', statusId: 'done' }),
  createTask({
    id: 'b-archived',
    projectId: 'project-b',
    dueDate: addDays(TODAY, -1),
    archivedAt: TODAY
  }),
  createTask({ id: 'archived-sub', projectId: 'project-b', parentId: 'b-open', archivedAt: TODAY }),
  createTask({ id: 'ghost-project', projectId: 'project-gone' }),
  createTask({ id: 'ghost-status', statusId: 'status-gone' }),
  createTask({ id: 'orphan-sub', parentId: 'never-existed' })
]

/**
 * A project badge has to mean "tasks you will see when you open this project".
 * The project view is `getFilteredTasks(..., 'project', ...)`, which drops
 * archived rows up front, so the badge is that list minus its completed rows.
 *
 * This replaces the pre-single-pass App.tsx expression, which filtered by
 * project id and status only and therefore counted archived tasks no view can
 * render (#1323).
 */
const expectedProjectTaskCount = (
  tasks: Task[],
  project: Project,
  allProjects: Project[]
): number =>
  getFilteredTasks(tasks, project.id, 'project', allProjects).filter(
    (t) => project.statuses.find((s) => s.id === t.statusId)?.type !== 'done'
  ).length

const expectMatchesFilters = (tasks: Task[], allProjects: Project[] = projects): void => {
  const { viewCounts, projectTaskCounts } = getTaskWorkspaceCounts(tasks, allProjects, ALL_VIEW_IDS)

  for (const viewId of ALL_VIEW_IDS) {
    expect(`${viewId}:${viewCounts[viewId]}`).toBe(
      `${viewId}:${getFilteredTasks(tasks, viewId, 'view', allProjects).length}`
    )
  }

  for (const project of allProjects) {
    expect(`${project.id}:${projectTaskCounts[project.id] ?? 0}`).toBe(
      `${project.id}:${expectedProjectTaskCount(tasks, project, allProjects)}`
    )
  }
}

describe('getTaskWorkspaceCounts', () => {
  it('produces the exact badge numbers for the baseline workspace', () => {
    const { viewCounts, projectTaskCounts } = getTaskWorkspaceCounts(
      baselineTasks(),
      projects,
      ALL_VIEW_IDS
    )

    expect(viewCounts).toEqual({
      // every incomplete top-level task (9) + subtasks of those (overdue-sub)
      all: 10,
      // overdue + due-today + b-open, plus overdue-sub riding along with overdue
      today: 4,
      // due-tomorrow + due-in-3 (due-in-20 is past the 7-day window)
      upcoming: 2,
      tomorrow: 1,
      // today through end of week — date dependent, pinned against the filter below
      week: getFilteredTasks(baselineTasks(), 'week', 'view', projects).length,
      // done-a + b-done, plus done-a-sub riding along with done-a
      completed: 3,
      // an unknown id falls back to the same list as `all`
      'some-future-view': 10
    })

    expect(projectTaskCounts).toEqual({
      // project-a incomplete: overdue, overdue-sub, due-today, due-tomorrow,
      // due-in-3, due-in-20, no-due-date, done-a-sub, ghost-status, orphan-sub
      'project-a': 10,
      // project-b incomplete and renderable: b-open only. b-archived and
      // archived-sub are archived, so the project view never lists them and the
      // badge must not count them either (#1323).
      'project-b': 1,
      'project-gone': 1
    })
  })

  it('matches getFilteredTasks for every view on the baseline workspace', () => {
    expectMatchesFilters(baselineTasks())
  })

  it('matches getFilteredTasks on an empty workspace', () => {
    expectMatchesFilters([])
    expect(getTaskWorkspaceCounts([], projects, ALL_VIEW_IDS).viewCounts).toEqual({
      all: 0,
      today: 0,
      upcoming: 0,
      tomorrow: 0,
      week: 0,
      completed: 0,
      'some-future-view': 0
    })
  })

  it('counts subtasks listed before their parent', () => {
    const reversed = baselineTasks().reverse()

    expect(getTaskWorkspaceCounts(reversed, projects, ALL_VIEW_IDS).viewCounts.all).toBe(10)
    expectMatchesFilters(reversed)
  })

  it('reads each task once per recompute', () => {
    const tasks = baselineTasks()
    let projectIdReads = 0

    const probed = tasks.map((task) => {
      const { projectId, ...rest } = task
      return Object.defineProperty({ ...rest } as Task, 'projectId', {
        get() {
          projectIdReads += 1
          return projectId
        },
        enumerable: true,
        configurable: true
      })
    })

    getTaskWorkspaceCounts(probed, projects, ALL_VIEW_IDS)

    expect(projectIdReads).toBe(tasks.length)
  })
})

describe('getTaskWorkspaceCounts invalidation matrix', () => {
  // Each entry is a mutation the workspace query can deliver — locally or as a
  // field-level vector-clock update written by another device. After every one,
  // the badges must still agree with getFilteredTasks, and the counts named in
  // `changes` must actually move.
  const mutations: {
    name: string
    apply: (tasks: Task[]) => Task[]
    changes: Partial<Record<(typeof ALL_VIEW_IDS)[number] | 'project-a' | 'project-b', number>>
  }[] = [
    {
      name: 'task created',
      apply: (tasks) => [...tasks, createTask({ id: 'fresh', dueDate: TODAY })],
      changes: { all: 11, today: 5, 'project-a': 11 }
    },
    {
      name: 'task edited (title only)',
      apply: (tasks) => tasks.map((t) => (t.id === 'overdue' ? { ...t, title: 'renamed' } : t)),
      changes: {}
    },
    {
      name: 'task completed',
      apply: (tasks) =>
        tasks.map((t) => (t.id === 'overdue' ? { ...t, statusId: 'done', completedAt: TODAY } : t)),
      changes: { all: 8, today: 2, completed: 5, 'project-a': 9 }
    },
    {
      name: 'task uncompleted',
      apply: (tasks) =>
        tasks.map((t) => (t.id === 'done-a' ? { ...t, statusId: 'todo', completedAt: null } : t)),
      changes: { all: 12, completed: 1, 'project-a': 11 }
    },
    {
      name: 'task deleted',
      apply: (tasks) => tasks.filter((t) => t.id !== 'due-today'),
      changes: { all: 9, today: 3, 'project-a': 9 }
    },
    {
      name: 'parent deleted (its subtask stops riding along)',
      apply: (tasks) => tasks.filter((t) => t.id !== 'overdue'),
      changes: { all: 8, today: 2, 'project-a': 9 }
    },
    {
      name: 'due date moved out of today',
      apply: (tasks) =>
        tasks.map((t) => (t.id === 'overdue' ? { ...t, dueDate: addDays(TODAY, 30) } : t)),
      changes: { today: 2 }
    },
    {
      name: 'due date cleared',
      apply: (tasks) => tasks.map((t) => (t.id === 'due-today' ? { ...t, dueDate: null } : t)),
      changes: { today: 3 }
    },
    {
      name: 'project reassigned',
      apply: (tasks) =>
        tasks.map((t) =>
          t.id === 'no-due-date' ? { ...t, projectId: 'project-b', statusId: 'todo' } : t
        ),
      changes: { 'project-a': 9, 'project-b': 2 }
    },
    {
      name: 'status reassigned within the project',
      apply: (tasks) => tasks.map((t) => (t.id === 'due-in-3' ? { ...t, statusId: 'doing' } : t)),
      changes: {}
    },
    {
      name: 'tags reassigned',
      apply: (tasks) => tasks.map((t) => (t.id === 'b-open' ? { ...t, tags: ['home'] } : t)),
      changes: {}
    },
    {
      name: 'task archived',
      // The project badge has to fall with the view: archiving removes the row
      // from the project list, so project-a drops 10 -> 9 (#1323).
      apply: (tasks) => tasks.map((t) => (t.id === 'due-today' ? { ...t, archivedAt: TODAY } : t)),
      changes: { all: 9, today: 3, 'project-a': 9 }
    },
    {
      name: 'task unarchived',
      // ...and rises again when the row comes back: project-b 1 -> 2 (#1323).
      apply: (tasks) => tasks.map((t) => (t.id === 'b-archived' ? { ...t, archivedAt: null } : t)),
      changes: { all: 11, today: 5, 'project-b': 2 }
    },
    {
      name: 'inbox item converted into a task',
      apply: (tasks) => [
        ...tasks,
        createTask({ id: 'from-inbox', sourceNoteId: 'note-1', dueDate: addDays(TODAY, 1) })
      ],
      changes: { all: 11, upcoming: 3, tomorrow: 2, 'project-a': 11 }
    },
    {
      name: 'remote device writes a subtask under an open parent',
      apply: (tasks) => [...tasks, createTask({ id: 'remote-sub', parentId: 'due-today' })],
      changes: { all: 11, today: 5, 'project-a': 11 }
    }
  ]

  for (const mutation of mutations) {
    it(`stays equal to getFilteredTasks after: ${mutation.name}`, () => {
      const mutated = mutation.apply(baselineTasks())

      expectMatchesFilters(mutated)

      const { viewCounts, projectTaskCounts } = getTaskWorkspaceCounts(
        mutated,
        projects,
        ALL_VIEW_IDS
      )
      for (const [key, expected] of Object.entries(mutation.changes)) {
        const actual = key.startsWith('project-') ? projectTaskCounts[key] : viewCounts[key]
        expect(`${mutation.name}/${key}:${actual}`).toBe(`${mutation.name}/${key}:${expected}`)
      }
    })
  }

  it('follows a project renaming its statuses', () => {
    const renamedProjects = [
      createProject('project-a', [
        { id: 'todo', type: 'todo' },
        { id: 'doing', type: 'todo' },
        { id: 'done', type: 'todo' }
      ]),
      projects[1]
    ]

    expectMatchesFilters(baselineTasks(), renamedProjects)
    // 'done' is no longer a done-type status, so done-a and its subtask move out
    // of `completed` and into `all`.
    expect(
      getTaskWorkspaceCounts(baselineTasks(), renamedProjects, ALL_VIEW_IDS).viewCounts
    ).toMatchObject({ all: 12, completed: 1 })
  })

  it('follows a project being removed from the workspace', () => {
    const remaining = [projects[0]]

    expectMatchesFilters(baselineTasks(), remaining)
    // project-b's tasks have no project to resolve a status from, so they read as
    // incomplete: b-open and b-done join `all`, and b-done leaves `completed`.
    expect(
      getTaskWorkspaceCounts(baselineTasks(), remaining, ALL_VIEW_IDS).viewCounts
    ).toMatchObject({ all: 11, completed: 2 })
  })
})
