import { beforeEach, describe, expect, it, vi } from 'vitest'

const tasksService = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }))
vi.mock('@/services/tasks-service', () => ({ tasksService }))

import {
  markTaskRemovalsHandled,
  relinkTaskNotes,
  takeHandledTaskRemoval,
  taskIdsInBlocks
} from './task-removal'

describe('task removal helpers', () => {
  beforeEach(() => {
    tasksService.get.mockReset()
    tasksService.update.mockReset().mockResolvedValue({ success: true })
  })

  it('reports a handled removal once, per editor', () => {
    const editor = {}
    const other = {}
    markTaskRemovalsHandled(editor, ['t1', ''])

    expect(takeHandledTaskRemoval(other, 't1')).toBe(false)
    expect(takeHandledTaskRemoval(editor, 't1')).toBe(true)
    expect(takeHandledTaskRemoval(editor, 't1')).toBe(false)
    expect(takeHandledTaskRemoval(editor, '')).toBe(false)
  })

  it('finds every task id in a block subtree, subtasks included', () => {
    const blocks = [
      {
        type: 'taskBlock',
        props: { taskId: 'parent' },
        children: [{ type: 'taskBlock', props: { taskId: 'child' } }]
      },
      { type: 'taskBlock', props: { taskId: '' } },
      { type: 'bulletListItem', children: [{ type: 'taskBlock', props: { taskId: 'nested' } }] },
      { type: 'checkListItem', props: {} }
    ]
    expect(taskIdsInBlocks(blocks)).toEqual(['parent', 'child', 'nested'])
  })

  it('moves a task from one note to another in a single write', async () => {
    tasksService.get.mockResolvedValue({ id: 't1', linkedNoteIds: ['a', 'x'] })
    await relinkTaskNotes('t1', { unlink: 'a', link: 'b' })
    expect(tasksService.update).toHaveBeenCalledTimes(1)
    expect(tasksService.update).toHaveBeenCalledWith({ id: 't1', linkedNoteIds: ['x', 'b'] })
  })

  it('writes nothing when the links already say so, or the task is gone', async () => {
    tasksService.get.mockResolvedValueOnce({ id: 't1', linkedNoteIds: ['b'] })
    await relinkTaskNotes('t1', { unlink: 'a', link: 'b' })
    tasksService.get.mockResolvedValueOnce(null)
    await relinkTaskNotes('t2', { unlink: 'a' })
    expect(tasksService.update).not.toHaveBeenCalled()
  })
})
