import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyFrameBinding, removeFrameBinding } from './canvas-frame-categorize'

const mocks = vi.hoisted(() => ({
  noteGet: vi.fn(),
  noteUpdate: vi.fn(),
  taskGet: vi.fn(),
  taskUpdate: vi.fn(),
  propsGet: vi.fn(),
  propsSet: vi.fn()
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { get: mocks.noteGet, update: mocks.noteUpdate }
}))
vi.mock('@/services/tasks-service', () => ({
  tasksService: { get: mocks.taskGet, update: mocks.taskUpdate }
}))
vi.mock('@/services/properties-service', () => ({
  propertiesService: { get: mocks.propsGet, set: mocks.propsSet }
}))

const note = { entityType: 'note' as const, entityId: 'n1' }
const task = { entityType: 'task' as const, entityId: 't1' }
const tag = { kind: 'tag' as const, tag: 'health/sleep' }
const status = {
  kind: 'property' as const,
  property: 'Status',
  value: 'Done',
  propertyType: 'status' as const
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.noteUpdate.mockResolvedValue({ success: true, note: null })
  mocks.taskUpdate.mockResolvedValue({ success: true, task: null })
  mocks.propsSet.mockResolvedValue({ success: true })
})

describe('applyFrameBinding', () => {
  it('adds a tag to a note and reverts against the tags present at undo time', async () => {
    mocks.noteGet.mockResolvedValueOnce({ tags: ['a'] })
    const outcome = await applyFrameBinding(note, tag)
    expect(mocks.noteUpdate).toHaveBeenCalledWith({ id: 'n1', tags: ['a', 'health/sleep'] })
    expect(outcome.status).toBe('applied')

    // Someone added "b" in the meantime; undo must keep it.
    mocks.noteGet.mockResolvedValueOnce({ tags: ['a', 'health/sleep', 'b'] })
    if (outcome.status === 'applied') await outcome.revert()
    expect(mocks.noteUpdate).toHaveBeenLastCalledWith({ id: 'n1', tags: ['a', 'b'] })
  })

  it('reports unchanged when the note already has the tag', async () => {
    mocks.noteGet.mockResolvedValueOnce({ tags: ['Health/Sleep'] })
    await expect(applyFrameBinding(note, tag)).resolves.toEqual({ status: 'unchanged' })
    expect(mocks.noteUpdate).not.toHaveBeenCalled()
  })

  it('tags a task through the task path', async () => {
    mocks.taskGet.mockResolvedValueOnce({ tags: undefined })
    const outcome = await applyFrameBinding(task, tag)
    expect(outcome.status).toBe('applied')
    expect(mocks.taskUpdate).toHaveBeenCalledWith({ id: 't1', tags: ['health/sleep'] })
  })

  it('writes one property and leaves the others alone', async () => {
    mocks.propsGet.mockResolvedValueOnce([
      { name: 'Status', value: 'Not started', type: 'status' },
      { name: 'Rating', value: 3, type: 'number' }
    ])
    const outcome = await applyFrameBinding(note, status)
    expect(mocks.propsSet).toHaveBeenCalledWith('n1', { Status: 'Done', Rating: 3 })

    mocks.propsGet.mockResolvedValueOnce([
      { name: 'Status', value: 'Done', type: 'status' },
      { name: 'Rating', value: 3, type: 'number' }
    ])
    if (outcome.status === 'applied') await outcome.revert()
    expect(mocks.propsSet).toHaveBeenLastCalledWith('n1', { Rating: 3 })
  })

  it('skips cards that cannot carry the binding without writing', async () => {
    await expect(applyFrameBinding(task, status)).resolves.toEqual({
      status: 'skipped',
      reason: 'taskProperty'
    })
    await expect(applyFrameBinding({ entityType: 'file', entityId: 'f1' }, tag)).resolves.toEqual({
      status: 'skipped',
      reason: 'file'
    })
    expect(mocks.taskGet).not.toHaveBeenCalled()
    expect(mocks.noteGet).not.toHaveBeenCalled()
  })

  it('throws when the write fails', async () => {
    mocks.noteGet.mockResolvedValueOnce({ tags: [] })
    mocks.noteUpdate.mockResolvedValueOnce({ success: false, note: null, error: 'boom' })
    await expect(applyFrameBinding(note, tag)).rejects.toThrow('boom')
  })
})

describe('removeFrameBinding', () => {
  it('removes a tag and its revert puts it back', async () => {
    mocks.noteGet.mockResolvedValueOnce({ tags: ['health/sleep', 'a'] })
    const outcome = await removeFrameBinding(note, tag)
    expect(mocks.noteUpdate).toHaveBeenCalledWith({ id: 'n1', tags: ['a'] })
    mocks.noteGet.mockResolvedValueOnce({ tags: ['a'] })
    if (outcome.status === 'applied') await outcome.revert()
    expect(mocks.noteUpdate).toHaveBeenLastCalledWith({ id: 'n1', tags: ['a', 'health/sleep'] })
  })
})
