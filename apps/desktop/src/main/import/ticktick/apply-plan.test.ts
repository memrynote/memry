import { describe, it, expect } from 'vitest'
import { mapRows, type TickTickRow } from '@memry/importers/ticktick'
import { applyPlan, type ApplyDeps } from './apply-plan'

const NOW = '2026-06-15T00:00:00.000Z'

function row(overrides: Partial<TickTickRow> = {}): TickTickRow {
  return {
    folderName: '',
    listName: 'Inbox',
    title: 'Task',
    kind: 'TEXT',
    tags: [],
    content: '',
    isCheckList: false,
    startDate: '',
    dueDate: '',
    reminder: '',
    repeat: '',
    priority: 0,
    status: 0,
    createdTime: '',
    completedTime: '',
    order: '0',
    timezone: 'UTC',
    isAllDay: false,
    isFloating: false,
    columnName: '',
    columnOrder: '',
    viewMode: 'list',
    taskId: '',
    parentId: '',
    projectKind: 'TASK',
    ...overrides
  }
}

interface RecordedTask {
  id: string
  projectId: string
  title: string
  parentId: string | null
  statusId: string | null
}

function makeDeps() {
  let n = 0
  const projects: Array<{ id: string; name: string }> = []
  const tasks: RecordedTask[] = []
  const completed: Array<{ id: string; completedAt?: string }> = []
  const archived: string[] = []
  const reminders: Array<{ targetId: string; remindAt: string }> = []
  const statusesByProject = new Map<
    string,
    Array<{ id: string; isDefault: boolean; isDone: boolean }>
  >()
  const INBOX_STATUSES = [
    { id: 'inbox-todo', isDefault: true, isDone: false },
    { id: 'inbox-ip', isDefault: false, isDone: false },
    { id: 'inbox-done', isDefault: false, isDone: true }
  ]

  const deps: ApplyDeps = {
    async createProject(a) {
      const id = `proj-${n++}`
      projects.push({ id, name: a.name })
      statusesByProject.set(
        id,
        a.statuses.map((s, i) => ({
          id: `${id}-st-${i}`,
          isDefault: i === 0,
          isDone: s.type === 'done'
        }))
      )
      return { success: true, project: { id } }
    },
    async createTask(a) {
      const id = `task-${n++}`
      tasks.push({
        id,
        projectId: a.projectId,
        title: a.title,
        parentId: a.parentId,
        statusId: a.statusId
      })
      return { success: true, task: { id } }
    },
    async completeTask(a) {
      completed.push(a)
      return {}
    },
    async archiveTask(id) {
      archived.push(id)
      return {}
    },
    getInboxProjectId: () => 'inbox-1',
    getStatusesByProject: (pid) => statusesByProject.get(pid) ?? INBOX_STATUSES,
    createReminder: (a) => {
      reminders.push({ targetId: a.targetId, remindAt: a.remindAt })
    }
  }

  return { deps, projects, tasks, completed, archived, reminders }
}

describe('applyPlan', () => {
  it('binds Inbox tasks to the existing inbox project (no new project created)', async () => {
    const { deps, projects, tasks } = makeDeps()
    const plan = mapRows([row({ listName: 'Inbox', title: 'A' })], { now: NOW })
    await applyPlan(plan, deps)
    expect(projects).toHaveLength(0)
    expect(tasks[0].projectId).toBe('inbox-1')
  })

  it('creates a new project and routes its tasks there', async () => {
    const { deps, projects, tasks } = makeDeps()
    const plan = mapRows([row({ listName: 'Books', title: 'B' })], { now: NOW })
    await applyPlan(plan, deps)
    expect(projects.map((p) => p.name)).toContain('Books')
    expect(tasks[0].projectId).toBe(projects[0].id)
  })

  it('creates parents before children and wires parentId to the real id', async () => {
    const { deps, tasks } = makeDeps()
    const plan = mapRows(
      [
        row({ listName: 'Inbox', title: 'Parent', taskId: '1' }),
        row({ listName: 'Inbox', title: 'Child', taskId: '2', parentId: '1' })
      ],
      { now: NOW }
    )
    await applyPlan(plan, deps)
    const parent = tasks.find((t) => t.title === 'Parent')!
    const child = tasks.find((t) => t.title === 'Child')!
    expect(child.parentId).toBe(parent.id)
    expect(tasks.indexOf(parent)).toBeLessThan(tasks.indexOf(child))
  })

  it("completes completed tasks and archives won't-do tasks", async () => {
    const { deps, completed, archived } = makeDeps()
    const plan = mapRows(
      [
        row({ title: 'Done', status: 2, completedTime: '2020-04-22T10:00:00+0000' }),
        row({ title: 'Nope', status: -1 })
      ],
      { now: NOW }
    )
    await applyPlan(plan, deps)
    expect(completed).toHaveLength(1)
    expect(completed[0].completedAt).toBe('2020-04-22T10:00:00+0000')
    expect(archived).toHaveLength(1)
  })

  it('skips past reminders (with a warning) and creates future ones', async () => {
    const { deps, reminders } = makeDeps()
    const past = mapRows(
      [row({ title: 'Old', dueDate: '2020-05-07T08:00:00+0000', reminder: 'PT0S' })],
      {
        now: NOW
      }
    )
    const pastResult = await applyPlan(past, deps)
    expect(reminders).toHaveLength(0)
    expect(pastResult.warnings.some((w) => /past/i.test(w.message))).toBe(true)

    const future = mapRows(
      [row({ title: 'Soon', dueDate: '2999-01-01T00:00:00+0000', reminder: 'PT0S' })],
      { now: NOW }
    )
    await applyPlan(future, deps)
    expect(reminders).toHaveLength(1)
  })
})
