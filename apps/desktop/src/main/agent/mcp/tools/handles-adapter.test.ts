import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  searchAll: vi.fn(),
  listJournalEntriesInRange: vi.fn(),
  getNoteCacheById: vi.fn(),
  getInboxProject: vi.fn(),
  getProjectLinkCounts: vi.fn(),
  createDesktopInboxDomain: vi.fn(),
  createDesktopInboxCrudHandlers: vi.fn(),
  deleteJournalEntryFile: vi.fn(),
  readJournalEntry: vi.fn(),
  writeJournalEntry: vi.fn(),
  createNoteCommand: vi.fn(),
  deleteNoteCommand: vi.fn(),
  moveNoteCommand: vi.fn(),
  renameNoteCommand: vi.fn(),
  updateNoteCommand: vi.fn(),
  createDesktopTasksDomain: vi.fn(),
  createTasksPublisher: vi.fn(),
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  getFolders: vi.fn(),
  getNoteById: vi.fn(),
  listNotes: vi.fn(),
  renameFolder: vi.fn(),
  syncFolderConfigDelete: vi.fn(),
  syncFolderConfigRename: vi.fn(),
  getConfig: vi.fn(),
  getAllTagsWithCounts: vi.fn(),
  generateId: vi.fn(),
  snapshotCurrentNoteFromWindow: vi.fn(),
  invokeDesktopApiFromWindow: vi.fn()
}))

vi.mock('../../../database/queries/search', () => ({
  searchAll: mocks.searchAll
}))

vi.mock('../../../database/queries/notes', () => ({
  listJournalEntriesInRange: mocks.listJournalEntriesInRange,
  getNoteCacheById: mocks.getNoteCacheById
}))

vi.mock('../../../database/queries/projects', () => ({
  getInboxProject: mocks.getInboxProject,
  getProjectLinkCounts: mocks.getProjectLinkCounts
}))

vi.mock('../../../inbox/domain', () => ({
  createDesktopInboxDomain: mocks.createDesktopInboxDomain,
  createDesktopInboxCrudHandlers: mocks.createDesktopInboxCrudHandlers
}))

vi.mock('../../../vault/journal', () => ({
  deleteJournalEntryFile: mocks.deleteJournalEntryFile,
  readJournalEntry: mocks.readJournalEntry,
  writeJournalEntry: mocks.writeJournalEntry
}))

vi.mock('../../../notes/domain', () => ({
  createNoteCommand: mocks.createNoteCommand,
  deleteNoteCommand: mocks.deleteNoteCommand,
  moveNoteCommand: mocks.moveNoteCommand,
  renameNoteCommand: mocks.renameNoteCommand,
  updateNoteCommand: mocks.updateNoteCommand
}))

vi.mock('../../../tasks/domain', () => ({
  createDesktopTasksDomain: mocks.createDesktopTasksDomain
}))

vi.mock('../../../tasks/publisher', () => ({
  createTasksPublisher: mocks.createTasksPublisher
}))

vi.mock('../../../vault/notes', () => ({
  createFolder: mocks.createFolder,
  deleteFolder: mocks.deleteFolder,
  getFolders: mocks.getFolders,
  getNoteById: mocks.getNoteById,
  listNotes: mocks.listNotes,
  renameFolder: mocks.renameFolder
}))

vi.mock('../../../notes/folder-config-effects', () => ({
  syncFolderConfigDelete: mocks.syncFolderConfigDelete,
  syncFolderConfigRename: mocks.syncFolderConfigRename
}))

vi.mock('../../../vault', () => ({
  getConfig: mocks.getConfig
}))

vi.mock('../../../tags/store', () => ({
  getAllTagsWithCounts: mocks.getAllTagsWithCounts
}))

vi.mock('../../../lib/id', () => ({
  generateId: mocks.generateId
}))

vi.mock('./current-note', () => ({
  snapshotCurrentNoteFromWindow: mocks.snapshotCurrentNoteFromWindow
}))

vi.mock('./desktop-api', () => ({
  invokeDesktopApiFromWindow: mocks.invokeDesktopApiFromWindow
}))

import { createVaultServiceHandles } from './handles-adapter'

const deps = {
  dataDb: {} as never,
  indexDb: {} as never
}

describe('createVaultServiceHandles', () => {
  let taskDomain: {
    listTasks: ReturnType<typeof vi.fn>
    createTask: ReturnType<typeof vi.fn>
    completeTask: ReturnType<typeof vi.fn>
    uncompleteTask: ReturnType<typeof vi.fn>
    updateTask: ReturnType<typeof vi.fn>
    getTask: ReturnType<typeof vi.fn>
    deleteTask: ReturnType<typeof vi.fn>
    archiveTask: ReturnType<typeof vi.fn>
    unarchiveTask: ReturnType<typeof vi.fn>
    moveTask: ReturnType<typeof vi.fn>
    reorderTasks: ReturnType<typeof vi.fn>
    duplicateTask: ReturnType<typeof vi.fn>
    convertToSubtask: ReturnType<typeof vi.fn>
    convertToTask: ReturnType<typeof vi.fn>
    listProjects: ReturnType<typeof vi.fn>
    getProject: ReturnType<typeof vi.fn>
    createProject: ReturnType<typeof vi.fn>
    updateProject: ReturnType<typeof vi.fn>
    deleteProject: ReturnType<typeof vi.fn>
    archiveProject: ReturnType<typeof vi.fn>
    reorderProjects: ReturnType<typeof vi.fn>
    listStatuses: ReturnType<typeof vi.fn>
    createStatus: ReturnType<typeof vi.fn>
    updateStatus: ReturnType<typeof vi.fn>
    deleteStatus: ReturnType<typeof vi.fn>
    reorderStatuses: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()

    mocks.getConfig.mockReturnValue({ defaultNoteFolder: 'notes' })
    mocks.searchAll.mockReturnValue({ groups: [] })
    mocks.getFolders.mockResolvedValue([])
    mocks.listNotes.mockReturnValue({ notes: [] })
    mocks.createTasksPublisher.mockReturnValue({})
    mocks.generateId.mockReturnValue('generated-id')
    mocks.getInboxProject.mockReturnValue({ id: 'inbox-project' })
    mocks.createDesktopInboxCrudHandlers.mockReturnValue({
      handleGet: vi.fn().mockResolvedValue(null),
      handleUpdate: vi.fn().mockResolvedValue({ success: true, item: { id: 'inbox-1' } }),
      handleArchive: vi.fn().mockResolvedValue({ success: true }),
      handleAddTag: vi.fn().mockResolvedValue({ success: true }),
      handleRemoveTag: vi.fn().mockResolvedValue({ success: true }),
      handleMarkViewed: vi.fn().mockResolvedValue({ success: true }),
      handleUnarchive: vi.fn().mockResolvedValue({ success: true }),
      handleDeletePermanent: vi.fn().mockResolvedValue({ success: true }),
      handleUndoFile: vi.fn().mockResolvedValue({ success: true }),
      handleUndoArchive: vi.fn().mockResolvedValue({ success: true })
    })

    taskDomain = {
      listTasks: vi.fn().mockReturnValue({ tasks: [] }),
      createTask: vi.fn().mockResolvedValue({ success: true, task: { id: 'task-created' } }),
      completeTask: vi.fn().mockResolvedValue({ success: true }),
      uncompleteTask: vi.fn().mockResolvedValue({ success: true }),
      updateTask: vi.fn().mockResolvedValue({ success: true }),
      getTask: vi.fn(),
      deleteTask: vi.fn().mockResolvedValue({ success: true }),
      archiveTask: vi.fn().mockResolvedValue({ success: true }),
      unarchiveTask: vi.fn().mockResolvedValue({ success: true }),
      moveTask: vi.fn().mockResolvedValue({ success: true }),
      reorderTasks: vi.fn().mockResolvedValue({ success: true }),
      duplicateTask: vi.fn().mockResolvedValue({ success: true, task: { id: 'task-copy' } }),
      convertToSubtask: vi.fn().mockResolvedValue({ success: true }),
      convertToTask: vi.fn().mockResolvedValue({ success: true }),
      listProjects: vi.fn().mockReturnValue({ projects: [] }),
      getProject: vi.fn(),
      createProject: vi
        .fn()
        .mockResolvedValue({ success: true, project: { id: 'project-created' } }),
      updateProject: vi.fn().mockResolvedValue({ success: true, project: { id: 'project-1' } }),
      deleteProject: vi.fn().mockResolvedValue({ success: true }),
      archiveProject: vi.fn().mockResolvedValue({ success: true }),
      reorderProjects: vi.fn().mockResolvedValue({ success: true }),
      listStatuses: vi.fn().mockReturnValue([]),
      createStatus: vi.fn().mockResolvedValue({ success: true, status: { id: 'status-created' } }),
      updateStatus: vi.fn().mockResolvedValue({ success: true, status: { id: 'status-1' } }),
      deleteStatus: vi.fn().mockResolvedValue({ success: true }),
      reorderStatuses: vi.fn().mockResolvedValue({ success: true })
    }
    mocks.createDesktopTasksDomain.mockReturnValue(taskDomain)
  })

  it('maps note search, read, create, update, tag, and move handles', async () => {
    const handles = createVaultServiceHandles(deps)

    mocks.searchAll.mockReturnValue({
      groups: [
        {
          type: 'note',
          results: [
            {
              id: 'note-1',
              title: 'Alpha',
              snippet: null,
              metadata: { type: 'note', path: 'notes/work/alpha.md', emoji: '🎬' }
            },
            {
              id: 'file-1',
              title: 'Scan',
              snippet: 'scan snippet',
              metadata: { type: 'note', path: 'notes/work/scan.pdf', fileType: 'pdf' }
            },
            {
              id: 'note-2',
              title: 'Loose',
              snippet: 'loose snippet',
              metadata: { type: 'task' }
            }
          ]
        }
      ]
    })

    await expect(
      handles.notes.search({ query: 'alpha', folderId: '/work', limit: 5 })
    ).resolves.toEqual([
      {
        id: 'note-1',
        title: 'Alpha',
        snippet: '',
        folder_path: '/work',
        file_type: 'markdown',
        icon: '🎬'
      },
      {
        id: 'file-1',
        title: 'Scan',
        snippet: 'scan snippet',
        folder_path: '/work',
        file_type: 'pdf'
      },
      {
        id: 'note-2',
        title: 'Loose',
        snippet: 'loose snippet',
        folder_path: null,
        file_type: 'markdown'
      }
    ])
    expect(mocks.searchAll).toHaveBeenCalledWith(
      deps.indexDb,
      deps.dataDb,
      expect.objectContaining({ folderPath: 'notes/work', limit: 5, noteFileTypes: undefined })
    )

    mocks.getNoteCacheById.mockReturnValue({
      id: 'note-1',
      title: 'Alpha',
      path: 'notes/work/alpha.md',
      fileType: 'markdown'
    })
    mocks.getNoteById.mockResolvedValue({
      id: 'note-1',
      title: 'Alpha',
      content: 'Current',
      tags: ['Team'],
      path: 'notes/work/alpha.md',
      frontmatter: { owner: 'Kaan' },
      emoji: '📚'
    })
    await expect(handles.notes.read('note-1')).resolves.toEqual({
      id: 'note-1',
      title: 'Alpha',
      content_markdown: 'Current',
      tags: ['Team'],
      folder_path: '/work',
      frontmatter: { owner: 'Kaan' },
      file_type: 'markdown',
      icon: '📚'
    })

    mocks.createNoteCommand.mockResolvedValue({ id: 'note-created' })
    await expect(
      handles.notes.create({
        title: 'New',
        content_markdown: 'Body',
        folder_path: '/work',
        tags: ['focus']
      })
    ).resolves.toEqual({ id: 'note-created' })
    expect(mocks.createNoteCommand).toHaveBeenCalledWith({
      title: 'New',
      content: 'Body',
      folder: 'work',
      tags: ['focus']
    })

    await handles.notes.update({ id: 'note-1', mode: 'append', content_markdown: 'Next' })
    expect(mocks.updateNoteCommand).toHaveBeenLastCalledWith({
      id: 'note-1',
      content: 'Current\n\nNext'
    })

    await handles.notes.addTag({ id: 'note-1', tag: ' Team ' })
    expect(mocks.updateNoteCommand).toHaveBeenLastCalledWith({ id: 'note-1', tags: ['Team'] })

    await handles.notes.addTag({ id: 'note-1', tag: 'Review' })
    expect(mocks.updateNoteCommand).toHaveBeenLastCalledWith({
      id: 'note-1',
      tags: ['Team', 'Review']
    })

    await handles.notes.removeTag({ id: 'note-1', tag: 'team' })
    expect(mocks.updateNoteCommand).toHaveBeenLastCalledWith({ id: 'note-1', tags: [] })

    await handles.notes.moveToFolder({ id: 'note-1', folder_path: '/archive' })
    expect(mocks.moveNoteCommand).toHaveBeenCalledWith('note-1', 'archive')

    mocks.getNoteById.mockResolvedValueOnce(null)
    await expect(
      handles.notes.update({ id: 'missing', mode: 'replace', content_markdown: 'Body' })
    ).rejects.toThrow('Note not found: missing')

    mocks.getNoteById.mockResolvedValueOnce({
      id: 'note-root',
      title: 'Root',
      content: '',
      tags: [],
      path: 'notes/root.md',
      frontmatter: {}
    })
    await expect(handles.notes.read('note-root')).resolves.toMatchObject({ folder_path: null })

    mocks.getNoteById.mockResolvedValueOnce(null)
    await expect(handles.notes.read('missing')).resolves.toBeNull()
    mocks.getNoteById.mockResolvedValueOnce(null)
    await expect(handles.notes.addTag({ id: 'missing', tag: 'tag' })).rejects.toThrow(
      'Note not found: missing'
    )
    mocks.getNoteById.mockResolvedValueOnce(null)
    await expect(handles.notes.removeTag({ id: 'missing', tag: 'tag' })).rejects.toThrow(
      'Note not found: missing'
    )

    mocks.getNoteById.mockResolvedValueOnce({
      id: 'empty',
      content: '',
      tags: [],
      path: 'notes/a.md'
    })
    await handles.notes.update({ id: 'empty', mode: 'append', content_markdown: 'Next' })
    expect(mocks.updateNoteCommand).toHaveBeenLastCalledWith({ id: 'empty', content: 'Next' })

    mocks.getNoteById.mockResolvedValueOnce({
      id: 'prepend',
      content: 'Current',
      tags: [],
      path: 'notes/a.md'
    })
    await handles.notes.update({ id: 'prepend', mode: 'prepend', content_markdown: 'Before' })
    expect(mocks.updateNoteCommand).toHaveBeenLastCalledWith({
      id: 'prepend',
      content: 'Before\n\nCurrent'
    })

    await handles.notes.moveToFolder({ id: 'note-1', folder_path: '/' })
    expect(mocks.moveNoteCommand).toHaveBeenLastCalledWith('note-1', '')
  })

  it('pushes the note file type filter into the FTS query', async () => {
    const handles = createVaultServiceHandles(deps)

    await handles.notes.search({ query: 'invoice', fileTypes: ['markdown'] })

    expect(mocks.searchAll).toHaveBeenCalledWith(
      deps.indexDb,
      deps.dataDb,
      expect.objectContaining({ noteFileTypes: ['markdown'] })
    )
  })

  it('reads a filed binary as its file type without parsing the bytes as markdown', async () => {
    const handles = createVaultServiceHandles(deps)

    mocks.getNoteCacheById.mockReturnValue({
      id: 'file-1',
      title: 'Scan',
      path: 'notes/work/scan.pdf',
      fileType: 'pdf'
    })

    await expect(handles.notes.read('file-1')).resolves.toMatchObject({
      id: 'file-1',
      title: 'Scan',
      folder_path: '/work',
      file_type: 'pdf'
    })
    expect(mocks.getNoteById).not.toHaveBeenCalled()
  })

  it('treats a note cache row with no file type as markdown', async () => {
    const handles = createVaultServiceHandles(deps)

    mocks.getNoteCacheById.mockReturnValue({
      id: 'legacy-1',
      title: 'Legacy',
      path: 'notes/legacy.md',
      fileType: null
    })
    mocks.getNoteById.mockResolvedValue({
      id: 'legacy-1',
      title: 'Legacy',
      content: 'Body',
      tags: [],
      path: 'notes/legacy.md',
      frontmatter: {},
      emoji: null
    })

    await expect(handles.notes.read('legacy-1')).resolves.toMatchObject({
      id: 'legacy-1',
      content_markdown: 'Body',
      file_type: 'markdown'
    })
  })

  it('refuses to overwrite a filed binary with markdown', async () => {
    const handles = createVaultServiceHandles(deps)

    mocks.getNoteCacheById.mockReturnValue({
      id: 'file-1',
      title: 'Scan',
      path: 'notes/work/scan.pdf',
      fileType: 'pdf'
    })

    await expect(
      handles.notes.update({ id: 'file-1', mode: 'replace', content_markdown: 'Body' })
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { id: 'file-1', file_type: 'pdf' } })
    expect(mocks.updateNoteCommand).not.toHaveBeenCalled()
  })

  it('returns null when the note cache has no row for the id', async () => {
    const handles = createVaultServiceHandles(deps)

    mocks.getNoteCacheById.mockReturnValue(undefined)

    await expect(handles.notes.read('missing')).resolves.toBeNull()
    expect(mocks.getNoteById).not.toHaveBeenCalled()
  })

  it('lists direct and recursive folder entries using tool paths', async () => {
    const handles = createVaultServiceHandles(deps)

    mocks.getFolders.mockResolvedValue([
      { path: 'work' },
      { path: 'work/client' },
      { path: 'work/client/archive' },
      { path: 'personal' }
    ])
    mocks.listNotes.mockReturnValue({
      notes: [
        { id: 'note-1', title: 'Client', path: 'notes/work/client.md', emoji: '💼' },
        { id: 'note-2', title: 'Deep', path: 'notes/work/client/deep.md' }
      ]
    })

    await expect(handles.folders.list({ path: '/work', recursive: false })).resolves.toEqual([
      { kind: 'folder', id: '/work/client', name: 'client', path: '/work/client' },
      { kind: 'note', id: 'note-1', name: 'Client', path: '/work/client.md', icon: '💼' }
    ])
    expect(mocks.listNotes).toHaveBeenCalledWith({
      folder: 'notes/work',
      limit: 1000,
      offset: 0
    })

    await expect(handles.folders.list({ path: '/', recursive: true })).resolves.toEqual([
      { kind: 'folder', id: '/work', name: 'work', path: '/work' },
      { kind: 'folder', id: '/work/client', name: 'client', path: '/work/client' },
      {
        kind: 'folder',
        id: '/work/client/archive',
        name: 'archive',
        path: '/work/client/archive'
      },
      { kind: 'folder', id: '/personal', name: 'personal', path: '/personal' },
      { kind: 'note', id: 'note-1', name: 'Client', path: '/work/client.md', icon: '💼' },
      { kind: 'note', id: 'note-2', name: 'Deep', path: '/work/client/deep.md' }
    ])

    await expect(handles.folders.list({ path: '/', recursive: false })).resolves.toEqual([
      { kind: 'folder', id: '/work', name: 'work', path: '/work' },
      { kind: 'folder', id: '/personal', name: 'personal', path: '/personal' }
    ])

    await expect(handles.folders.create('/planning')).resolves.toEqual({ path: '/planning' })
    expect(mocks.createFolder).toHaveBeenCalledWith('planning')

    await expect(
      handles.folders.rename({ old_path: '/planning', new_path: '/archive/planning' })
    ).resolves.toEqual({ path: '/archive/planning' })
    expect(mocks.renameFolder).toHaveBeenCalledWith('planning', 'archive/planning')
    expect(mocks.syncFolderConfigRename).toHaveBeenCalledWith('planning', 'archive/planning')

    await expect(handles.folders.delete('/archive/planning')).resolves.toEqual({
      path: '/archive/planning'
    })
    expect(mocks.deleteFolder).toHaveBeenCalledWith('archive/planning')
    expect(mocks.syncFolderConfigDelete).toHaveBeenCalledWith('archive/planning')
  })

  it('maps task and project handles through the task domain', async () => {
    const handles = createVaultServiceHandles(deps)

    taskDomain.listTasks.mockReturnValue({
      tasks: [
        {
          id: 'task-1',
          title: 'Open task',
          statusId: 'todo',
          completedAt: null,
          dueDate: '2026-05-12',
          projectId: 'project-1',
          tags: ['focus']
        },
        {
          id: 'task-2',
          title: 'Done task',
          statusId: 'done',
          completedAt: '2026-05-11',
          dueDate: null,
          projectId: null,
          tags: null
        }
      ]
    })

    await expect(
      handles.tasks.list({ status: 'open', project_id: 'project-1', tag: 'focus', limit: 3 })
    ).resolves.toEqual([
      {
        id: 'task-1',
        title: 'Open task',
        status: 'todo',
        due: '2026-05-12',
        project: 'project-1',
        tags: ['focus']
      }
    ])
    expect(taskDomain.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        statusId: undefined,
        includeCompleted: false,
        tags: ['focus'],
        limit: 3
      })
    )

    await expect(handles.tasks.list({ status: 'completed' })).resolves.toEqual([
      {
        id: 'task-2',
        title: 'Done task',
        status: 'completed',
        due: null,
        project: null,
        tags: []
      }
    ])

    await expect(handles.tasks.list({ status: 'todo' })).resolves.toEqual([
      expect.objectContaining({ id: 'task-1' }),
      expect.objectContaining({ id: 'task-2' })
    ])

    await expect(handles.tasks.create({ title: 'New task', tags: ['inbox'] })).resolves.toEqual({
      id: 'task-created'
    })
    expect(taskDomain.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New task',
        projectId: 'inbox-project',
        dueDate: null,
        description: null,
        tags: ['inbox']
      })
    )

    mocks.getInboxProject.mockReturnValueOnce(null)
    await expect(handles.tasks.create({ title: 'No project' })).rejects.toThrow(
      'No project available for task creation'
    )

    taskDomain.createTask.mockResolvedValueOnce({ success: false, task: null })
    await expect(
      handles.tasks.create({ title: 'Bad task', project_id: 'project-1' })
    ).rejects.toThrow('Failed to create task')

    await handles.tasks.update('task-1', { status: 'completed' })
    expect(taskDomain.completeTask).toHaveBeenCalledWith({ id: 'task-1' })

    taskDomain.completeTask.mockResolvedValueOnce({ success: false, error: 'complete failed' })
    await expect(handles.tasks.update('task-1', { status: 'completed' })).rejects.toThrow(
      'complete failed'
    )

    await handles.tasks.update('task-1', { status: 'open' })
    expect(taskDomain.uncompleteTask).toHaveBeenCalledWith('task-1')

    taskDomain.uncompleteTask.mockResolvedValueOnce({ success: false, error: 'reopen failed' })
    await expect(handles.tasks.update('task-1', { status: 'open' })).rejects.toThrow(
      'reopen failed'
    )

    await handles.tasks.update('task-1', { title: 'Renamed', project_id: null, due: null })
    expect(taskDomain.updateTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'task-1',
        title: 'Renamed',
        projectId: undefined,
        dueDate: null
      })
    )

    taskDomain.updateTask.mockResolvedValueOnce({ success: false, error: 'update failed' })
    await expect(handles.tasks.update('task-1', { title: 'Bad' })).rejects.toThrow('update failed')

    taskDomain.getTask.mockReturnValue({ id: 'task-1', tags: ['focus'] })
    await handles.tasks.addTag({ id: 'task-1', tag: 'focus' })
    expect(taskDomain.updateTask).toHaveBeenLastCalledWith({ id: 'task-1', tags: ['focus'] })
    await handles.tasks.addTag({ id: 'task-1', tag: 'ship' })
    expect(taskDomain.updateTask).toHaveBeenLastCalledWith({
      id: 'task-1',
      tags: ['focus', 'ship']
    })
    await handles.tasks.removeTag({ id: 'task-1', tag: 'FOCUS' })
    expect(taskDomain.updateTask).toHaveBeenLastCalledWith({ id: 'task-1', tags: [] })

    taskDomain.getTask.mockReturnValueOnce(null)
    await expect(handles.tasks.addTag({ id: 'missing', tag: 'focus' })).rejects.toThrow(
      'Task not found: missing'
    )
    taskDomain.getTask.mockReturnValueOnce(null)
    await expect(handles.tasks.removeTag({ id: 'missing', tag: 'focus' })).rejects.toThrow(
      'Task not found: missing'
    )
    taskDomain.getTask.mockReturnValueOnce({ id: 'task-2', tags: null })
    await handles.tasks.removeTag({ id: 'task-2', tag: 'focus' })
    expect(taskDomain.updateTask).toHaveBeenLastCalledWith({ id: 'task-2', tags: [] })

    taskDomain.getTask.mockReturnValueOnce({ id: 'task-3', tags: [] })
    taskDomain.updateTask.mockResolvedValueOnce({ success: false, error: 'tag failed' })
    await expect(handles.tasks.addTag({ id: 'task-3', tag: 'focus' })).rejects.toThrow('tag failed')
    taskDomain.getTask.mockReturnValueOnce({ id: 'task-4', tags: ['focus'] })
    taskDomain.updateTask.mockResolvedValueOnce({ success: false, error: 'untag failed' })
    await expect(handles.tasks.removeTag({ id: 'task-4', tag: 'focus' })).rejects.toThrow(
      'untag failed'
    )

    taskDomain.listProjects.mockReturnValue({
      projects: [
        {
          id: 'project-1',
          name: 'Active',
          archivedAt: null,
          taskCount: 2,
          icon: '🚀',
          homeNoteId: 'note-home'
        },
        { id: 'project-2', name: 'Archived', archivedAt: '2026-05-11', taskCount: 0 }
      ]
    })
    mocks.getProjectLinkCounts.mockReturnValue(
      new Map([['project-1', { notes: 3, files: 1, events: 2 }]])
    )
    await expect(handles.projects.list()).resolves.toEqual([
      {
        id: 'project-1',
        name: 'Active',
        status: 'active',
        task_count: 2,
        icon: '🚀',
        home_note_id: 'note-home',
        linked_counts: { notes: 3, files: 1, events: 2 }
      },
      {
        id: 'project-2',
        name: 'Archived',
        status: 'archived',
        task_count: 0,
        icon: null,
        home_note_id: null,
        // A project with no links is absent from the counts map.
        linked_counts: { notes: 0, files: 0, events: 0 }
      }
    ])

    taskDomain.getTask.mockReturnValueOnce({ id: 'task-1' })
    await expect(handles.tasks.get('task-1')).resolves.toEqual({ id: 'task-1' })
    taskDomain.getTask.mockReturnValueOnce(null)
    await expect(handles.tasks.get('missing')).resolves.toBeNull()

    await expect(handles.tasks.delete('task-1')).resolves.toEqual({ id: 'task-1' })
    await expect(
      handles.tasks.complete({ id: 'task-1', completed_at: '2026-05-13T00:00:00Z' })
    ).resolves.toEqual({ id: 'task-1' })
    await expect(handles.tasks.uncomplete('task-1')).resolves.toEqual({ id: 'task-1' })
    await expect(handles.tasks.archive('task-1')).resolves.toEqual({ id: 'task-1' })
    await expect(handles.tasks.unarchive('task-1')).resolves.toEqual({ id: 'task-1' })
    await expect(
      handles.tasks.move({
        task_id: 'task-1',
        target_project_id: 'project-2',
        target_status_id: 'status-1',
        position: 2
      })
    ).resolves.toEqual({ id: 'task-1' })
    await expect(handles.tasks.reorder({ task_ids: ['task-1'], positions: [0] })).resolves.toEqual({
      ids: ['task-1']
    })
    await expect(handles.tasks.duplicate('task-1')).resolves.toEqual({ id: 'task-copy' })
    await expect(
      handles.tasks.convertToSubtask({ task_id: 'task-1', parent_id: 'parent-1' })
    ).resolves.toEqual({ id: 'task-1' })
    await expect(handles.tasks.convertToTask('task-1')).resolves.toEqual({ id: 'task-1' })

    expect(taskDomain.completeTask).toHaveBeenLastCalledWith({
      id: 'task-1',
      completedAt: '2026-05-13T00:00:00Z'
    })
    expect(taskDomain.moveTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      targetProjectId: 'project-2',
      targetStatusId: 'status-1',
      targetParentId: undefined,
      position: 2
    })

    taskDomain.deleteTask.mockResolvedValueOnce({ success: false, error: 'delete failed' })
    await expect(handles.tasks.delete('task-bad')).rejects.toThrow('delete failed')

    taskDomain.getProject.mockReturnValueOnce({ id: 'project-1' })
    await expect(handles.projects.get('project-1')).resolves.toEqual({ id: 'project-1' })
    taskDomain.getProject.mockReturnValueOnce(null)
    await expect(handles.projects.get('missing')).resolves.toBeNull()
    await expect(handles.projects.create({ name: 'Project' })).resolves.toEqual({
      id: 'project-created'
    })
    await expect(handles.projects.update({ id: 'project-1', name: 'Next' })).resolves.toEqual({
      id: 'project-1'
    })
    await expect(handles.projects.delete('project-1')).resolves.toEqual({ id: 'project-1' })
    await expect(handles.projects.archive('project-1')).resolves.toEqual({ id: 'project-1' })
    await expect(
      handles.projects.reorder({ project_ids: ['project-1'], positions: [0] })
    ).resolves.toEqual({ ids: ['project-1'] })

    await expect(handles.statuses.list('project-1')).resolves.toEqual([])
    await expect(
      handles.statuses.create({ project_id: 'project-1', name: 'Doing', is_done: true })
    ).resolves.toEqual({ id: 'status-created' })
    await expect(handles.statuses.update({ id: 'status-1', name: 'Done' })).resolves.toEqual({
      id: 'status-1'
    })
    await expect(handles.statuses.delete('status-1')).resolves.toEqual({ id: 'status-1' })
    await expect(
      handles.statuses.reorder({ status_ids: ['status-1'], positions: [0] })
    ).resolves.toEqual({ ids: ['status-1'] })
  })

  it('maps journal, inbox, tag, and window handles', async () => {
    const handles = createVaultServiceHandles(deps)

    mocks.readJournalEntry.mockResolvedValueOnce({
      id: 'journal-1',
      date: '2026-05-12',
      content: 'Today'
    })
    await expect(handles.journal.getByDate('2026-05-12')).resolves.toEqual({
      id: 'journal-1',
      date: '2026-05-12',
      content_markdown: 'Today'
    })

    mocks.readJournalEntry.mockResolvedValueOnce(null)
    await expect(handles.journal.getByDate('2026-05-10')).resolves.toBeNull()

    mocks.listJournalEntriesInRange.mockReturnValue([
      { id: 'journal-1', date: null, title: 'Untitled' }
    ])
    await expect(
      handles.journal.listInRange({ from: '2026-05-01', to: '2026-05-31' })
    ).resolves.toEqual([{ id: 'journal-1', date: '', title: 'Untitled' }])

    mocks.readJournalEntry.mockResolvedValueOnce(null)
    mocks.writeJournalEntry.mockResolvedValue({ id: 'journal-created' })
    await expect(
      handles.journal.createIfMissing({ date: '2026-05-13', content_markdown: 'Tomorrow' })
    ).resolves.toEqual({ id: 'journal-created', created: true })

    mocks.readJournalEntry.mockResolvedValueOnce({ id: 'journal-existing' })
    await expect(
      handles.journal.createIfMissing({ date: '2026-05-13', content_markdown: 'Tomorrow' })
    ).resolves.toEqual({ id: 'journal-existing', created: false })

    mocks.createDesktopInboxDomain.mockReturnValue({
      list: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'inbox-1',
            sourceUrl: 'https://x.com/memry/status/1',
            captureSource: null,
            type: 'social',
            title: 'Unread',
            content: null,
            transcription: null,
            excerpt: 'Excerpt',
            viewedAt: null,
            createdAt: new Date('2026-05-12T00:00:00Z'),
            metadata: { platform: 'twitter' }
          },
          {
            id: 'inbox-2',
            sourceUrl: null,
            captureSource: 'share',
            type: 'clip',
            title: 'Read',
            content: 'Read body',
            transcription: null,
            excerpt: null,
            viewedAt: new Date('2026-05-12T01:00:00Z'),
            createdAt: new Date('2026-05-12T01:00:00Z')
          }
        ]
      }),
      captureText: vi.fn().mockResolvedValue({ success: true, item: { id: 'inbox-created' } }),
      snooze: vi.fn().mockResolvedValue({ success: true })
    })
    await expect(handles.inbox.list({ unread_only: true })).resolves.toEqual([
      {
        id: 'inbox-1',
        type: 'social',
        visual_type: 'twitter',
        source: 'https://x.com/memry/status/1',
        title: 'Unread',
        snippet: 'Excerpt',
        captured_at: new Date('2026-05-12T00:00:00Z').getTime()
      }
    ])
    await expect(handles.inbox.list({ unread_only: false })).resolves.toEqual([
      expect.objectContaining({ id: 'inbox-1', snippet: 'Excerpt' }),
      expect.objectContaining({
        id: 'inbox-2',
        source: 'share',
        snippet: 'Read body',
        visual_type: 'quote'
      })
    ])
    await expect(
      handles.inbox.add({ source: 'api', title: 'Captured', content: 'Body' })
    ).resolves.toEqual({ id: 'inbox-created' })

    await expect(
      handles.inbox.add({ source: 'inline', title: 'Captured', content: 'Body' })
    ).resolves.toEqual({ id: 'inbox-created' })

    mocks.createDesktopInboxDomain.mockReturnValueOnce({
      captureText: vi
        .fn()
        .mockResolvedValue({ success: false, item: null, error: 'capture failed' })
    })
    await expect(
      handles.inbox.add({ source: 'inline', title: 'Bad', content: 'Body' })
    ).rejects.toThrow('capture failed')

    await expect(handles.inbox.get('inbox-1')).resolves.toBeNull()
    await expect(handles.inbox.update({ id: 'inbox-1', title: 'Updated' })).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(
      handles.inbox.snooze({
        id: 'inbox-1',
        snooze_until: '2026-05-15T09:00:00.000Z',
        reason: 'Review tomorrow'
      })
    ).resolves.toEqual({ id: 'inbox-1' })
    await expect(handles.inbox.archive('inbox-1')).resolves.toEqual({ id: 'inbox-1' })
    await expect(handles.inbox.unarchive('inbox-1')).resolves.toEqual({ id: 'inbox-1' })
    await expect(handles.inbox.delete('inbox-1')).resolves.toEqual({ id: 'inbox-1' })
    await expect(handles.inbox.addTag({ id: 'inbox-1', tag: 'work' })).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(handles.inbox.removeTag({ id: 'inbox-1', tag: 'work' })).resolves.toEqual({
      id: 'inbox-1'
    })

    mocks.createDesktopInboxCrudHandlers.mockReturnValueOnce({
      handleUpdate: vi.fn().mockResolvedValue({ success: false, error: 'update failed' })
    })
    await expect(handles.inbox.update({ id: 'bad', title: 'Bad' })).rejects.toThrow('update failed')

    mocks.createDesktopInboxDomain.mockReturnValueOnce({
      snooze: vi.fn().mockResolvedValue({ success: false, error: 'snooze failed' })
    })
    await expect(
      handles.inbox.snooze({ id: 'bad', snooze_until: '2026-05-15T09:00:00.000Z' })
    ).rejects.toThrow('snooze failed')

    mocks.getAllTagsWithCounts.mockReturnValue([{ name: 'focus', count: 3 }])
    await expect(handles.tags.listAll()).resolves.toEqual([{ name: 'focus', count: 3 }])

    mocks.snapshotCurrentNoteFromWindow.mockResolvedValue({ id: 'note-1' })
    await expect(handles.windows.snapshotCurrentNote('window-1')).resolves.toEqual({ id: 'note-1' })

    mocks.invokeDesktopApiFromWindow.mockResolvedValueOnce({ templates: [] })
    await expect(
      handles.desktop.read({ operation: 'templates.list', args: [] }, 'window-1')
    ).resolves.toEqual({
      templates: []
    })
    expect(mocks.invokeDesktopApiFromWindow).toHaveBeenLastCalledWith('window-1', {
      operation: 'templates.list',
      args: []
    })

    mocks.invokeDesktopApiFromWindow.mockResolvedValueOnce({ id: 'template-1' })
    await expect(
      handles.desktop.write(
        { operation: 'templates.create', args: [{ name: 'Template' }] },
        'window-1'
      )
    ).resolves.toEqual({ id: 'template-1' })
    expect(mocks.invokeDesktopApiFromWindow).toHaveBeenLastCalledWith('window-1', {
      operation: 'templates.create',
      args: [{ name: 'Template' }]
    })
  })
})
