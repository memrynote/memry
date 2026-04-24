import { describe, it, expect } from 'vitest'

import { tasksRoutes } from './tasks'

describe('tasksRoutes', () => {
  it('tasks_list returns 15 fixtures spanning all statuses and priorities', async () => {
    const list = (await tasksRoutes.tasks_list!(undefined)) as Array<{
      status: string
      priority: string
    }>
    expect(list).toHaveLength(15)
    const statuses = new Set(list.map((t) => t.status))
    const priorities = new Set(list.map((t) => t.priority))
    expect(statuses.size).toBeGreaterThanOrEqual(4)
    expect(priorities.size).toBeGreaterThanOrEqual(4)
  })

  it('tasks_list_by_project filters to the given project', async () => {
    const list = (await tasksRoutes.tasks_list_by_project!({ projectId: 'project-1' })) as Array<{
      projectId: string | null
    }>
    expect(list.length).toBeGreaterThan(0)
    expect(list.every((t) => t.projectId === 'project-1')).toBe(true)
  })

  it('tasks_get returns the task by id', async () => {
    const task = (await tasksRoutes.tasks_get!({ id: 'task-1' })) as { id: string }
    expect(task.id).toBe('task-1')
  })

  it('tasks_get rejects for unknown id', async () => {
    await expect(tasksRoutes.tasks_get!({ id: 'task-missing' })).rejects.toThrow(/not found/i)
  })

  it('tasks_create appends a new task with defaults', async () => {
    const created = (await tasksRoutes.tasks_create!({ title: 'New mock task' })) as {
      id: string
      title: string
      status: string
      priority: string
      completedAt: number | null
      createdAt: number
    }
    expect(created.id).toMatch(/^task-\d+/)
    expect(created.title).toBe('New mock task')
    expect(created.status).toBe('todo')
    expect(created.priority).toBe('medium')
    expect(created.completedAt).toBeNull()
    expect(created.createdAt).toBeGreaterThan(0)
  })

  it('tasks_update mutates the task in place', async () => {
    const updated = (await tasksRoutes.tasks_update!({
      id: 'task-2',
      status: 'done'
    })) as { id: string; status: string; updatedAt: number }
    expect(updated.id).toBe('task-2')
    expect(updated.status).toBe('done')
    expect(updated.updatedAt).toBeGreaterThan(0)
  })

  it('tasks_update rejects for unknown id', async () => {
    await expect(
      tasksRoutes.tasks_update!({ id: 'task-missing', status: 'done' })
    ).rejects.toThrow(/not found/i)
  })

  it('tasks_delete removes the task and returns ok', async () => {
    const created = (await tasksRoutes.tasks_create!({ title: 'Doomed task' })) as { id: string }
    const result = (await tasksRoutes.tasks_delete!({ id: created.id })) as { ok: boolean }
    expect(result.ok).toBe(true)
    await expect(tasksRoutes.tasks_get!({ id: created.id })).rejects.toThrow(/not found/i)
  })

  it('includes a task with Turkish characters for UTF-8 coverage', async () => {
    const list = (await tasksRoutes.tasks_list!(undefined)) as Array<{ title: string }>
    expect(list.some((t) => /[ğüşıöçĞÜŞİÖÇ]/.test(t.title))).toBe(true)
  })
})
