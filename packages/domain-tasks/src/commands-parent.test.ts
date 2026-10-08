import { describe, expect, it, vi } from 'vitest'
import { createTasksCommands } from './commands.ts'
import { createCommandRepository, createPublisher, createTask } from './test-fixtures.ts'
import type { Task } from './types.ts'

// A project tree: root > child > grandchild, plus a lone top-level task and a
// task in another project.
const rows: Task[] = [
  createTask({ id: 'root', projectId: 'p1', parentId: null }),
  createTask({ id: 'child', projectId: 'p1', parentId: 'root' }),
  createTask({ id: 'grandchild', projectId: 'p1', parentId: 'child' }),
  createTask({ id: 'lone', projectId: 'p1', parentId: null }),
  createTask({ id: 'elsewhere', projectId: 'p2', parentId: null })
]

function commandsWith(allowNested: boolean) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const repository = createCommandRepository({
    getTask: vi.fn((id: string) => byId.get(id)),
    getSubtasks: vi.fn((id: string) => rows.filter((row) => row.parentId === id)),
    createTask: vi.fn((task) => task as Task),
    moveTask: vi.fn((id: string, updates) => ({ ...byId.get(id)!, ...updates }) as Task)
  })
  const commands = createTasksCommands({
    repository,
    publisher: createPublisher(),
    generateId: () => 'new',
    allowNestedSubtasks: () => allowNested
  })
  return { commands, repository }
}

describe('createTasksCommands — where a task may sit', () => {
  it.each([
    // [what, taskId, parentId, nested off, nested on]
    ['under a top-level task', 'lone', 'root', true, true],
    ['under a subtask', 'lone', 'child', false, true],
    ['a parent under another task', 'child', 'lone', false, true],
    ['under itself', 'lone', 'lone', false, false],
    ['inside its own branch', 'root', 'grandchild', false, false],
    ['under a task in another project', 'lone', 'elsewhere', false, false]
  ])('moves %s: allowed %s / %s', async (_what, taskId, parentId, offOk, onOk) => {
    for (const [allowNested, expected] of [
      [false, offOk],
      [true, onOk]
    ] as const) {
      const { commands, repository } = commandsWith(allowNested)
      const result = await commands.moveTask({ taskId, targetParentId: parentId, position: 0 })
      expect(result.success).toBe(expected)
      if (!expected) {
        expect(result.error).toBe('errors:task.invalidParent')
        expect(repository.moveTask).not.toHaveBeenCalled()
      }
    }
  })

  it('creates a subtask under a subtask only with nesting on', async () => {
    const off = commandsWith(false)
    const on = commandsWith(true)
    const input = { projectId: 'p1', title: 'deep', parentId: 'grandchild' }

    expect((await off.commands.createTask(input)).success).toBe(false)
    expect(off.repository.createTask).not.toHaveBeenCalled()
    expect((await on.commands.createTask(input)).success).toBe(true)
  })

  it('makes a task top level whatever the setting', async () => {
    const { commands } = commandsWith(false)
    const result = await commands.moveTask({
      taskId: 'grandchild',
      targetParentId: null,
      position: 0
    })
    expect(result.success).toBe(true)
  })
})
