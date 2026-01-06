/**
 * Inbox Filing Operations Tests
 *
 * Tests for filing inbox items to folders, converting to notes,
 * and linking to existing notes.
 *
 * @module inbox/filing.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fileToFolder,
  convertToNote,
  linkToNote,
  linkToNotes,
  bulkFileToFolder
} from './filing'
import {
  createTestDatabase,
  cleanupTestDatabase,
  seedInboxItem,
  seedInboxItems,
  seedInboxItemTags,
  type TestDatabaseResult
} from '../../../tests/utils/test-db'

// Mock the database module
vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

// Create a mock send function that persists across calls
const mockSend = vi.fn()

// Mock BrowserWindow
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        webContents: {
          send: mockSend
        }
      }
    ])
  }
}))

// Mock vault/notes module
const mockCreateNote = vi.fn()
const mockGetNoteById = vi.fn()
const mockUpdateNote = vi.fn()
const mockCreateFolder = vi.fn()
const mockGetFolders = vi.fn()

vi.mock('../vault/notes', () => ({
  createNote: (...args: unknown[]) => mockCreateNote(...args),
  getNoteById: (...args: unknown[]) => mockGetNoteById(...args),
  updateNote: (...args: unknown[]) => mockUpdateNote(...args),
  createFolder: (...args: unknown[]) => mockCreateFolder(...args),
  getFolders: (...args: unknown[]) => mockGetFolders(...args)
}))

// Mock attachments module
vi.mock('./attachments', () => ({
  resolveAttachmentUrl: vi.fn((path) => (path ? `memry-file://${path}` : null))
}))

import { getDatabase } from '../database'

describe('Inbox Filing Operations', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)

    // Reset mocks
    mockCreateNote.mockReset()
    mockGetNoteById.mockReset()
    mockUpdateNote.mockReset()
    mockCreateFolder.mockReset()
    mockGetFolders.mockResolvedValue([])
    mockSend.mockClear()

    // Default mock implementations
    mockCreateNote.mockResolvedValue({
      id: 'note-123',
      path: 'notes/test-note.md',
      title: 'Test Note'
    })
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T422: fileToFolder
  // ==========================================================================
  describe('fileToFolder', () => {
    it('should create note in specified folder', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        type: 'note',
        title: 'Test Item',
        content: 'Some content'
      })

      const result = await fileToFolder(itemId, 'projects')

      expect(result.success).toBe(true)
      expect(result.noteId).toBe('note-123')
      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          folder: 'projects'
        })
      )
    })

    it('should create folder if it does not exist', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      await fileToFolder(itemId, 'new-folder')

      expect(mockCreateFolder).toHaveBeenCalledWith('new-folder')
    })

    it('should not create folder if it already exists', async () => {
      mockGetFolders.mockResolvedValue(['existing-folder'])

      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      await fileToFolder(itemId, 'existing-folder')

      expect(mockCreateFolder).not.toHaveBeenCalled()
    })

    it('should merge tags from inbox item with provided tags', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })
      seedInboxItemTags(testDb.db, itemId, ['existing-tag'])

      await fileToFolder(itemId, 'folder', ['new-tag'])

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['existing-tag', 'new-tag', 'inbox'])
        })
      )
    })

    it('should always add inbox tag', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      await fileToFolder(itemId, 'folder')

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['inbox'])
        })
      )
    })

    it('should fail when item does not exist', async () => {
      const result = await fileToFolder('nonexistent', 'folder')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should fail when item is already filed', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item',
        filedAt: new Date().toISOString()
      })

      const result = await fileToFolder(itemId, 'folder')

      expect(result.success).toBe(false)
      expect(result.error).toContain('already been filed')
    })

    it('should generate title from link URL', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        type: 'link',
        title: 'https://example.com/page',
        sourceUrl: 'https://example.com/page'
      })

      await fileToFolder(itemId, 'folder')

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('example.com')
        })
      )
    })

    it('should use extracted title for links when available', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        type: 'link',
        title: 'Great Article Title',
        sourceUrl: 'https://example.com/page'
      })

      await fileToFolder(itemId, 'folder')

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Great Article Title'
        })
      )
    })

    it('should mark item as filed after success', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      await fileToFolder(itemId, 'folder')

      // Emit filed event
      expect(mockSend).toHaveBeenCalledWith(
        'inbox:filed',
        expect.objectContaining({
          id: itemId,
          filedAction: 'folder'
        })
      )
    })

    it('should clear snooze status when filing', async () => {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item',
        snoozedUntil: futureDate.toISOString(),
        snoozeReason: 'Some reason'
      })

      await fileToFolder(itemId, 'folder')

      expect(mockSend).toHaveBeenCalledWith(
        'inbox:filed',
        expect.anything()
      )
    })

    it('should handle root folder (empty string)', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const result = await fileToFolder(itemId, '')

      expect(result.success).toBe(true)
      expect(mockCreateFolder).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // T423: convertToNote
  // ==========================================================================
  describe('convertToNote', () => {
    it('should create note in root folder', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        type: 'note',
        title: 'Test Item',
        content: 'Some content'
      })

      const result = await convertToNote(itemId)

      expect(result.success).toBe(true)
      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Inbox Note'),
          tags: expect.arrayContaining(['inbox'])
        })
      )
    })

    it('should include date/time in title', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      await convertToNote(itemId)

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          // Title should match pattern "Inbox Note - YYYY-MM-DD HH:mm"
          title: expect.stringMatching(/Inbox Note - \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
        })
      )
    })

    it('should fail when item does not exist', async () => {
      const result = await convertToNote('nonexistent')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should fail when item is already filed', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item',
        filedAt: new Date().toISOString()
      })

      const result = await convertToNote(itemId)

      expect(result.success).toBe(false)
      expect(result.error).toContain('already been filed')
    })

    it('should preserve existing tags', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })
      seedInboxItemTags(testDb.db, itemId, ['tag1', 'tag2'])

      await convertToNote(itemId)

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['tag1', 'tag2', 'inbox'])
        })
      )
    })
  })

  // ==========================================================================
  // T424: linkToNote and linkToNotes
  // ==========================================================================
  describe('linkToNote', () => {
    it('should create inbox note and add wikilink to target', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        type: 'note',
        title: 'Test Item',
        content: 'Some content'
      })

      mockGetNoteById.mockResolvedValue({
        id: 'target-note',
        content: '# Target Note\n\nSome existing content.',
        path: 'notes/target.md'
      })

      const result = await linkToNote(itemId, 'target-note')

      expect(result.success).toBe(true)
      expect(mockCreateNote).toHaveBeenCalled()
      expect(mockUpdateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'target-note',
          content: expect.stringContaining('## Inbox Captures')
        })
      )
    })

    it('should fail when target note does not exist', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      mockGetNoteById.mockResolvedValue(null)

      const result = await linkToNote(itemId, 'nonexistent')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should fail when inbox item does not exist', async () => {
      const result = await linkToNote('nonexistent', 'target-note')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should fail when item is already filed', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item',
        filedAt: new Date().toISOString()
      })

      const result = await linkToNote(itemId, 'target-note')

      expect(result.success).toBe(false)
      expect(result.error).toContain('already been filed')
    })
  })

  describe('linkToNotes', () => {
    it('should link to multiple notes', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        type: 'note',
        title: 'Test Item',
        content: 'Some content'
      })

      mockGetNoteById
        .mockResolvedValueOnce({
          id: 'note-1',
          content: '# Note 1',
          path: 'notes/note1.md'
        })
        .mockResolvedValueOnce({
          id: 'note-2',
          content: '# Note 2',
          path: 'notes/note2.md'
        })

      const result = await linkToNotes(itemId, ['note-1', 'note-2'])

      expect(result.success).toBe(true)
      expect(result.linkedCount).toBe(2)
      expect(mockUpdateNote).toHaveBeenCalledTimes(2)
    })

    it('should fail when no note IDs provided', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const result = await linkToNotes(itemId, [])

      expect(result.success).toBe(false)
      expect(result.error).toContain('At least one note')
    })

    it('should fail when any target note does not exist', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      mockGetNoteById
        .mockResolvedValueOnce({
          id: 'note-1',
          content: '# Note 1',
          path: 'notes/note1.md'
        })
        .mockResolvedValueOnce(null) // Second note not found

      const result = await linkToNotes(itemId, ['note-1', 'note-2'])

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should append to existing Inbox Captures section', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item',
        content: 'Content'
      })

      mockGetNoteById.mockResolvedValue({
        id: 'note-1',
        content: '# Note\n\n## Inbox Captures\n\n- [[Previous]]',
        path: 'notes/note1.md'
      })

      await linkToNotes(itemId, ['note-1'])

      expect(mockUpdateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('## Inbox Captures')
        })
      )
      // The content should have both the new entry and the previous one
      expect(mockUpdateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('[[Previous]]')
        })
      )
    })

    it('should create folder if specified', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      mockGetNoteById.mockResolvedValue({
        id: 'note-1',
        content: '# Note 1',
        path: 'notes/note1.md'
      })

      await linkToNotes(itemId, ['note-1'], [], 'references')

      // Note should be created in the specified folder
      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          folder: 'references'
        })
      )
    })
  })

  // ==========================================================================
  // T425: bulkFileToFolder
  // ==========================================================================
  describe('bulkFileToFolder', () => {
    it('should file multiple items to same folder', async () => {
      seedInboxItems(testDb.db, [
        { id: 'item-1', title: 'Item 1' },
        { id: 'item-2', title: 'Item 2' },
        { id: 'item-3', title: 'Item 3' }
      ])

      mockCreateNote
        .mockResolvedValueOnce({ id: 'note-1', path: 'p1.md', title: 'N1' })
        .mockResolvedValueOnce({ id: 'note-2', path: 'p2.md', title: 'N2' })
        .mockResolvedValueOnce({ id: 'note-3', path: 'p3.md', title: 'N3' })

      const result = await bulkFileToFolder(['item-1', 'item-2', 'item-3'], 'archive')

      expect(result.success).toBe(true)
      expect(result.processedCount).toBe(3)
      expect(result.errors).toHaveLength(0)
    })

    it('should apply same tags to all items', async () => {
      seedInboxItems(testDb.db, [
        { id: 'item-1', title: 'Item 1' },
        { id: 'item-2', title: 'Item 2' }
      ])

      mockCreateNote.mockResolvedValue({ id: 'note-1', path: 'p1.md', title: 'N1' })

      await bulkFileToFolder(['item-1', 'item-2'], 'folder', ['bulk-tag'])

      expect(mockCreateNote).toHaveBeenCalledTimes(2)
      mockCreateNote.mock.calls.forEach((call) => {
        expect(call[0].tags).toContain('bulk-tag')
      })
    })

    it('should report partial success with errors', async () => {
      seedInboxItems(testDb.db, [
        { id: 'item-1', title: 'Item 1' },
        { id: 'item-2', title: 'Item 2', filedAt: new Date().toISOString() } // Already filed
      ])

      mockCreateNote.mockResolvedValue({ id: 'note-1', path: 'p1.md', title: 'N1' })

      const result = await bulkFileToFolder(['item-1', 'item-2', 'nonexistent'], 'folder')

      expect(result.success).toBe(false)
      expect(result.processedCount).toBe(1)
      expect(result.errors).toHaveLength(2)
      expect(result.errors.some((e) => e.itemId === 'item-2')).toBe(true)
      expect(result.errors.some((e) => e.itemId === 'nonexistent')).toBe(true)
    })

    it('should continue processing after individual failures', async () => {
      seedInboxItems(testDb.db, [
        { id: 'item-1', title: 'Item 1' },
        { id: 'item-2', title: 'Item 2', filedAt: new Date().toISOString() }, // Already filed
        { id: 'item-3', title: 'Item 3' }
      ])

      mockCreateNote.mockResolvedValue({ id: 'note-1', path: 'p1.md', title: 'N1' })

      const result = await bulkFileToFolder(['item-1', 'item-2', 'item-3'], 'folder')

      // Should process item-1 and item-3, skip item-2
      expect(result.processedCount).toBe(2)
      expect(result.errors).toHaveLength(1)
    })
  })
})
