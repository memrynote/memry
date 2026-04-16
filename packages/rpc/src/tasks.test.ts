import { describe, expect, it } from 'vitest'
import { TasksChannels } from '../../contracts/src/ipc-channels.ts'
import {
  ProjectCreateSchema,
  StatusCreateSchema,
  TaskCreateSchema,
  TaskListSchema,
  TaskUpdateSchema
} from '../../contracts/src/tasks-api.ts'
import { tasksRpc } from './tasks.ts'

describe('tasksRpc domain shape', () => {
  it('has name "tasks"', () => {
    expect(tasksRpc.name).toBe('tasks')
  })

  it('every method has a non-empty string channel', () => {
    for (const [key, method] of Object.entries(tasksRpc.methods)) {
      expect(method.channel, `method ${key}`).toMatch(/^[a-z][\w:-]+/)
    }
  })

  it('every method has a defined mode (invoke | sync)', () => {
    for (const [key, method] of Object.entries(tasksRpc.methods)) {
      expect(['invoke', 'sync'], `method ${key}`).toContain(method.mode)
    }
  })

  it('method params and invokeArgs are arrays', () => {
    for (const [key, method] of Object.entries(tasksRpc.methods)) {
      expect(Array.isArray(method.params), `method ${key}.params`).toBe(true)
      expect(Array.isArray(method.invokeArgs), `method ${key}.invokeArgs`).toBe(true)
    }
  })

  it('every event has a non-empty string channel', () => {
    for (const [key, event] of Object.entries(tasksRpc.events)) {
      expect(event.channel, `event ${key}`).toMatch(/^[a-z][\w:-]+/)
    }
  })

  it('method channels are unique within the domain', () => {
    const channels = Object.values(tasksRpc.methods).map((m) => m.channel)
    const unique = new Set(channels)
    expect(unique.size).toBe(channels.length)
  })

  it('event channels are unique within the domain', () => {
    const channels = Object.values(tasksRpc.events).map((e) => e.channel)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('wires a representative subset of method channels to TasksChannels.invoke', () => {
    expect(tasksRpc.methods.create.channel).toBe(TasksChannels.invoke.CREATE)
    expect(tasksRpc.methods.update.channel).toBe(TasksChannels.invoke.UPDATE)
    expect(tasksRpc.methods.delete.channel).toBe(TasksChannels.invoke.DELETE)
    expect(tasksRpc.methods.list.channel).toBe(TasksChannels.invoke.LIST)
    expect(tasksRpc.methods.getToday.channel).toBe(TasksChannels.invoke.GET_TODAY)
  })

  it('wires event channels to TasksChannels.events', () => {
    expect(tasksRpc.events.onTaskCreated.channel).toBe(TasksChannels.events.CREATED)
    expect(tasksRpc.events.onProjectDeleted.channel).toBe(TasksChannels.events.PROJECT_DELETED)
  })

  it('preserves custom invokeArgs formatting for reorder', () => {
    expect(tasksRpc.methods.reorder.invokeArgs).toEqual(['{ taskIds, positions }'])
  })

  it('defaults list.invokeArgs to ["options ?? {}"]', () => {
    expect(tasksRpc.methods.list.invokeArgs).toEqual(['options ?? {}'])
  })
})

describe('tasksRpc input Zod schemas', () => {
  it('TaskCreateSchema accepts a realistic payload', () => {
    const result = TaskCreateSchema.safeParse({
      projectId: 'proj-1',
      title: 'Ship Phase 4',
      priority: 3,
      dueDate: '2026-05-01',
      tags: ['work']
    })
    expect(result.success).toBe(true)
  })

  it('TaskCreateSchema rejects empty title with meaningful path', () => {
    const result = TaskCreateSchema.safeParse({ projectId: 'p', title: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('title')
    }
  })

  it('TaskUpdateSchema requires id', () => {
    const ok = TaskUpdateSchema.safeParse({ id: 't-1' })
    const bad = TaskUpdateSchema.safeParse({ title: 'no id' })
    expect(ok.success).toBe(true)
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues[0].path).toContain('id')
  })

  it('TaskListSchema applies defaults for pagination', () => {
    const result = TaskListSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.limit).toBe(100)
      expect(result.data.offset).toBe(0)
    }
  })

  it('ProjectCreateSchema rejects invalid hex color', () => {
    const result = ProjectCreateSchema.safeParse({ name: 'p', color: 'not-hex' })
    expect(result.success).toBe(false)
  })

  it('StatusCreateSchema requires projectId and name', () => {
    expect(StatusCreateSchema.safeParse({ projectId: 'p', name: 'Todo' }).success).toBe(true)
    expect(StatusCreateSchema.safeParse({ name: 'Todo' }).success).toBe(false)
  })
})
