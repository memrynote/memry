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

  it('answers each refusal in the user’s language, not the Rust message', async () => {
    for (const [code, text] of [
      ['sticky_empty', 'Write something first.'],
      ['sticky_too_long', 'Couldn’t send the sticky.'],
      ['sticky_tasks_off', 'Tasks are turned off in Settings.'],
      ['sticky_journal_off', 'Journal is turned off in Settings.'],
      ['sticky_journal_busy', 'Today’s journal entry is still saving. Try again in a moment.'],
      [
        'sticky_folder_excluded',
        'The Sticky folder is excluded. Remove it from the excluded folders in Settings to send notes.'
      ],
      [
        'sticky_project_missing',
        'This task’s project doesn’t exist. Choose a default project in Settings, or send this as a note.'
      ]
    ]) {
      mocks.commands.stickySend.mockRejectedValueOnce(rejected(code, 'rust text'))
      await expect(
        stickyService.send({ draftId: null, content: 'Milk', kind: 'task' })
      ).resolves.toEqual({ success: false, error: text })
    }

    mocks.commands.stickyUndoSend.mockRejectedValueOnce(
      rejected('sticky_undo_expired', 'rust text')
    )
    await expect(stickyService.undoSend('u1')).resolves.toEqual({
      success: false,
      error: 'It’s too late to undo this.'
    })
  })

  it('answers a failed write with its command text, or the generic text when it has none', async () => {
    mocks.commands.stickySend.mockRejectedValueOnce({
      kind: 'invalid',
      code: 'note_excluded',
      message: 'rust text'
    })
    await expect(
      stickyService.send({ draftId: null, content: 'Milk', kind: 'note' })
    ).resolves.toEqual({
      success: false,
      error: "This note is in an excluded folder, so it can't be changed."
    })

    mocks.commands.stickyUndoSend.mockRejectedValueOnce(rejected('internal', ''))
    await expect(stickyService.undoSend('u1')).resolves.toEqual({
      success: false,
      error: 'Couldn’t undo the send.'
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
