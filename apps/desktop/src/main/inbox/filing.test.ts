import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

const mockSend = vi.fn()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }])
  }
}))

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

vi.mock('../vault/index', () => ({
  getStatus: vi.fn(() => ({ isOpen: true, path: '/mock-vault' })),
  getConfig: vi.fn(() => ({ defaultNoteFolder: 'notes' }))
}))

vi.mock('./attachments', () => ({
  resolveAttachmentUrl: vi.fn((p: string) => (p ? `memry-file://${p}` : null)),
  deleteInboxAttachments: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { getDatabase } from '../database'
import { fileToFolder, convertToNote, linkToNote, linkToNotes, bulkFileToFolder } from './filing'

describe('Inbox Filing Operations', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)

    mockCreateNote.mockReset()
    mockGetNoteById.mockReset()
    mockUpdateNote.mockReset()
    mockCreateFolder.mockReset()
    mockGetFolders.mockResolvedValue([])
    mockSend.mockClear()

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
  // fileToFolder
  // ==========================================================================
  describe('fileToFolder', () => {
    it('should create note in specified folder', async () => {
      // #given
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        type: 'note',
        title: 'Test Item',
        content: 'Some content'
      })

      // #when
      const result = await fileToFolder(itemId, 'projects')

      // #then
      expect(result.success).toBe(true)
      expect(result.noteId).toBe('note-123')
      expect(mockCreateNote).toHaveBeenCalledWith(expect.objectContaining({ folder: 'projects' }))
    })

    it('should create folder if it does not exist', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })

      await fileToFolder(itemId, 'new-folder')

      expect(mockCreateFolder).toHaveBeenCalledWith('new-folder')
    })

    it('should not create folder if it already exists', async () => {
      mockGetFolders.mockResolvedValue([{ path: 'existing-folder', icon: null }])
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })

      await fileToFolder(itemId, 'existing-folder')

      expect(mockCreateFolder).not.toHaveBeenCalled()
    })

    it('should merge tags from inbox item with provided tags', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })
      seedInboxItemTags(testDb.db, itemId, ['existing-tag'])

      await fileToFolder(itemId, 'folder', ['new-tag'])

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['existing-tag', 'new-tag', 'inbox'])
        })
      )
    })

    it('should always add inbox tag', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })

      await fileToFolder(itemId, 'folder')

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({ tags: expect.arrayContaining(['inbox']) })
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

    it('should mark item as filed after success', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })

      await fileToFolder(itemId, 'folder')

      expect(mockSend).toHaveBeenCalledWith(
        'inbox:filed',
        expect.objectContaining({ id: itemId, filedAction: 'folder' })
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

      expect(mockSend).toHaveBeenCalledWith('inbox:filed', expect.anything())
    })

    it('should handle root folder (empty string)', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })

      const result = await fileToFolder(itemId, '')

      expect(result.success).toBe(true)
      expect(mockCreateFolder).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // T030: Link filing — fileToFolder with link type
  // ==========================================================================
  describe('fileToFolder — link type', () => {
    it('should file link to folder successfully', async () => {
      // #given
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-1',
        type: 'link',
        title: 'Great Article Title',
        content: 'Article description here',
        sourceUrl: 'https://example.com/article'
      })

      // #when
      const result = await fileToFolder(itemId, 'references')

      // #then
      expect(result.success).toBe(true)
      expect(result.noteId).toBe('note-123')
      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Great Article Title',
          folder: 'references'
        })
      )
    })

    it('should generate rich markdown content with source URL', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-2',
        type: 'link',
        title: 'Article',
        content: 'Description of the article',
        sourceUrl: 'https://example.com/post'
      })

      await fileToFolder(itemId, 'folder')

      const noteContent = mockCreateNote.mock.calls[0][0].content as string
      expect(noteContent).toContain(
        '[example.com \u00B7 Article](https://example.com/post "mention")'
      )
      expect(noteContent).toContain('Description of the article')
      expect(noteContent).toContain('Filed from Inbox')
    })

    it('should generate mention format for non-YouTube links', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-3',
        type: 'link',
        title: 'Visual Article',
        sourceUrl: 'https://example.com/visual',
        metadata: { heroImage: 'https://example.com/hero.jpg' }
      })

      await fileToFolder(itemId, 'folder')

      const noteContent = mockCreateNote.mock.calls[0][0].content as string
      expect(noteContent).toContain('"mention"')
      expect(noteContent).toContain('example.com')
    })

    it('should include author and site metadata', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-4',
        type: 'link',
        title: 'Authored Article',
        sourceUrl: 'https://blog.example.com/post',
        metadata: {
          author: 'Jane Doe',
          siteName: 'Example Blog',
          publishedDate: '2026-01-15'
        }
      })

      await fileToFolder(itemId, 'folder')

      const noteContent = mockCreateNote.mock.calls[0][0].content as string
      expect(noteContent).toContain('**Author:** Jane Doe')
      expect(noteContent).toContain('**Site:** Example Blog')
      expect(noteContent).toContain('**Published:** 2026-01-15')
    })

    it('should handle link with no metadata gracefully', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-5',
        type: 'link',
        title: 'Bare Link',
        sourceUrl: 'https://example.com/bare'
      })

      await fileToFolder(itemId, 'folder')

      expect(mockCreateNote).toHaveBeenCalled()
      const noteContent = mockCreateNote.mock.calls[0][0].content as string
      expect(noteContent).toContain('[example.com')
      expect(noteContent).toContain('"mention"')
      expect(noteContent).not.toContain('**Author:**')
    })

    it('should use domain as title when title matches URL', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-6',
        type: 'link',
        title: 'https://example.com/page',
        sourceUrl: 'https://example.com/page'
      })

      await fileToFolder(itemId, 'folder')

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Link from example.com'
        })
      )
    })

    it('should handle link with no content', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-7',
        type: 'link',
        title: 'No Description',
        sourceUrl: 'https://example.com/empty'
      })

      await fileToFolder(itemId, 'folder')

      const noteContent = mockCreateNote.mock.calls[0][0].content as string
      expect(noteContent).toContain('"mention"')
      expect(noteContent).not.toContain('> ')
    })

    it('should preserve tags when filing link', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-8',
        type: 'link',
        title: 'Tagged Link',
        sourceUrl: 'https://example.com/tagged'
      })
      seedInboxItemTags(testDb.db, itemId, ['reading', 'tech'])

      await fileToFolder(itemId, 'folder', ['reference'])

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: expect.arrayContaining(['reading', 'tech', 'reference', 'inbox'])
        })
      )
    })

    it('should mark link as filed and emit event', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-9',
        type: 'link',
        title: 'Filed Link',
        sourceUrl: 'https://example.com/filed'
      })

      await fileToFolder(itemId, 'folder')

      expect(mockSend).toHaveBeenCalledWith(
        'inbox:filed',
        expect.objectContaining({ id: itemId, filedAction: 'folder' })
      )
    })
  })

  // ==========================================================================
  // T030: Link filing — linkToNote(s) with link type
  // ==========================================================================
  describe('linkToNote — link type', () => {
    it('should link a link item to an existing note', async () => {
      // #given
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-10',
        type: 'link',
        title: 'Related Article',
        content: 'Article about React hooks',
        sourceUrl: 'https://example.com/react-hooks'
      })
      mockGetNoteById.mockResolvedValue({
        id: 'target-note',
        content: '# React Patterns\n\nSome existing content.',
        path: 'notes/react-patterns.md'
      })

      // #when
      const result = await linkToNote(itemId, 'target-note')

      // #then
      expect(result.success).toBe(true)
      expect(mockCreateNote).toHaveBeenCalled()
      expect(mockUpdateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'target-note',
          content: expect.stringContaining('## Inbox Captures')
        })
      )
    })

    it('should include link domain in wikilink description', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-11',
        type: 'link',
        title: 'CSS Grid Guide',
        sourceUrl: 'https://css-tricks.com/grid-guide'
      })
      mockGetNoteById.mockResolvedValue({
        id: 'target',
        content: '# CSS Notes',
        path: 'notes/css.md'
      })

      await linkToNote(itemId, 'target')

      const updatedContent = mockUpdateNote.mock.calls[0][0].content as string
      expect(updatedContent).toContain('css-tricks.com')
    })

    it('should create link note with rich content in specified folder', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-12',
        type: 'link',
        title: 'Deep Dive',
        content: 'A deep dive into TypeScript generics',
        sourceUrl: 'https://blog.example.com/ts-generics',
        metadata: { author: 'John Smith' }
      })
      mockGetNoteById.mockResolvedValue({
        id: 'target',
        content: '# TypeScript',
        path: 'notes/typescript.md'
      })

      await linkToNote(itemId, 'target', [], 'references')

      expect(mockCreateNote).toHaveBeenCalledWith(expect.objectContaining({ folder: 'references' }))
      const noteContent = mockCreateNote.mock.calls[0][0].content as string
      expect(noteContent).toContain('blog.example.com')
      expect(noteContent).toContain('"mention"')
      expect(noteContent).toContain('**Author:** John Smith')
    })
  })

  describe('linkToNotes — link type', () => {
    it('should link a link item to multiple notes', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-13',
        type: 'link',
        title: 'Multi-Topic Article',
        content: 'Covers both React and TypeScript',
        sourceUrl: 'https://example.com/react-ts'
      })
      mockGetNoteById
        .mockResolvedValueOnce({ id: 'n1', content: '# React', path: 'notes/react.md' })
        .mockResolvedValueOnce({ id: 'n2', content: '# TypeScript', path: 'notes/ts.md' })

      const result = await linkToNotes(itemId, ['n1', 'n2'])

      expect(result.success).toBe(true)
      expect(result.linkedCount).toBe(2)
      expect(mockUpdateNote).toHaveBeenCalledTimes(2)
    })

    it('should handle link with missing metadata when linking', async () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'link-14',
        type: 'link',
        title: 'Simple Link',
        sourceUrl: 'https://example.com/simple'
      })
      mockGetNoteById.mockResolvedValue({
        id: 'target',
        content: '# Notes',
        path: 'notes/notes.md'
      })

      const result = await linkToNote(itemId, 'target')

      expect(result.success).toBe(true)
      const noteContent = mockCreateNote.mock.calls[0][0].content as string
      expect(noteContent).toContain('"mention"')
    })
  })

  // ==========================================================================
  // convertToNote
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
          title: 'Test Item',
          tags: expect.arrayContaining(['inbox'])
        })
      )
    })

    it('should include date/time in title when title is blank', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: '   ' })

      await convertToNote(itemId)

      expect(mockCreateNote).toHaveBeenCalledWith(
        expect.objectContaining({
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
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })
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
  // linkToNote and linkToNotes (text types)
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
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })
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
        .mockResolvedValueOnce({ id: 'note-1', content: '# Note 1', path: 'notes/note1.md' })
        .mockResolvedValueOnce({ id: 'note-2', content: '# Note 2', path: 'notes/note2.md' })

      const result = await linkToNotes(itemId, ['note-1', 'note-2'])

      expect(result.success).toBe(true)
      expect(result.linkedCount).toBe(2)
      expect(mockUpdateNote).toHaveBeenCalledTimes(2)
    })

    it('should fail when no note IDs provided', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })

      const result = await linkToNotes(itemId, [])
      expect(result.success).toBe(false)
      expect(result.error).toContain('At least one note')
    })

    it('should fail when any target note does not exist', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })
      mockGetNoteById
        .mockResolvedValueOnce({ id: 'note-1', content: '# Note 1', path: 'notes/note1.md' })
        .mockResolvedValueOnce(null)

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
      expect(mockUpdateNote).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('[[Previous]]')
        })
      )
    })

    it('should create folder if specified', async () => {
      const itemId = seedInboxItem(testDb.db, { id: 'item-1', title: 'Test Item' })
      mockGetNoteById.mockResolvedValue({
        id: 'note-1',
        content: '# Note 1',
        path: 'notes/note1.md'
      })

      await linkToNotes(itemId, ['note-1'], [], 'references')

      expect(mockCreateNote).toHaveBeenCalledWith(expect.objectContaining({ folder: 'references' }))
    })
  })

  // ==========================================================================
  // bulkFileToFolder
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
        { id: 'item-2', title: 'Item 2', filedAt: new Date().toISOString() }
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
        { id: 'item-2', title: 'Item 2', filedAt: new Date().toISOString() },
        { id: 'item-3', title: 'Item 3' }
      ])
      mockCreateNote.mockResolvedValue({ id: 'note-1', path: 'p1.md', title: 'N1' })

      const result = await bulkFileToFolder(['item-1', 'item-2', 'item-3'], 'folder')

      expect(result.processedCount).toBe(2)
      expect(result.errors).toHaveLength(1)
    })
  })
})
