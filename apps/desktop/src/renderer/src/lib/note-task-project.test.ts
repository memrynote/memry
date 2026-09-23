import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveNoteTaskProjectId,
  loadNoteTaskProjectContext,
  resolveProjectIdForNoteTask,
  type ProjectChoice
} from './note-task-project'

const mocks = vi.hoisted(() => ({ listForItem: vi.fn(), getTaskSettings: vi.fn() }))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { listForItem: mocks.listForItem }
}))

const projects: ProjectChoice[] = [
  { id: 'work', archivedAt: null },
  { id: 'inbox', isInbox: true, archivedAt: null },
  { id: 'default', archivedAt: null },
  { id: 'old', archivedAt: '2026-01-01T00:00:00.000Z' }
]

describe('resolveNoteTaskProjectId', () => {
  it('prefers the parent task project over every other source', () => {
    expect(
      resolveNoteTaskProjectId({
        parentTaskProjectId: 'parent',
        quickAddProjectId: 'work',
        noteProjectIds: ['work'],
        settingsDefaultProjectId: 'default',
        projects
      })
    ).toBe('parent')
  })

  it('prefers an explicit +project token over the note project', () => {
    expect(
      resolveNoteTaskProjectId({
        quickAddProjectId: 'default',
        noteProjectIds: ['work'],
        projects
      })
    ).toBe('default')
  })

  it('uses the note project before the settings default', () => {
    expect(
      resolveNoteTaskProjectId({
        noteProjectIds: ['work'],
        settingsDefaultProjectId: 'default',
        projects
      })
    ).toBe('work')
  })

  it('takes the first linked note project and skips archived ones', () => {
    expect(
      resolveNoteTaskProjectId({
        noteProjectIds: ['old', 'work'],
        settingsDefaultProjectId: 'default',
        projects
      })
    ).toBe('work')
  })

  it('falls back to the settings default when the note links no live project', () => {
    expect(
      resolveNoteTaskProjectId({
        noteProjectIds: ['old', 'deleted'],
        settingsDefaultProjectId: 'default',
        projects
      })
    ).toBe('default')
  })

  it('ignores a settings default that is archived or gone', () => {
    expect(resolveNoteTaskProjectId({ settingsDefaultProjectId: 'old', projects })).toBe('inbox')
    expect(resolveNoteTaskProjectId({ settingsDefaultProjectId: 'deleted', projects })).toBe(
      'inbox'
    )
  })

  it('treats the view model isDefault flag as the inbox', () => {
    expect(
      resolveNoteTaskProjectId({
        projects: [
          { id: 'a', isArchived: false },
          { id: 'personal', isDefault: true, isArchived: false }
        ]
      })
    ).toBe('personal')
  })

  it('falls back to the first project when there is no inbox', () => {
    expect(resolveNoteTaskProjectId({ projects: [{ id: 'a' }, { id: 'b' }] })).toBe('a')
  })

  it('returns null when there are no projects at all', () => {
    expect(resolveNoteTaskProjectId({ noteProjectIds: ['work'], projects: [] })).toBeNull()
  })
})

function stubTaskSettings(): void {
  mocks.listForItem.mockReset()
  mocks.getTaskSettings.mockReset()
  const settingsMock = window.api.settings as unknown as Record<string, unknown>
  settingsMock.getTaskSettings = mocks.getTaskSettings
}

describe('loadNoteTaskProjectContext', () => {
  beforeEach(stubTaskSettings)

  it('reads the note links in order and the settings default', async () => {
    mocks.listForItem.mockResolvedValue([{ id: 'work' }, { id: 'side' }])
    mocks.getTaskSettings.mockResolvedValue({ defaultProjectId: 'default' })

    await expect(loadNoteTaskProjectContext('note-1')).resolves.toEqual({
      noteProjectIds: ['work', 'side'],
      settingsDefaultProjectId: 'default'
    })
    expect(mocks.listForItem).toHaveBeenCalledWith('note', 'note-1')
  })

  it('survives an error envelope from listForItem and a rejected settings read', async () => {
    mocks.listForItem.mockResolvedValue({ success: false, error: 'db closed' })
    mocks.getTaskSettings.mockRejectedValue(new Error('no vault'))

    await expect(loadNoteTaskProjectContext('note-1')).resolves.toEqual({
      noteProjectIds: [],
      settingsDefaultProjectId: null
    })
  })

  it('skips the link read when there is no note', async () => {
    mocks.getTaskSettings.mockResolvedValue({ defaultProjectId: null })

    await expect(loadNoteTaskProjectContext(null)).resolves.toEqual({
      noteProjectIds: [],
      settingsDefaultProjectId: null
    })
    expect(mocks.listForItem).not.toHaveBeenCalled()
  })
})

describe('resolveProjectIdForNoteTask', () => {
  beforeEach(stubTaskSettings)

  it('resolves the note project without reading anything twice', async () => {
    mocks.listForItem.mockResolvedValue([{ id: 'work' }])
    mocks.getTaskSettings.mockResolvedValue({ defaultProjectId: 'default' })

    await expect(resolveProjectIdForNoteTask({ noteId: 'note-1', projects })).resolves.toBe('work')
  })

  it('answers from the parent task without any IPC', async () => {
    await expect(
      resolveProjectIdForNoteTask({ noteId: 'note-1', parentTaskProjectId: 'parent', projects })
    ).resolves.toBe('parent')
    expect(mocks.listForItem).not.toHaveBeenCalled()
    expect(mocks.getTaskSettings).not.toHaveBeenCalled()
  })

  it('answers from the quick-add token without any IPC', async () => {
    await expect(
      resolveProjectIdForNoteTask({ noteId: 'note-1', quickAddProjectId: 'default', projects })
    ).resolves.toBe('default')
    expect(mocks.listForItem).not.toHaveBeenCalled()
    expect(mocks.getTaskSettings).not.toHaveBeenCalled()
  })
})
