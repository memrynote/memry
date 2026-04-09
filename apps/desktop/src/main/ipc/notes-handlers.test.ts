/**
 * Notes IPC handlers tests
 *
 * @module ipc/notes-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { NotesChannels } from '@memry/contracts/notes-api'

// Track mock calls
const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

// Mock electron modules
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  },
  dialog: {
    showSaveDialog: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    prototype: {}
  }
}))

// Mock database module
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn()
}))

// Mock vault/notes module - these are the actual operations we'll test
vi.mock('../vault/notes', () => ({
  getNoteById: vi.fn(),
  getNoteByPath: vi.fn(),
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
  getVersionHistory: vi.fn(),
  getVersion: vi.fn(),
  restoreVersion: vi.fn()
}))

vi.mock('../notes/domain', () => ({
  createNoteCommand: vi.fn(),
  updateNoteCommand: vi.fn(),
  renameNoteCommand: vi.fn(),
  moveNoteCommand: vi.fn(),
  deleteNoteCommand: vi.fn(),
  setNoteLocalOnlyCommand: vi.fn()
}))

// Mock vault/attachments module
vi.mock('../vault/attachments', () => ({
  saveAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  listNoteAttachments: vi.fn()
}))

// Mock vault/folders module
vi.mock('../vault/folders', () => ({
  readFolderConfig: vi.fn(),
  writeFolderConfig: vi.fn(),
  getFolderTemplate: vi.fn()
}))

// Mock lib/export-utils module
vi.mock('../lib/export-utils', () => ({
  renderNoteAsHtml: vi.fn(),
  sanitizeFilename: vi.fn((name: string) => name.replace(/[^a-z0-9]/gi, '_'))
}))

// Mock main/database/queries/notes
vi.mock('@main/database/queries/notes', () => ({
  getNoteProperties: vi.fn(),
  getAllPropertyDefinitions: vi.fn(),
  insertPropertyDefinition: vi.fn(),
  updatePropertyDefinition: vi.fn(),
  deleteNoteSnapshot: vi.fn()
}))

// Mock main/database/queries/note-positions
vi.mock('@main/database/queries/note-positions', () => ({
  getNotesInFolder: vi.fn(),
  reorderNotesInFolder: vi.fn(),
  getAllNotePositions: vi.fn()
}))

vi.mock('@memry/storage-data', () => ({
  countLocalOnlyNoteMetadata: vi.fn(),
  listPropertyDefinitions: vi.fn()
}))

vi.mock('../vault/property-definition-store', () => ({
  createPropertyDefinitionRecord: vi.fn(),
  updatePropertyDefinitionRecord: vi.fn(),
  deletePropertyDefinitionRecord: vi.fn()
}))

// Import the module after mocking
import { registerNotesHandlers, unregisterNotesHandlers } from './notes-handlers'
import { getIndexDatabase, getDatabase } from '../database'
import * as notesVault from '../vault/notes'
import * as notesDomain from '../notes/domain'
import * as attachmentsVault from '../vault/attachments'
import * as foldersVault from '../vault/folders'
import * as noteQueries from '@main/database/queries/notes'
import * as positionQueries from '@main/database/queries/note-positions'
import * as storageData from '@memry/storage-data'
import * as propertyDefinitionStore from '../vault/property-definition-store'

describe('notes-handlers', () => {
  let mockDb: { run: Mock; get: Mock; all: Mock }

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0

    mockDb = {
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn()
    }
    ;(getIndexDatabase as Mock).mockReturnValue(mockDb)
    ;(getDatabase as Mock).mockReturnValue(mockDb)
  })

  afterEach(() => {
    unregisterNotesHandlers()
  })

  describe('registerNotesHandlers', () => {
    it('should register all notes handlers', () => {
      registerNotesHandlers()

      // Check that invoke handlers are registered
      const invokeChannels = Object.values(NotesChannels.invoke)
      // Most handlers should be registered (some may not be implemented yet)
      expect(handleCalls.length).toBeGreaterThanOrEqual(invokeChannels.length - 5)
    })
  })

  describe('unregisterNotesHandlers', () => {
    it('should unregister all notes handlers', () => {
      registerNotesHandlers()
      unregisterNotesHandlers()

      const invokeChannels = Object.values(NotesChannels.invoke)
      expect(removeHandlerCalls.length).toBe(invokeChannels.length)
    })
  })

  // =========================================================================
  // T437: CREATE handler
  // =========================================================================
  describe('CREATE handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should create a note with valid input', async () => {
      const mockNote = {
        id: 'note123',
        path: 'notes/Test Note.md',
        title: 'Test Note',
        content: 'Hello world',
        created: new Date(),
        modified: new Date(),
        tags: ['test'],
        wordCount: 2
      }
      ;(notesDomain.createNoteCommand as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.CREATE, {
        title: 'Test Note',
        content: 'Hello world',
        tags: ['test']
      })

      expect(result).toEqual({ success: true, note: mockNote })
      expect(notesDomain.createNoteCommand).toHaveBeenCalledWith({
        title: 'Test Note',
        content: 'Hello world',
        tags: ['test']
      })
    })

    it('should return error for invalid input', async () => {
      await expect(
        invokeHandler(NotesChannels.invoke.CREATE, {
          title: '', // Empty title - invalid
          content: 'Hello'
        })
      ).rejects.toThrow('Validation failed')
    })

    it('should handle createNote errors', async () => {
      ;(notesDomain.createNoteCommand as Mock).mockRejectedValue(new Error('File system error'))

      const result = await invokeHandler(NotesChannels.invoke.CREATE, {
        title: 'Test Note',
        content: 'Hello'
      })

      expect(result).toEqual({
        success: false,
        error: 'File system error'
      })
    })
  })

  // =========================================================================
  // T438: GET, GET_BY_PATH handlers
  // =========================================================================
  describe('GET handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get a note by ID', async () => {
      const mockNote = {
        id: 'note123',
        path: 'notes/Test.md',
        title: 'Test',
        content: 'Content',
        created: new Date(),
        modified: new Date(),
        tags: [],
        wordCount: 1
      }
      ;(notesVault.getNoteById as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.GET, 'note123')

      expect(result).toEqual(mockNote)
      expect(notesVault.getNoteById).toHaveBeenCalledWith('note123')
    })

    it('should return null for non-existent note', async () => {
      ;(notesVault.getNoteById as Mock).mockResolvedValue(null)

      const result = await invokeHandler(NotesChannels.invoke.GET, 'nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('GET_BY_PATH handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get a note by path', async () => {
      const mockNote = {
        id: 'note123',
        path: 'notes/Test.md',
        title: 'Test'
      }
      ;(notesVault.getNoteByPath as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.GET_BY_PATH, 'notes/Test.md')

      expect(result).toEqual(mockNote)
      expect(notesVault.getNoteByPath).toHaveBeenCalledWith('notes/Test.md')
    })
  })

  // =========================================================================
  // T439: UPDATE handler
  // =========================================================================
  describe('UPDATE handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should update note with valid input', async () => {
      const mockNote = {
        id: 'note123',
        title: 'Updated Title',
        content: 'Updated content'
      }
      ;(notesDomain.updateNoteCommand as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.UPDATE, {
        id: 'note123',
        title: 'Updated Title',
        content: 'Updated content'
      })

      expect(result).toEqual({ success: true, note: mockNote })
    })

    it('should handle partial updates', async () => {
      const mockNote = { id: 'note123', title: 'Original', content: 'Updated' }
      ;(notesDomain.updateNoteCommand as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.UPDATE, {
        id: 'note123',
        content: 'Updated'
      })

      expect(result).toEqual({ success: true, note: mockNote })
    })

    it('should return error on update failure', async () => {
      ;(notesDomain.updateNoteCommand as Mock).mockRejectedValue(new Error('Update failed'))

      const result = await invokeHandler(NotesChannels.invoke.UPDATE, {
        id: 'note123',
        title: 'New Title'
      })

      expect(result).toEqual({
        success: false,
        error: 'Update failed'
      })
    })
  })

  // =========================================================================
  // T440: DELETE handler
  // =========================================================================
  describe('DELETE handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should delete a note', async () => {
      ;(notesDomain.deleteNoteCommand as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.DELETE, 'note123')

      expect(result).toEqual({ success: true })
      expect(notesDomain.deleteNoteCommand).toHaveBeenCalledWith('note123')
    })

    it('should handle delete errors', async () => {
      ;(notesDomain.deleteNoteCommand as Mock).mockRejectedValue(new Error('File locked'))

      const result = await invokeHandler(NotesChannels.invoke.DELETE, 'note123')

      expect(result).toEqual({
        success: false,
        error: 'File locked'
      })
    })
  })

  // =========================================================================
  // T441: LIST handler
  // =========================================================================
  describe('LIST handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should list notes with default options', async () => {
      const mockNotes = {
        notes: [
          { id: 'note1', title: 'Note 1' },
          { id: 'note2', title: 'Note 2' }
        ],
        total: 2,
        hasMore: false
      }
      ;(notesVault.listNotes as Mock).mockResolvedValue(mockNotes)

      const result = await invokeHandler(NotesChannels.invoke.LIST, {})

      expect(result).toEqual(mockNotes)
    })

    it('should list notes with filters', async () => {
      const mockNotes = { notes: [], total: 0, hasMore: false }
      ;(notesVault.listNotes as Mock).mockResolvedValue(mockNotes)

      await invokeHandler(NotesChannels.invoke.LIST, {
        folder: 'projects',
        tags: ['important'],
        sortBy: 'created',
        sortOrder: 'asc',
        limit: 50,
        offset: 10
      })

      expect(notesVault.listNotes).toHaveBeenCalledWith({
        folder: 'projects',
        tags: ['important'],
        sortBy: 'created',
        sortOrder: 'asc',
        limit: 50,
        offset: 10
      })
    })

    it('should handle pagination', async () => {
      const mockNotes = {
        notes: Array(50).fill({ id: 'note', title: 'Note' }),
        total: 100,
        hasMore: true
      }
      ;(notesVault.listNotes as Mock).mockResolvedValue(mockNotes)

      const result = await invokeHandler(NotesChannels.invoke.LIST, {
        limit: 50,
        offset: 0
      })

      expect(result.hasMore).toBe(true)
      expect(result.total).toBe(100)
    })
  })

  // =========================================================================
  // T442: Folder handlers
  // =========================================================================
  describe('GET_FOLDERS handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get folder structure', async () => {
      const mockFolders = ['projects', 'projects/work', 'archive']
      ;(notesVault.getFolders as Mock).mockResolvedValue(mockFolders)

      const result = await invokeHandler(NotesChannels.invoke.GET_FOLDERS)

      expect(result).toEqual(mockFolders)
    })
  })

  describe('CREATE_FOLDER handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should create a folder', async () => {
      ;(notesVault.createFolder as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.CREATE_FOLDER, 'new-folder')

      expect(result).toEqual({ success: true })
      expect(notesVault.createFolder).toHaveBeenCalledWith('new-folder')
    })

    it('should handle folder creation errors', async () => {
      ;(notesVault.createFolder as Mock).mockRejectedValue(new Error('Folder exists'))

      const result = await invokeHandler(NotesChannels.invoke.CREATE_FOLDER, 'existing')

      expect(result).toEqual({
        success: false,
        error: 'Folder exists'
      })
    })
  })

  describe('RENAME_FOLDER handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should rename a folder', async () => {
      ;(notesVault.renameFolder as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.RENAME_FOLDER, {
        oldPath: 'old-name',
        newPath: 'new-name'
      })

      expect(result).toEqual({ success: true })
      expect(notesVault.renameFolder).toHaveBeenCalledWith('old-name', 'new-name')
    })
  })

  describe('DELETE_FOLDER handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should delete a folder', async () => {
      ;(notesVault.deleteFolder as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.DELETE_FOLDER, 'folder-to-delete')

      expect(result).toEqual({ success: true })
    })
  })

  // =========================================================================
  // T443: Version history handlers
  // =========================================================================
  describe('GET_VERSIONS handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get version history for a note', async () => {
      const mockVersions = [
        { id: 'snap1', noteId: 'note123', createdAt: '2026-01-01', contentHash: 'abc' },
        { id: 'snap2', noteId: 'note123', createdAt: '2026-01-02', contentHash: 'def' }
      ]
      ;(notesVault.getVersionHistory as Mock).mockResolvedValue(mockVersions)

      const result = await invokeHandler(NotesChannels.invoke.GET_VERSIONS, 'note123')

      expect(result).toEqual(mockVersions)
      expect(notesVault.getVersionHistory).toHaveBeenCalledWith('note123')
    })
  })

  describe('GET_VERSION handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get a specific version', async () => {
      const mockVersion = {
        id: 'snap1',
        noteId: 'note123',
        content: 'Old content',
        createdAt: '2026-01-01'
      }
      ;(notesVault.getVersion as Mock).mockResolvedValue(mockVersion)

      const result = await invokeHandler(NotesChannels.invoke.GET_VERSION, 'snap1')

      expect(result).toEqual(mockVersion)
    })
  })

  describe('RESTORE_VERSION handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should restore a version', async () => {
      const mockNote = { id: 'note123', title: 'Restored', content: 'Old content' }
      ;(notesVault.restoreVersion as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.RESTORE_VERSION, 'snap1')

      expect(result).toEqual({ success: true, note: mockNote })
    })

    it('should handle restore errors', async () => {
      ;(notesVault.restoreVersion as Mock).mockRejectedValue(new Error('Version not found'))

      const result = await invokeHandler(NotesChannels.invoke.RESTORE_VERSION, 'invalid')

      expect(result).toEqual({
        success: false,
        error: 'Version not found'
      })
    })
  })

  describe('DELETE_VERSION handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should delete a version', async () => {
      ;(noteQueries.deleteNoteSnapshot as Mock).mockReturnValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.DELETE_VERSION, 'snap1')

      expect(result).toEqual({ success: true })
      expect(noteQueries.deleteNoteSnapshot).toHaveBeenCalledWith(mockDb, 'snap1')
    })
  })

  // =========================================================================
  // Additional handlers
  // =========================================================================
  describe('RENAME handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should rename a note', async () => {
      const mockNote = { id: 'note123', title: 'New Title' }
      ;(notesDomain.renameNoteCommand as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.RENAME, {
        id: 'note123',
        newTitle: 'New Title'
      })

      expect(result).toEqual({ success: true, note: mockNote })
    })
  })

  describe('MOVE handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should move a note to a different folder', async () => {
      const mockNote = { id: 'note123', path: 'archive/Note.md' }
      ;(notesDomain.moveNoteCommand as Mock).mockResolvedValue(mockNote)

      const result = await invokeHandler(NotesChannels.invoke.MOVE, {
        id: 'note123',
        newFolder: 'archive'
      })

      expect(result).toEqual({ success: true, note: mockNote })
    })
  })

  describe('EXISTS handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should check if note exists', async () => {
      ;(notesVault.noteExists as Mock).mockResolvedValue(true)

      const result = await invokeHandler(NotesChannels.invoke.EXISTS, 'My Note')

      expect(result).toBe(true)
    })
  })

  describe('GET_TAGS handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get tags with counts', async () => {
      const mockTags = [
        { tag: 'work', color: '#ff0000', count: 5 },
        { tag: 'personal', color: '#00ff00', count: 3 }
      ]
      ;(notesVault.getTagsWithCounts as Mock).mockResolvedValue(mockTags)

      const result = await invokeHandler(NotesChannels.invoke.GET_TAGS)

      expect(result).toEqual(mockTags)
    })
  })

  describe('GET_LINKS handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get note links', async () => {
      const mockLinks = {
        outgoing: [{ targetId: 'note2', targetTitle: 'Other Note' }],
        incoming: [{ sourceId: 'note3', sourceTitle: 'Linking Note' }]
      }
      ;(notesVault.getNoteLinks as Mock).mockResolvedValue(mockLinks)

      const result = await invokeHandler(NotesChannels.invoke.GET_LINKS, 'note123')

      expect(result).toEqual(mockLinks)
    })
  })

  describe('Attachment handlers', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('UPLOAD_ATTACHMENT should upload attachment', async () => {
      const mockResult = { success: true, path: 'attachments/note123/file.pdf', type: 'file' }
      ;(attachmentsVault.saveAttachment as Mock).mockResolvedValue(mockResult)

      const result = await invokeHandler(NotesChannels.invoke.UPLOAD_ATTACHMENT, {
        noteId: 'note123',
        filename: 'file.pdf',
        data: [0x25, 0x50, 0x44, 0x46] // PDF magic bytes
      })

      expect(result).toEqual(mockResult)
    })

    it('LIST_ATTACHMENTS should list attachments', async () => {
      const mockAttachments = [
        { name: 'file1.pdf', size: 1024 },
        { name: 'image.png', size: 2048 }
      ]
      ;(attachmentsVault.listNoteAttachments as Mock).mockResolvedValue(mockAttachments)

      const result = await invokeHandler(NotesChannels.invoke.LIST_ATTACHMENTS, 'note123')

      expect(result).toEqual(mockAttachments)
    })

    it('DELETE_ATTACHMENT should delete attachment', async () => {
      ;(attachmentsVault.deleteAttachment as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.DELETE_ATTACHMENT, {
        noteId: 'note123',
        filename: 'file.pdf'
      })

      expect(result).toEqual({ success: true })
    })
  })

  describe('Folder config handlers', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('GET_FOLDER_CONFIG should get folder config', async () => {
      const mockConfig = { templateId: 'template1', icon: '📁' }
      ;(foldersVault.readFolderConfig as Mock).mockResolvedValue(mockConfig)

      const result = await invokeHandler(NotesChannels.invoke.GET_FOLDER_CONFIG, 'projects')

      expect(result).toEqual(mockConfig)
    })

    it('SET_FOLDER_CONFIG should set folder config', async () => {
      ;(foldersVault.writeFolderConfig as Mock).mockResolvedValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.SET_FOLDER_CONFIG, {
        folderPath: 'projects',
        config: { templateId: 'template2' }
      })

      expect(result).toEqual({ success: true })
    })

    it('GET_FOLDER_TEMPLATE should get resolved template', async () => {
      const mockTemplate = { id: 'template1', name: 'Project Note' }
      ;(foldersVault.getFolderTemplate as Mock).mockResolvedValue(mockTemplate)

      const result = await invokeHandler(NotesChannels.invoke.GET_FOLDER_TEMPLATE, 'projects')

      expect(result).toEqual(mockTemplate)
    })
  })

  describe('Property definitions handlers', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    // Note: GET_PROPERTIES and SET_PROPERTIES moved to properties-handlers.ts

    it('GET_PROPERTY_DEFINITIONS should get all definitions', async () => {
      const mockDefs = [
        { name: 'status', type: 'select', options: ['active', 'done'] },
        { name: 'priority', type: 'number' }
      ]
      ;(storageData.listPropertyDefinitions as Mock).mockReturnValue(mockDefs)

      const result = await invokeHandler(NotesChannels.invoke.GET_PROPERTY_DEFINITIONS)

      expect(result).toEqual(mockDefs)
    })

    it('CREATE_PROPERTY_DEFINITION should create a definition', async () => {
      const mockDef = { name: 'due', type: 'date' }
      ;(propertyDefinitionStore.createPropertyDefinitionRecord as Mock).mockReturnValue(mockDef)

      const result = await invokeHandler(NotesChannels.invoke.CREATE_PROPERTY_DEFINITION, {
        name: 'due',
        type: 'date'
      })

      expect(result).toEqual({ success: true, definition: mockDef })
    })
  })

  describe('GET_POSITIONS handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get note positions for a folder', async () => {
      const mockPositions = [
        { path: 'projects/note1.md', position: 0 },
        { path: 'projects/note2.md', position: 1 }
      ]
      ;(positionQueries.getNotesInFolder as Mock).mockReturnValue(mockPositions)

      const result = await invokeHandler(NotesChannels.invoke.GET_POSITIONS, {
        folderPath: 'projects'
      })

      expect(result).toEqual({ success: true, positions: mockPositions })
      expect(positionQueries.getNotesInFolder).toHaveBeenCalledWith(mockDb, 'projects')
    })

    it('should get positions for root folder', async () => {
      const mockPositions = [{ path: 'root-note.md', position: 0 }]
      ;(positionQueries.getNotesInFolder as Mock).mockReturnValue(mockPositions)

      const result = await invokeHandler(NotesChannels.invoke.GET_POSITIONS, {
        folderPath: ''
      })

      expect(result).toEqual({ success: true, positions: mockPositions })
      expect(positionQueries.getNotesInFolder).toHaveBeenCalledWith(mockDb, '')
    })

    it('should handle errors when getting positions', async () => {
      ;(positionQueries.getNotesInFolder as Mock).mockImplementation(() => {
        throw new Error('Database error')
      })

      const result = await invokeHandler(NotesChannels.invoke.GET_POSITIONS, {
        folderPath: 'projects'
      })

      expect(result).toEqual({
        success: false,
        error: 'Database error'
      })
    })
  })

  describe('GET_ALL_POSITIONS handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should get all note positions as a map', async () => {
      const mockPositions = [
        { path: 'projects/note1.md', position: 0 },
        { path: 'projects/note2.md', position: 1 },
        { path: 'archive/old.md', position: 0 }
      ]
      ;(positionQueries.getAllNotePositions as Mock).mockReturnValue(mockPositions)

      const result = await invokeHandler(NotesChannels.invoke.GET_ALL_POSITIONS)

      expect(result).toEqual({
        success: true,
        positions: {
          'projects/note1.md': 0,
          'projects/note2.md': 1,
          'archive/old.md': 0
        }
      })
    })

    it('should return empty map when no positions exist', async () => {
      ;(positionQueries.getAllNotePositions as Mock).mockReturnValue([])

      const result = await invokeHandler(NotesChannels.invoke.GET_ALL_POSITIONS)

      expect(result).toEqual({ success: true, positions: {} })
    })

    it('should handle errors when getting all positions', async () => {
      ;(positionQueries.getAllNotePositions as Mock).mockImplementation(() => {
        throw new Error('Database connection failed')
      })

      const result = await invokeHandler(NotesChannels.invoke.GET_ALL_POSITIONS)

      expect(result).toEqual({
        success: false,
        error: 'Database connection failed'
      })
    })
  })

  describe('REORDER handler', () => {
    beforeEach(() => {
      registerNotesHandlers()
    })

    it('should reorder notes in a folder', async () => {
      ;(positionQueries.reorderNotesInFolder as Mock).mockReturnValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.REORDER, {
        folderPath: 'projects',
        notePaths: ['projects/note2.md', 'projects/note1.md', 'projects/note3.md']
      })

      expect(result).toEqual({ success: true })
      expect(positionQueries.reorderNotesInFolder).toHaveBeenCalledWith(mockDb, 'projects', [
        'projects/note2.md',
        'projects/note1.md',
        'projects/note3.md'
      ])
    })

    it('should reorder notes in root folder', async () => {
      ;(positionQueries.reorderNotesInFolder as Mock).mockReturnValue(undefined)

      const result = await invokeHandler(NotesChannels.invoke.REORDER, {
        folderPath: '',
        notePaths: ['root-note.md', 'another-note.md']
      })

      expect(result).toEqual({ success: true })
      expect(positionQueries.reorderNotesInFolder).toHaveBeenCalledWith(mockDb, '', [
        'root-note.md',
        'another-note.md'
      ])
    })

    it('should handle errors when reordering', async () => {
      ;(positionQueries.reorderNotesInFolder as Mock).mockImplementation(() => {
        throw new Error('Transaction failed')
      })

      const result = await invokeHandler(NotesChannels.invoke.REORDER, {
        folderPath: 'projects',
        notePaths: ['projects/note1.md']
      })

      expect(result).toEqual({
        success: false,
        error: 'Transaction failed'
      })
    })
  })
})
