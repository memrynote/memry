import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  create: vi.fn(),
  listForItem: vi.fn(),
  getTaskSettings: vi.fn()
}))

// Keep the import graph light: the slash-menu item logic is what's under test,
// not the React block renderer or BlockNote's spec factory.
vi.mock('@blocknote/react', () => ({
  createReactBlockSpec: () => ({})
}))

vi.mock('./task-block-renderer', () => ({
  TaskBlockRenderer: () => null
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjects: mocks.listProjects,
    create: mocks.create,
    listForItem: mocks.listForItem
  }
}))

import { getTaskSlashMenuItem } from './index'

interface FakeBlock {
  id: string
  type?: string
  content?: Array<{ text?: string } | string>
  props?: Record<string, unknown>
}

function makeEditor(block: FakeBlock) {
  const updateBlock = vi.fn()
  const getBlock = vi.fn(() => block)
  const editor = {
    getTextCursorPosition: () => ({ block }),
    updateBlock,
    getBlock
  }
  return { editor, updateBlock, getBlock }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listForItem.mockResolvedValue([])
  mocks.getTaskSettings.mockResolvedValue({ defaultProjectId: null })
  const settingsMock = window.api.settings as unknown as Record<string, unknown>
  settingsMock.getTaskSettings = mocks.getTaskSettings
})

describe('getTaskSlashMenuItem', () => {
  it('converts the current block to a taskBlock immediately, even when no project exists', async () => {
    // #given there is no default/inbox project (task creation cannot proceed)
    mocks.listProjects.mockResolvedValue({ projects: [] })
    const block: FakeBlock = { id: 'b1', content: [{ text: 'Buy milk' }], props: {} }
    const { editor, updateBlock } = makeEditor(block)

    // #when the user selects /task
    await getTaskSlashMenuItem(editor).onItemClick()

    // #then the block is optimistically converted so the user always sees a task
    expect(updateBlock).toHaveBeenCalledWith(
      block,
      expect.objectContaining({
        type: 'taskBlock',
        props: expect.objectContaining({ title: 'Buy milk', checked: false })
      })
    )
  })

  it('creates a task linked to the note and patches the real taskId onto a fresh block', async () => {
    // #given a default project and a successful create
    mocks.listProjects.mockResolvedValue({ projects: [{ id: 'p1', isInbox: true }] })
    mocks.create.mockResolvedValue({ success: true, task: { id: 'task-123', title: 'Buy milk' } })
    const block: FakeBlock = { id: 'b1', content: [{ text: 'Buy milk' }], props: {} }
    const { editor, updateBlock, getBlock } = makeEditor(block)

    // #when the user selects /task inside note-1
    await getTaskSlashMenuItem(editor, 'note-1').onItemClick()

    // #then the task is created linked to the originating note
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', title: 'Buy milk', linkedNoteIds: ['note-1'] })
    )
    // #and the block is re-fetched fresh (not reused across the async boundary)
    expect(getBlock).toHaveBeenCalledWith('b1')
    // #and patched with the real taskId
    expect(updateBlock).toHaveBeenLastCalledWith(
      block,
      expect.objectContaining({ props: expect.objectContaining({ taskId: 'task-123' }) })
    )
  })

  it('creates the task in the project the note belongs to, not the inbox (#2271)', async () => {
    // #given a note linked to a project, and an inbox that is not it
    mocks.listProjects.mockResolvedValue({
      projects: [
        { id: 'inbox', name: 'Inbox', isInbox: true, archivedAt: null },
        { id: 'work', name: 'Work', isInbox: false, archivedAt: null }
      ]
    })
    mocks.listForItem.mockResolvedValue([{ id: 'work', name: 'Work' }])
    mocks.getTaskSettings.mockResolvedValue({ defaultProjectId: 'inbox' })
    mocks.create.mockResolvedValue({ success: true, task: { id: 'task-9', title: 'Buy milk' } })
    const block: FakeBlock = { id: 'b1', content: [{ text: 'Buy milk' }], props: {} }
    const { editor } = makeEditor(block)

    // #when the user selects /task in that note
    await getTaskSlashMenuItem(editor, 'note-1').onItemClick()

    // #then the note's project wins over both the settings default and the inbox
    expect(mocks.listForItem).toHaveBeenCalledWith('note', 'note-1')
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'work' }))
  })
})
