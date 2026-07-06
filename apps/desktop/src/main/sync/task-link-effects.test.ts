import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskLineBinding } from '@memry/shared/task-block'
import { applyTaskLinkEffects } from './task-link-effects'

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  deleteNoteTaskLink: vi.fn()
}))

vi.mock('../database', () => ({
  requireDatabase: () => ({})
}))

vi.mock('../database/queries/note-task-links', () => ({
  getNoteTaskLinks: vi.fn(() => []),
  deleteNoteTaskLink: mocks.deleteNoteTaskLink
}))

vi.mock('../lib/id', () => ({
  generateId: () => 'generated-id'
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../tasks/publisher', () => ({
  createTasksPublisher: () => ({})
}))

vi.mock('../tasks/domain', () => ({
  createDesktopTasksDomain: () => ({
    getTask: mocks.getTask,
    updateTask: mocks.updateTask,
    completeTask: mocks.completeTask,
    uncompleteTask: mocks.uncompleteTask
  })
}))

function binding(overrides: Partial<TaskLineBinding> & { taskId: string }): TaskLineBinding {
  return { title: 'Buy milk', checked: false, rule: 'title', ...overrides }
}

describe('applyTaskLinkEffects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateTask.mockResolvedValue({ success: true })
    mocks.completeTask.mockResolvedValue({ success: true })
    mocks.uncompleteTask.mockResolvedValue({ success: true })
  })

  it('does not revert an in-app completion when the file merely lags the DB', async () => {
    // #given — the task was completed in the app (inline block / Tasks page);
    // the file and snapshot still carry the pre-completion state because the
    // write-back had not run. This is a stale mirror, not an external edit.
    mocks.getTask.mockReturnValue({ id: 't1', title: 'Buy milk', completedAt: '2026-07-06' })

    // #when — a seed re-binds the line: file checked matches the snapshot
    await applyTaskLinkEffects(
      [binding({ taskId: 't1', checked: false, candidateChecked: false })],
      []
    )

    // #then — the DB stays authoritative; nothing is toggled back
    expect(mocks.uncompleteTask).not.toHaveBeenCalled()
    expect(mocks.completeTask).not.toHaveBeenCalled()
  })

  it('does not apply a legacy-suffix line with no snapshot row over the DB', async () => {
    // #given — first seed after upgrade: `{task:id}` file written by an older
    // version, note_task_links empty, DB task completed since the file was written
    mocks.getTask.mockReturnValue({ id: 't1', title: 'Buy milk', completedAt: '2026-07-06' })

    // #when — legacy binding carries no candidateChecked
    await applyTaskLinkEffects([binding({ taskId: 't1', checked: false, rule: 'legacy' })], [])

    // #then
    expect(mocks.uncompleteTask).not.toHaveBeenCalled()
    expect(mocks.completeTask).not.toHaveBeenCalled()
  })

  it('applies a genuine external toggle (file differs from the snapshot)', async () => {
    // #given — the user checked the box in an external editor
    mocks.getTask.mockReturnValue({ id: 't1', title: 'Buy milk', completedAt: null })

    // #when
    await applyTaskLinkEffects(
      [binding({ taskId: 't1', checked: true, candidateChecked: false })],
      []
    )

    // #then
    expect(mocks.completeTask).toHaveBeenCalledWith({ id: 't1' })
    expect(mocks.uncompleteTask).not.toHaveBeenCalled()
  })

  it('applies an external uncheck and skips it when the DB already matches', async () => {
    // #given — externally unchecked, DB still done
    mocks.getTask.mockReturnValue({ id: 't1', title: 'Buy milk', completedAt: '2026-07-06' })
    await applyTaskLinkEffects(
      [binding({ taskId: 't1', checked: false, candidateChecked: true })],
      []
    )
    expect(mocks.uncompleteTask).toHaveBeenCalledWith('t1')

    // #given — externally toggled but the DB was already brought in line
    vi.clearAllMocks()
    mocks.getTask.mockReturnValue({ id: 't1', title: 'Buy milk', completedAt: null })
    await applyTaskLinkEffects(
      [binding({ taskId: 't1', checked: false, candidateChecked: true })],
      []
    )
    expect(mocks.uncompleteTask).not.toHaveBeenCalled()
    expect(mocks.completeTask).not.toHaveBeenCalled()
  })

  it('still renames on fuzzy bindings and drops orphaned snapshot rows', async () => {
    // #given
    mocks.getTask.mockReturnValue({ id: 't1', title: 'Old title', completedAt: null })

    // #when
    await applyTaskLinkEffects(
      [
        binding({
          taskId: 't1',
          title: 'New title',
          checked: false,
          candidateChecked: false,
          rule: 'fuzzy'
        })
      ],
      [{ taskId: 'gone', title: 'Deleted line', checked: false, anchor: null }]
    )

    // #then
    expect(mocks.updateTask).toHaveBeenCalledWith({ id: 't1', title: 'New title' })
    expect(mocks.deleteNoteTaskLink).toHaveBeenCalledWith({}, 'gone')
  })
})
