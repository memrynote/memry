import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { NotesChannels } from '@memry/contracts/notes-api'
import { PropertyTypes } from '@memry/contracts/property-types'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  const removeHandler = vi.fn((channel: string) => handlers.delete(channel))
  const webContents = {
    printToPDF: vi.fn().mockResolvedValue(Buffer.from('pdf'))
  }
  const windowInstance = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    webContents,
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false)
  }
  const BrowserWindow = Object.assign(
    vi.fn(function BrowserWindowMock() {
      return windowInstance
    }),
    {
      getAllWindows: vi.fn(() => [])
    }
  )

  return {
    handlers,
    removeHandler,
    dialog: {
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn()
    },
    BrowserWindow,
    windowInstance,
    webContents,
    fsWriteFile: vi.fn(),
    fsRm: vi.fn(),
    appGetPath: vi.fn(() => '/tmp'),
    resolveNoteByTitle: vi.fn(),
    resolveNotesByTitles: vi.fn(),
    getNoteTags: vi.fn(),
    getAllTagDefinitions: vi.fn(),
    deleteNoteSnapshot: vi.fn(),
    getNotesInFolder: vi.fn(),
    reorderNotesInFolder: vi.fn(),
    getAllNotePositions: vi.fn(),
    getNoteById: vi.fn(),
    saveAttachment: vi.fn(),
    listNoteAttachments: vi.fn(),
    deleteAttachment: vi.fn(),
    importFiles: vi.fn(),
    getVersionHistory: vi.fn(),
    getVersion: vi.fn(),
    restoreVersion: vi.fn(),
    readFolderConfig: vi.fn(),
    writeFolderConfig: vi.fn(),
    getFolderTemplate: vi.fn(),
    syncFolderConfigSet: vi.fn(),
    syncFolderConfigRename: vi.fn(),
    syncFolderConfigDelete: vi.fn(),
    setNoteLocalOnlyCommand: vi.fn(),
    createPropertyDefinitionRecord: vi.fn(),
    updatePropertyDefinitionRecord: vi.fn(),
    deletePropertyDefinitionRecord: vi.fn(),
    countLocalOnlyNoteMetadata: vi.fn(),
    listPropertyDefinitions: vi.fn(),
    emitNoteAttachmentSaved: vi.fn(),
    getVaultStatus: vi.fn(() => ({ path: null }) as { path: string | null }),
    renderNoteAsHtml: vi.fn(() => '<html><body>note</body></html>'),
    service: {
      get: vi.fn(),
      upsert: vi.fn(),
      addOption: vi.fn(),
      addStatusOption: vi.fn(),
      removeOption: vi.fn(),
      renameOption: vi.fn(),
      updateOptionColor: vi.fn(),
      remove: vi.fn()
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
      mocks.handlers.set(channel, handler)
    }),
    removeHandler: mocks.removeHandler
  },
  dialog: mocks.dialog,
  BrowserWindow: mocks.BrowserWindow,
  app: { getPath: mocks.appGetPath }
}))

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs/promises')>()),
  writeFile: mocks.fsWriteFile,
  rm: mocks.fsRm
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => ({ id: 'data-db' })),
  getIndexDatabase: vi.fn(() => ({ id: 'index-db' }))
}))

vi.mock('../vault/notes', () => ({
  getNoteById: mocks.getNoteById,
  getNoteByPath: vi.fn(),
  getFileById: vi.fn(),
  listNotes: vi.fn(),
  getTagsWithCounts: vi.fn(),
  getNoteLinks: vi.fn(),
  getFolders: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  noteExists: vi.fn(),
  openExternal: vi.fn(),
  revealInFinder: vi.fn(),
  getVersionHistory: mocks.getVersionHistory,
  getVersion: mocks.getVersion,
  restoreVersion: mocks.restoreVersion,
  importFiles: mocks.importFiles
}))

vi.mock('../notes/domain', () => ({
  createNoteCommand: vi.fn(),
  updateNoteCommand: vi.fn(),
  renameNoteCommand: vi.fn(),
  moveNoteCommand: vi.fn(),
  deleteNoteCommand: vi.fn(),
  setNoteLocalOnlyCommand: mocks.setNoteLocalOnlyCommand
}))

vi.mock('../notes/store', () => ({
  resolveNoteByTitle: mocks.resolveNoteByTitle,
  resolveNotesByTitles: mocks.resolveNotesByTitles,
  getNoteTags: mocks.getNoteTags,
  getAllTagDefinitions: mocks.getAllTagDefinitions,
  deleteNoteSnapshot: mocks.deleteNoteSnapshot,
  getNotesInFolder: mocks.getNotesInFolder,
  reorderNotesInFolder: mocks.reorderNotesInFolder,
  getAllNotePositions: mocks.getAllNotePositions
}))

vi.mock('../vault/attachments', () => ({
  saveAttachment: mocks.saveAttachment,
  deleteAttachment: mocks.deleteAttachment,
  listNoteAttachments: mocks.listNoteAttachments
}))

vi.mock('../vault/folders', () => ({
  readFolderConfig: mocks.readFolderConfig,
  writeFolderConfig: mocks.writeFolderConfig,
  getFolderTemplate: mocks.getFolderTemplate
}))

vi.mock('../notes/folder-config-effects', () => ({
  syncFolderConfigSet: mocks.syncFolderConfigSet,
  syncFolderConfigRename: mocks.syncFolderConfigRename,
  syncFolderConfigDelete: mocks.syncFolderConfigDelete
}))

vi.mock('../vault/property-definition-store', () => ({
  createPropertyDefinitionRecord: mocks.createPropertyDefinitionRecord,
  updatePropertyDefinitionRecord: mocks.updatePropertyDefinitionRecord,
  deletePropertyDefinitionRecord: mocks.deletePropertyDefinitionRecord
}))

vi.mock('../vault/property-definitions', () => ({
  DEFAULT_STATUS_DEFINITION: {
    name: 'Status',
    type: 'status',
    categories: { todo: [], in_progress: [], done: [] }
  },
  PropertyDefinitionsService: {
    get: () => mocks.service
  }
}))

vi.mock('../lib/export-utils', () => ({
  renderNoteAsHtml: mocks.renderNoteAsHtml,
  sanitizeFilename: vi.fn((value: string) => value.replace(/\W+/g, '_'))
}))

vi.mock('../vault/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault/index')>()),
  getStatus: mocks.getVaultStatus
}))

vi.mock('../lib/main-i18n', () => ({
  getMainI18n: () => ({
    t: (key: string) => key,
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('../notes/runtime-effects', () => ({
  emitNoteAttachmentSaved: mocks.emitNoteAttachmentSaved
}))

vi.mock('../telemetry/track', () => ({
  trackMainEvent: vi.fn()
}))

vi.mock('@memry/storage-data', () => ({
  countLocalOnlyNoteMetadata: mocks.countLocalOnlyNoteMetadata,
  listPropertyDefinitions: mocks.listPropertyDefinitions
}))

vi.mock('@memry/shared/file-types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@memry/shared/file-types')>()),
  getAllSupportedExtensions: vi.fn(() => ['md', 'pdf', 'png'])
}))

import { registerNotesHandlers, unregisterNotesHandlers } from './notes-handlers'

const invoke = async (channel: string, input?: unknown): Promise<unknown> => {
  const handler = mocks.handlers.get(channel)
  expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')
  return handler?.({}, input)
}

const successful = (result: unknown): unknown => {
  if (result && typeof result === 'object' && 'success' in result) {
    expect((result as { success: boolean }).success).toBe(true)
  }
  return result
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)
const PNG_BASE64 = PNG_BYTES.toString('base64')

describe('notes-handlers extra coverage', () => {
  let vaultPath: string

  beforeEach(() => {
    vaultPath = mkdtempSync(path.join(tmpdir(), 'memry-export-handler-'))
    mkdirSync(path.join(vaultPath, 'attachments', 'note-a'), { recursive: true })
    writeFileSync(path.join(vaultPath, 'attachments', 'note-a', 'photo.png'), PNG_BYTES)
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.webContents.printToPDF.mockResolvedValue(Buffer.from('pdf'))
    mocks.windowInstance.loadURL.mockResolvedValue(undefined)
    mocks.windowInstance.loadFile.mockResolvedValue(undefined)
    mocks.windowInstance.isDestroyed.mockReturnValue(false)
    mocks.fsWriteFile.mockResolvedValue(undefined)
    mocks.fsRm.mockResolvedValue(undefined)
    mocks.appGetPath.mockReturnValue('/tmp')
    mocks.service.get.mockReturnValue(null)
    mocks.getVaultStatus.mockReturnValue({ path: null })
    mocks.renderNoteAsHtml.mockReturnValue('<html><body>note</body></html>')
    registerNotesHandlers()
  })

  afterEach(() => {
    unregisterNotesHandlers()
    mocks.handlers.clear()
    rmSync(vaultPath, { recursive: true, force: true })
  })

  it('resolves a batch of titles into a plain record over one channel', async () => {
    mocks.resolveNotesByTitles.mockReturnValueOnce(
      new Map([
        ['Meeting Notes', { id: 'nte_meeting', path: 'Meeting Notes.md' }],
        ['Missing', null]
      ])
    )

    await expect(
      invoke(NotesChannels.invoke.RESOLVE_TITLES, ['Meeting Notes', 'Missing'])
    ).resolves.toEqual({
      'Meeting Notes': { id: 'nte_meeting', path: 'Meeting Notes.md' },
      Missing: null
    })
    expect(mocks.resolveNotesByTitles).toHaveBeenCalledWith(expect.anything(), [
      'Meeting Notes',
      'Missing'
    ])
  })

  it('resolves WikiLink targets and preview metadata with tag colors', async () => {
    mocks.resolveNoteByTitle.mockReturnValueOnce(null)

    await expect(invoke(NotesChannels.invoke.RESOLVE_BY_TITLE, 'Missing')).resolves.toBeNull()

    mocks.resolveNoteByTitle.mockReturnValueOnce({
      id: 'note-a',
      path: 'Daily.md',
      title: 'Daily',
      fileType: null
    })

    expect(await invoke(NotesChannels.invoke.RESOLVE_BY_TITLE, 'Daily')).toEqual({
      id: 'note-a',
      path: 'Daily.md',
      title: 'Daily',
      fileType: 'markdown'
    })

    mocks.resolveNoteByTitle.mockReturnValueOnce({
      id: 'note-a',
      title: 'Daily',
      fileType: 'markdown',
      emoji: 'x',
      snippet: 'Preview text',
      createdAt: '2026-05-10T00:00:00.000Z'
    })
    mocks.getNoteTags.mockReturnValue(['work', 'plain'])
    mocks.getAllTagDefinitions.mockReturnValue([{ name: 'work', color: 'blue' }])

    expect(await invoke(NotesChannels.invoke.PREVIEW_BY_TITLE, 'Daily')).toEqual({
      id: 'note-a',
      title: 'Daily',
      emoji: 'x',
      snippet: 'Preview text',
      tags: [
        { name: 'work', color: 'blue' },
        { name: 'plain', color: 'stone' }
      ],
      createdAt: '2026-05-10T00:00:00.000Z'
    })

    mocks.resolveNoteByTitle.mockReturnValueOnce({ id: 'asset-a', fileType: 'pdf' })
    await expect(invoke(NotesChannels.invoke.PREVIEW_BY_TITLE, 'Asset')).resolves.toBeNull()
  })

  // #1557: `resolveByTitle` is heading-blind by contract, so an agent following
  // `[[Meeting#Decisions]]` used to get `null`.
  it('resolves a heading target to its note half, and a `#` title to itself', async () => {
    const meeting = { id: 'note-m', path: 'Meeting.md', title: 'Meeting', fileType: 'markdown' }
    mocks.resolveNoteByTitle.mockImplementation((_db: unknown, title: string) =>
      title === 'Meeting' ? meeting : undefined
    )

    expect(await invoke(NotesChannels.invoke.RESOLVE_WIKI_TARGET, 'Meeting#Decisions')).toEqual({
      id: 'note-m',
      path: 'Meeting.md',
      title: 'Meeting',
      fileType: 'markdown',
      heading: 'Decisions'
    })

    const sprint = { id: 'note-s', path: 'Sprint #4.md', title: 'Sprint #4', fileType: null }
    mocks.resolveNoteByTitle.mockImplementation((_db: unknown, title: string) =>
      title === 'Sprint #4' ? sprint : undefined
    )

    expect(await invoke(NotesChannels.invoke.RESOLVE_WIKI_TARGET, 'Sprint #4')).toEqual({
      id: 'note-s',
      path: 'Sprint #4.md',
      title: 'Sprint #4',
      fileType: 'markdown',
      heading: null
    })

    mocks.resolveNoteByTitle.mockImplementation(() => undefined)
    await expect(invoke(NotesChannels.invoke.RESOLVE_WIKI_TARGET, 'Missing#H')).resolves.toBeNull()
  })

  it('handles property definition and option mutation branches', async () => {
    mocks.createPropertyDefinitionRecord.mockReturnValue({ name: 'Rating', type: 'number' })

    expect(
      successful(
        await invoke(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION, {
          name: 'Rating',
          type: PropertyTypes.NUMBER,
          defaultValue: 5,
          color: 'blue'
        })
      )
    ).toEqual({ success: true, definition: { name: 'Rating', type: 'number' } })
    expect(mocks.createPropertyDefinitionRecord).toHaveBeenCalledWith({
      name: 'Rating',
      type: PropertyTypes.NUMBER,
      options: null,
      defaultValue: '5',
      color: 'blue'
    })

    mocks.service.get.mockReturnValueOnce({ name: 'Status', type: 'status' })
    await invoke(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION, {
      name: 'Status',
      type: PropertyTypes.STATUS,
      defaultValue: true
    })
    expect(mocks.service.upsert).toHaveBeenCalledWith({
      name: 'Status',
      type: PropertyTypes.STATUS,
      options: undefined,
      defaultValue: 'true'
    })

    mocks.service.get.mockReturnValueOnce(null)
    expect(
      await invoke(NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION, {
        name: 'Missing',
        type: PropertyTypes.SELECT
      })
    ).toEqual({
      success: false,
      definition: null,
      error: 'system:error.definitionNotFound'
    })

    mocks.service.get.mockReturnValueOnce({ name: 'Status', type: 'status', options: [] })
    await invoke(NotesChannels.invoke.UPDATE_PROPERTY_DEFINITION, {
      name: 'Status',
      type: PropertyTypes.STATUS,
      defaultValue: new Date('2026-05-10T00:00:00.000Z')
    })
    expect(mocks.service.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'Status',
        defaultValue: '2026-05-10T00:00:00.000Z'
      })
    )

    mocks.service.get.mockReturnValueOnce(null)
    await invoke(NotesChannels.invoke.ENSURE_PROPERTY_DEFINITION, {
      name: 'Mood',
      type: PropertyTypes.SELECT
    })
    expect(mocks.service.upsert).toHaveBeenLastCalledWith({
      name: 'Mood',
      type: PropertyTypes.SELECT,
      options: []
    })

    mocks.service.get.mockReturnValueOnce(null)
    await invoke(NotesChannels.invoke.ADD_PROPERTY_OPTION, {
      propertyName: 'Mood',
      option: { value: 'Focused', color: 'green' }
    })
    expect(mocks.service.upsert).toHaveBeenLastCalledWith({
      name: 'Mood',
      type: 'select',
      options: [{ value: 'Focused', color: 'green' }]
    })

    mocks.service.get.mockReturnValueOnce({ name: 'Mood', type: 'select' })
    await invoke(NotesChannels.invoke.ADD_PROPERTY_OPTION, {
      propertyName: 'Mood',
      option: { value: 'Calm', color: 'blue' }
    })
    expect(mocks.service.addOption).toHaveBeenCalledWith('Mood', { value: 'Calm', color: 'blue' })

    mocks.service.get.mockReturnValueOnce(null)
    await invoke(NotesChannels.invoke.ADD_STATUS_OPTION, {
      propertyName: 'Status',
      categoryKey: 'todo',
      option: { value: 'Queued', color: 'gray' }
    })
    expect(mocks.service.addStatusOption).toHaveBeenCalledWith('Status', 'todo', {
      value: 'Queued',
      color: 'gray'
    })

    await invoke(NotesChannels.invoke.REMOVE_PROPERTY_OPTION, {
      propertyName: 'Mood',
      optionValue: 'Calm'
    })
    await invoke(NotesChannels.invoke.RENAME_PROPERTY_OPTION, {
      propertyName: 'Mood',
      oldValue: 'Focused',
      newValue: 'Deep work'
    })
    await invoke(NotesChannels.invoke.UPDATE_OPTION_COLOR, {
      propertyName: 'Mood',
      optionValue: 'Deep work',
      newColor: 'purple'
    })
    await invoke(NotesChannels.invoke.DELETE_PROPERTY_DEFINITION, { name: 'Mood' })

    expect(mocks.service.removeOption).toHaveBeenCalledWith('Mood', 'Calm')
    expect(mocks.service.renameOption).toHaveBeenCalledWith('Mood', 'Focused', 'Deep work')
    expect(mocks.service.updateOptionColor).toHaveBeenCalledWith('Mood', 'Deep work', 'purple')
    expect(mocks.service.remove).toHaveBeenCalledWith('Mood')
    expect(mocks.deletePropertyDefinitionRecord).toHaveBeenCalledWith('Mood')
  })

  it('handles attachments and import dialog workflows', async () => {
    // The real shape a saved attachment comes back in: `path` is the
    // note-relative ref that goes into the markdown, and only `diskPath` says
    // where the bytes are. Feeding `path` to the sync emit threw on every save
    // and the attachment never left the device — so this asserts the emit gets
    // the disk path, not something derived from the ref.
    mocks.saveAttachment.mockResolvedValue({
      success: true,
      path: '../attachments/note-a/file.png',
      diskPath: '/vault/attachments/note-a/file.png'
    })
    await invoke(NotesChannels.invoke.UPLOAD_ATTACHMENT, {
      noteId: 'note-a',
      filename: 'file.png',
      data: [1, 2, 3]
    })
    expect(mocks.emitNoteAttachmentSaved).toHaveBeenCalledWith(
      'note-a',
      '/vault/attachments/note-a/file.png'
    )

    mocks.listNoteAttachments.mockResolvedValue([{ filename: 'file.png' }])
    await expect(invoke(NotesChannels.invoke.LIST_ATTACHMENTS, 'note-a')).resolves.toEqual([
      { filename: 'file.png' }
    ])

    await invoke(NotesChannels.invoke.DELETE_ATTACHMENT, {
      noteId: 'note-a',
      filename: 'file.png'
    })
    expect(mocks.deleteAttachment).toHaveBeenCalledWith('note-a', 'file.png')

    mocks.importFiles.mockResolvedValue({
      success: true,
      imported: 2,
      failed: 0,
      errors: [],
      importedFiles: [
        { destPath: '/vault/notes/Doc.md', filename: 'Doc.md', fileType: 'markdown' },
        { destPath: '/vault/notes/photo.png', filename: 'photo.png', fileType: 'image' }
      ]
    })

    await invoke(NotesChannels.invoke.IMPORT_FILES, {
      sourcePaths: ['/tmp/Doc.md', '/tmp/photo.png'],
      targetFolder: 'Inbox'
    })
    expect(mocks.emitNoteAttachmentSaved).toHaveBeenCalledWith(
      'vault-import',
      '/vault/notes/photo.png'
    )

    mocks.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(invoke(NotesChannels.invoke.SHOW_IMPORT_DIALOG)).resolves.toEqual({
      canceled: true,
      filePaths: []
    })

    mocks.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/Doc.md']
    })
    await expect(invoke(NotesChannels.invoke.SHOW_IMPORT_DIALOG)).resolves.toEqual({
      canceled: false,
      filePaths: ['/tmp/Doc.md']
    })
  })

  it('exports notes to PDF and HTML with canceled and missing-note guards', async () => {
    mocks.getNoteById.mockResolvedValueOnce(null)
    expect(await invoke(NotesChannels.invoke.EXPORT_PDF, { noteId: 'missing' })).toEqual({
      success: false,
      error: 'error.noteNotFound'
    })

    const note = {
      id: 'note-a',
      path: 'Note.md',
      title: 'Daily note',
      content: '# Today',
      emoji: null,
      tags: ['work'],
      created: new Date('2026-05-10T00:00:00.000Z'),
      modified: new Date('2026-05-10T00:00:00.000Z')
    }
    mocks.getNoteById.mockResolvedValue(note)
    mocks.getVaultStatus.mockReturnValue({ path: vaultPath })
    mocks.renderNoteAsHtml.mockReturnValue(
      '<html><body><img src="attachments/note-a/photo.png"></body></html>'
    )
    mocks.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/Daily_note.pdf'
    })

    await expect(
      invoke(NotesChannels.invoke.EXPORT_PDF, {
        noteId: 'note-a',
        includeMetadata: true,
        pageSize: 'Letter'
      })
    ).resolves.toEqual({ success: true, path: '/tmp/Daily_note.pdf' })
    expect(mocks.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ show: false, width: 800, height: 600 })
    )
    expect(mocks.webContents.printToPDF).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 'Letter', printBackground: true })
    )
    expect(mocks.fsWriteFile).toHaveBeenCalledWith('/tmp/Daily_note.pdf', Buffer.from('pdf'))

    // Staged to a real file rather than a `data:` URL, which Chromium rejects
    // past its length ceiling once an image is inlined.
    const staged = mocks.windowInstance.loadFile.mock.calls.at(-1)?.[0] as string
    expect(staged).toMatch(/^\/tmp\/memry-export-.+\.html$/)
    expect(mocks.fsWriteFile).toHaveBeenCalledWith(
      staged,
      `<html><body><img src="data:image/png;base64,${PNG_BASE64}"></body></html>`,
      'utf-8'
    )
    expect(mocks.fsRm).toHaveBeenCalledWith(staged, { force: true })

    mocks.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(
      invoke(NotesChannels.invoke.EXPORT_HTML, {
        noteId: 'note-a',
        includeMetadata: false,
        pageSize: 'A4'
      })
    ).resolves.toEqual({ success: false, error: 'dialog.exportCancelled' })

    mocks.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/tmp/Daily_note.html'
    })
    await expect(
      invoke(NotesChannels.invoke.EXPORT_HTML, {
        noteId: 'note-a',
        includeMetadata: false,
        pageSize: 'A4'
      })
    ).resolves.toEqual({ success: true, path: '/tmp/Daily_note.html' })
    // Self-contained, so the file keeps its images once the user moves it.
    expect(mocks.fsWriteFile).toHaveBeenCalledWith(
      '/tmp/Daily_note.html',
      `<html><body><img src="data:image/png;base64,${PNG_BASE64}"></body></html>`,
      'utf-8'
    )
  })

  it('leaves an image it cannot read as written', async () => {
    mocks.getNoteById.mockResolvedValue({
      id: 'note-a',
      path: 'Note.md',
      title: 'Daily note',
      content: '# Today',
      emoji: null,
      tags: [],
      created: new Date('2026-05-10T00:00:00.000Z'),
      modified: new Date('2026-05-10T00:00:00.000Z')
    })
    mocks.getVaultStatus.mockReturnValue({ path: vaultPath })
    mocks.renderNoteAsHtml.mockReturnValue('<img src="attachments/note-a/missing.png">')

    await expect(
      invoke(NotesChannels.invoke.EXPORT_HTML, {
        noteId: 'note-a',
        outputPath: '/tmp/Daily_note.html',
        includeMetadata: false,
        pageSize: 'A4'
      })
    ).resolves.toEqual({ success: true, path: '/tmp/Daily_note.html' })
    expect(mocks.fsWriteFile).toHaveBeenCalledWith(
      '/tmp/Daily_note.html',
      '<img src="attachments/note-a/missing.png">',
      'utf-8'
    )
  })

  it('still exports when the staged HTML cannot be removed', async () => {
    mocks.getNoteById.mockResolvedValue({
      id: 'note-a',
      path: 'Note.md',
      title: 'Daily note',
      content: '# Today',
      emoji: null,
      tags: [],
      created: new Date('2026-05-10T00:00:00.000Z'),
      modified: new Date('2026-05-10T00:00:00.000Z')
    })
    mocks.fsRm.mockRejectedValueOnce(new Error('EBUSY'))

    await expect(
      invoke(NotesChannels.invoke.EXPORT_PDF, {
        noteId: 'note-a',
        outputPath: '/tmp/Daily_note.pdf',
        includeMetadata: false,
        pageSize: 'A4'
      })
    ).resolves.toEqual({ success: true, path: '/tmp/Daily_note.pdf' })
  })

  it('destroys the hidden PDF window when rendering fails', async () => {
    const note = {
      id: 'note-a',
      title: 'Daily note',
      content: '# Today',
      emoji: null,
      tags: ['work'],
      created: new Date('2026-05-10T00:00:00.000Z'),
      modified: new Date('2026-05-10T00:00:00.000Z')
    }
    mocks.getNoteById.mockResolvedValue(note)

    mocks.webContents.printToPDF.mockRejectedValueOnce(new Error('printToPDF crashed'))
    expect(
      await invoke(NotesChannels.invoke.EXPORT_PDF, {
        noteId: 'note-a',
        outputPath: '/tmp/Daily_note.pdf',
        includeMetadata: false,
        pageSize: 'A4'
      })
    ).toEqual({ success: false, error: 'printToPDF crashed' })
    expect(mocks.windowInstance.destroy).toHaveBeenCalledTimes(1)
    expect(mocks.fsWriteFile).not.toHaveBeenCalledWith('/tmp/Daily_note.pdf', expect.anything())
    // The staged HTML is removed even when the print fails.
    const staged = mocks.windowInstance.loadFile.mock.calls.at(-1)?.[0] as string
    expect(mocks.fsRm).toHaveBeenCalledWith(staged, { force: true })

    mocks.windowInstance.destroy.mockClear()
    mocks.windowInstance.loadFile.mockRejectedValueOnce(new Error('loadFile crashed'))
    expect(
      await invoke(NotesChannels.invoke.EXPORT_PDF, {
        noteId: 'note-a',
        outputPath: '/tmp/Daily_note.pdf',
        includeMetadata: false,
        pageSize: 'A4'
      })
    ).toEqual({ success: false, error: 'loadFile crashed' })
    expect(mocks.windowInstance.destroy).toHaveBeenCalledTimes(1)

    // An already-destroyed window is never destroyed twice.
    mocks.windowInstance.destroy.mockClear()
    mocks.windowInstance.isDestroyed.mockReturnValue(true)
    mocks.webContents.printToPDF.mockRejectedValueOnce(new Error('printToPDF crashed'))
    expect(
      await invoke(NotesChannels.invoke.EXPORT_PDF, {
        noteId: 'note-a',
        outputPath: '/tmp/Daily_note.pdf',
        includeMetadata: false,
        pageSize: 'A4'
      })
    ).toEqual({ success: false, error: 'printToPDF crashed' })
    expect(mocks.windowInstance.destroy).not.toHaveBeenCalled()
  })

  it('handles position, version, folder, and local-only helper handlers', async () => {
    mocks.getVersionHistory.mockReturnValue([{ id: 'snapshot-a' }])
    mocks.getVersion.mockReturnValue({ id: 'snapshot-a', content: 'old' })
    mocks.restoreVersion.mockResolvedValue({ id: 'note-a' })
    mocks.getNotesInFolder.mockReturnValue([{ path: 'A.md', position: 0 }])
    mocks.getAllNotePositions.mockReturnValue([
      { path: 'A.md', position: 0 },
      { path: 'B.md', position: 1 }
    ])
    mocks.setNoteLocalOnlyCommand.mockResolvedValue({ id: 'note-a', localOnly: true })
    mocks.countLocalOnlyNoteMetadata.mockReturnValue(3)
    mocks.readFolderConfig.mockResolvedValue({ icon: 'folder' })
    mocks.getFolderTemplate.mockResolvedValue('template-a')

    await expect(invoke(NotesChannels.invoke.GET_VERSIONS, 'note-a')).resolves.toEqual([
      { id: 'snapshot-a' }
    ])
    await expect(invoke(NotesChannels.invoke.GET_VERSION, 'snapshot-a')).resolves.toEqual({
      id: 'snapshot-a',
      content: 'old'
    })
    await expect(invoke(NotesChannels.invoke.RESTORE_VERSION, 'snapshot-a')).resolves.toEqual({
      success: true,
      note: { id: 'note-a' }
    })
    await expect(invoke(NotesChannels.invoke.DELETE_VERSION, 'snapshot-a')).resolves.toEqual({
      success: true
    })
    expect(mocks.deleteNoteSnapshot).toHaveBeenCalledWith({ id: 'index-db' }, 'snapshot-a')

    await expect(
      invoke(NotesChannels.invoke.GET_POSITIONS, { folderPath: 'Projects' })
    ).resolves.toEqual({ success: true, positions: [{ path: 'A.md', position: 0 }] })
    await expect(invoke(NotesChannels.invoke.GET_ALL_POSITIONS)).resolves.toEqual({
      success: true,
      positions: { 'A.md': 0, 'B.md': 1 }
    })
    await expect(
      invoke(NotesChannels.invoke.REORDER, {
        folderPath: 'Projects',
        notePaths: ['B.md', 'A.md']
      })
    ).resolves.toEqual({ success: true })

    await expect(invoke(NotesChannels.invoke.GET_FOLDER_CONFIG, 'Projects')).resolves.toEqual({
      icon: 'folder'
    })
    await expect(invoke(NotesChannels.invoke.GET_FOLDER_TEMPLATE, 'Projects')).resolves.toBe(
      'template-a'
    )

    await expect(
      invoke(NotesChannels.invoke.SET_LOCAL_ONLY, { id: 'note-a', localOnly: true })
    ).resolves.toEqual({ success: true, note: { id: 'note-a', localOnly: true } })
    await expect(invoke(NotesChannels.invoke.GET_LOCAL_ONLY_COUNT)).resolves.toEqual({ count: 3 })
  })
})
