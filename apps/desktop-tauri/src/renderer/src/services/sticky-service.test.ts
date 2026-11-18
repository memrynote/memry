import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  commands: { stickySend: vi.fn(), stickyUndoSend: vi.fn() }
}))

vi.mock('../../../generated/bindings', () => ({ commands: mocks.commands, events: {} }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: vi.fn() }))

import { stickyService } from './sticky-service'

/** A rejected Tauri command: the serialized `CommandError`, its message written for the user. */
const rejected = (code: string, message: string) => ({ kind: 'invalid', code, message })

describe('sticky-service send and undo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('answers a send in the result shape the sticky reads', async () => {
    mocks.commands.stickySend.mockResolvedValue({
      kind: 'task',
      targetId: 't1',
      title: 'Milk',
      undoToken: 'u1'
    })
    await expect(
      stickyService.send({ draftId: 'd1', content: 'Milk', kind: 'task' })
    ).resolves.toEqual({
      success: true,
      kind: 'task',
      targetId: 't1',
      title: 'Milk',
      undoToken: 'u1'
    })
  })

  it('answers a refused send and an expired undo with main’s message', async () => {
    mocks.commands.stickySend.mockRejectedValue(rejected('sticky_tasks_off', 'Tasks are off.'))
    await expect(
      stickyService.send({ draftId: null, content: 'Milk', kind: 'task' })
    ).resolves.toEqual({ success: false, error: 'Tasks are off.' })

    mocks.commands.stickyUndoSend.mockRejectedValue(rejected('sticky_undo_expired', 'Too late.'))
    await expect(stickyService.undoSend('u1')).resolves.toEqual({
      success: false,
      error: 'Too late.'
    })
  })

  it('answers an undo with the restored draft', async () => {
    mocks.commands.stickyUndoSend.mockResolvedValue({
      id: 'd2',
      content: 'Milk',
      kind: 'note',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    })
    await expect(stickyService.undoSend('u1')).resolves.toEqual({
      success: true,
      draft: expect.objectContaining({ id: 'd2', kind: 'note', content: 'Milk' })
    })
  })
})
