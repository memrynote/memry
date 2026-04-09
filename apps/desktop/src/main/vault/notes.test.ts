/**
 * Integration tests for notes.ts
 * Tests note CRUD operations with real file system and in-memory database.
 *
 * @module vault/notes.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, readTestNote, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'

// ============================================================================
// Type-Safe Mocks
// ============================================================================

// Mock electron (must be at module level)
vi.mock('electron', () => {
  const mockWebContents = { send: vi.fn() }
  const mockWindow = { webContents: mockWebContents }

  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => [mockWindow])
    },
    shell: {
      openPath: vi.fn(() => Promise.resolve('')),
      showItemInFolder: vi.fn()
    }
  }
})

// Mock embedding updates (external AI service)
vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

// ============================================================================
// Test Suite
// ============================================================================

describe('notes operations', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let testDb: TestDatabaseResult

  // Import modules after mocks are set up
  let vaultIndex: typeof import('./index')
  let database: typeof import('../database')
  let notes: typeof import('./notes')

  beforeEach(async () => {
    // Create fresh test fixtures
    tempVault = createTestVault('notes-test')
    dataDb = createTestDataDb()
    testDb = createTestIndexDb()

    // Use fake timers for deterministic timestamps
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'))

    // Import modules
    vaultIndex = await import('./index')
    database = await import('../database')
    notes = await import('./notes')

    // Type-safe spy for getStatus - return type must match VaultStatus
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: tempVault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)

    // Type-safe spy for getConfig - return type must match VaultConfig
    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    // Inject test database - spyOn ensures type compatibility
    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(testDb.db)

    // Use real updateFtsContent with test DB
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {
      // Simplified: just do nothing, FTS tests are separate
    })

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])
  })

  afterEach(async () => {
    vi.useRealTimers()
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    testDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  // ==========================================================================
  // T361: createNote - file creation + cache insert
  // ==========================================================================

  describe('createNote', () => {
    it('T361: creates file in correct location with frontmatter', async () => {
      const result = await notes.createNote({
        title: 'My Test Note',
        content: 'This is test content.'
      })

      // Verify note returned with correct data
      expect(result.title).toBe('My Test Note')
      expect(result.content).toBe('This is test content.')
      expect(result.id).toMatch(/^[a-z0-9]{12}$/) // 12-char lowercase alphanumeric

      // Verify file exists on disk (spaces preserved in filename)
      const filePath = path.join(tempVault.notesDir, 'My Test Note.md')
      expect(fs.existsSync(filePath)).toBe(true)

      // Verify frontmatter was written correctly
      const { frontmatter, content } = readTestNote(filePath)
      expect(frontmatter.id).toBe(result.id)
      expect(frontmatter.title).toBe('My Test Note')
      expect(content.trim()).toBe('This is test content.')
    })

    it('T361: inserts note into cache', async () => {
      const result = await notes.createNote({
        title: 'Cached Note',
        content: 'Content for cache test.'
      })

      // Verify we can retrieve the note by ID (from cache)
      const retrieved = await notes.getNoteById(result.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.title).toBe('Cached Note')
    })

    it('T361: sets tags in note_tags table', async () => {
      const result = await notes.createNote({
        title: 'Tagged Note',
        content: 'Content with tags.',
        tags: ['project', 'important']
      })

      expect(result.tags).toEqual(['project', 'important'])

      // Verify tags are persisted
      const retrieved = await notes.getNoteById(result.id)
      expect(retrieved!.tags).toContain('project')
      expect(retrieved!.tags).toContain('important')
    })

    it('T361: sets properties in note_properties table', async () => {
      const result = await notes.createNote({
        title: 'Note With Properties',
        content: 'Content.',
        properties: {
          status: 'draft',
          priority: 3
        }
      })

      expect(result.properties).toEqual({
        status: 'draft',
        priority: 3
      })
    })

    it('T361: creates note in subfolder', async () => {
      const result = await notes.createNote({
        title: 'Nested Note',
        content: 'In a subfolder.',
        folder: 'projects/active'
      })

      // Verify file exists in subfolder (spaces preserved in filename)
      const filePath = path.join(tempVault.notesDir, 'projects', 'active', 'Nested Note.md')
      expect(fs.existsSync(filePath)).toBe(true)
      expect(result.path).toBe('notes/projects/active/Nested Note.md')
    })

    it('T361: generates unique path on collision', async () => {
      // Create first note
      await notes.createNote({
        title: 'Duplicate Title',
        content: 'First note.'
      })

      // Create second note with same title
      const second = await notes.createNote({
        title: 'Duplicate Title',
        content: 'Second note.'
      })

      // Should have different path (e.g., "Duplicate Title 1.md")
      expect(second.path).not.toBe('notes/Duplicate Title.md')
      expect(second.path).toMatch(/Duplicate Title \d+\.md$/)
    })

    it('T361: emits CREATED event', async () => {
      const { BrowserWindow } = await import('electron')
      const mockSend = vi.fn()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { webContents: { send: mockSend } } as never
      ])

      await notes.createNote({
        title: 'Event Test Note',
        content: 'Testing events.'
      })

      // Verify CREATED event was emitted
      expect(mockSend).toHaveBeenCalledWith(
        'notes:created',
        expect.objectContaining({
          note: expect.objectContaining({ title: 'Event Test Note' }),
          source: 'internal'
        })
      )
    })
  })

  // ==========================================================================
  // T362: getNoteById, getNoteByPath
  // ==========================================================================

  describe('getNoteById', () => {
    it('T362: returns note from cache + file content', async () => {
      const created = await notes.createNote({
        title: 'Get By ID Test',
        content: 'Content to retrieve.',
        tags: ['test']
      })

      const retrieved = await notes.getNoteById(created.id)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(created.id)
      expect(retrieved!.title).toBe('Get By ID Test')
      expect(retrieved!.content).toBe('Content to retrieve.')
      expect(retrieved!.tags).toContain('test')
    })

    it('T362: returns null for non-existent note', async () => {
      const result = await notes.getNoteById('nonexistent123')

      expect(result).toBeNull()
    })

    it('T362: handles external deletion (removes from cache)', async () => {
      const created = await notes.createNote({
        title: 'To Be Deleted',
        content: 'Will be deleted externally.'
      })

      // Externally delete the file
      const filePath = path.join(tempVault.path, created.path)
      fs.unlinkSync(filePath)

      // Should return null and remove from cache
      const result = await notes.getNoteById(created.id)
      expect(result).toBeNull()

      // Subsequent get should also be null (removed from cache)
      const secondGet = await notes.getNoteById(created.id)
      expect(secondGet).toBeNull()
    })
  })

  describe('getNoteByPath', () => {
    it('T362: returns note by relative path', async () => {
      const created = await notes.createNote({
        title: 'Get By Path Test',
        content: 'Path test content.'
      })

      const retrieved = await notes.getNoteByPath(created.path)

      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(created.id)
      expect(retrieved!.title).toBe('Get By Path Test')
    })

    it('T362: returns null for non-existent path', async () => {
      const result = await notes.getNoteByPath('notes/does-not-exist.md')

      expect(result).toBeNull()
    })
  })

  // ==========================================================================
  // T363: updateNote - content + metadata update
  // ==========================================================================

  describe('updateNote', () => {
    it('T363: updates file content', async () => {
      const created = await notes.createNote({
        title: 'Update Test',
        content: 'Original content.'
      })

      const updated = await notes.updateNote({
        id: created.id,
        content: 'Updated content here.'
      })

      expect(updated.content).toBe('Updated content here.')

      // Verify file was updated
      const filePath = path.join(tempVault.path, created.path)
      const { content } = readTestNote(filePath)
      expect(content.trim()).toBe('Updated content here.')
    })

    it('T363: updates frontmatter (title, tags, emoji)', async () => {
      const created = await notes.createNote({
        title: 'Original Title',
        content: 'Content.',
        tags: ['old-tag']
      })

      const updated = await notes.updateNote({
        id: created.id,
        title: 'New Title',
        tags: ['new-tag', 'another-tag'],
        emoji: '📝'
      })

      expect(updated.title).toBe('New Title')
      expect(updated.tags).toEqual(['new-tag', 'another-tag'])
      expect(updated.emoji).toBe('📝')
    })

    it('T363: updates properties', async () => {
      const created = await notes.createNote({
        title: 'Properties Test',
        content: 'Content.',
        properties: { status: 'draft' }
      })

      const updated = await notes.updateNote({
        id: created.id,
        properties: { status: 'published', priority: 5 }
      })

      expect(updated.properties).toEqual({ status: 'published', priority: 5 })
    })

    it('T363: updates wordCount and modifiedAt', async () => {
      const created = await notes.createNote({
        title: 'Word Count Test',
        content: 'One two three.'
      })

      // Advance time
      vi.advanceTimersByTime(60000)

      const updated = await notes.updateNote({
        id: created.id,
        content: 'One two three four five six seven eight nine ten.'
      })

      expect(updated.wordCount).toBeGreaterThan(created.wordCount)
      expect(updated.modified.getTime()).toBeGreaterThan(created.modified.getTime())
    })

    it('T363: throws NOT_FOUND for non-existent note', async () => {
      await expect(
        notes.updateNote({
          id: 'nonexistent123',
          content: 'Should fail.'
        })
      ).rejects.toThrow('Note not found')
    })

    it('T363: emits UPDATED event', async () => {
      const { BrowserWindow } = await import('electron')
      const mockSend = vi.fn()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { webContents: { send: mockSend } } as never
      ])

      const created = await notes.createNote({
        title: 'Event Update Test',
        content: 'Original.'
      })

      mockSend.mockClear() // Clear the CREATED event

      await notes.updateNote({
        id: created.id,
        content: 'Updated.'
      })

      expect(mockSend).toHaveBeenCalledWith(
        'notes:updated',
        expect.objectContaining({
          id: created.id,
          source: 'internal'
        })
      )
    })

    it('removes tag from frontmatter when #tag deleted from content', async () => {
      // #given — note with inline #project tag
      const created = await notes.createNote({
        title: 'Inline Tag Removal',
        content: 'Hello #project world',
        tags: ['project']
      })

      // #when — content saved without the #tag (no explicit tags in input)
      const updated = await notes.updateNote({
        id: created.id,
        content: 'Hello world'
      })

      // #then — tag removed from frontmatter
      expect(updated.tags).toEqual([])
    })

    it('adds tag to frontmatter when #tag appears in new content', async () => {
      // #given — note with no tags
      const created = await notes.createNote({
        title: 'Inline Tag Addition',
        content: 'Hello world'
      })

      // #when — content saved with a new #tag
      const updated = await notes.updateNote({
        id: created.id,
        content: 'Hello #design world'
      })

      // #then — tag added to frontmatter
      expect(updated.tags).toContain('design')
    })

    it('preserves tags when content changes without inline tag changes', async () => {
      // #given — note with UI-added tag and matching inline tag
      const created = await notes.createNote({
        title: 'Tag Preserve',
        content: 'Hello #keep this',
        tags: ['keep']
      })

      // #when — content changes but #keep stays
      const updated = await notes.updateNote({
        id: created.id,
        content: 'Goodbye #keep this'
      })

      // #then — tag preserved
      expect(updated.tags).toEqual(['keep'])
    })

    it('preserves UI-only tags when inline tags are removed', async () => {
      // #given — note with UI tag (ui-only) + inline tag (#inline)
      const created = await notes.createNote({
        title: 'Mixed Tags',
        content: 'Hello #inline world',
        tags: ['ui-only', 'inline']
      })

      // #when — inline tag removed, ui-only never appeared in content
      const updated = await notes.updateNote({
        id: created.id,
        content: 'Hello world'
      })

      // #then — ui-only preserved, inline removed
      expect(updated.tags).toEqual(['ui-only'])
    })

    it('skips reconciliation when explicit tags are provided', async () => {
      // #given — note with inline tag
      const created = await notes.createNote({
        title: 'Explicit Tags',
        content: 'Hello #old world',
        tags: ['old']
      })

      // #when — content changes AND explicit tags are passed
      const updated = await notes.updateNote({
        id: created.id,
        content: 'Hello world',
        tags: ['explicit']
      })

      // #then — explicit tags win, no reconciliation
      expect(updated.tags).toEqual(['explicit'])
    })
  })

  // ==========================================================================
  // T364: renameNote - file rename + cache update
  // ==========================================================================

  describe('renameNote', () => {
    it('T364: renames file on disk', async () => {
      const created = await notes.createNote({
        title: 'Original Name',
        content: 'Content.'
      })

      const oldPath = path.join(tempVault.path, created.path)
      expect(fs.existsSync(oldPath)).toBe(true)

      const renamed = await notes.renameNote(created.id, 'New Name')

      // Old file should not exist
      expect(fs.existsSync(oldPath)).toBe(false)

      // New file should exist
      const newPath = path.join(tempVault.path, renamed.path)
      expect(fs.existsSync(newPath)).toBe(true)
      expect(renamed.title).toBe('New Name')
    })

    it('T364: updates cache path', async () => {
      const created = await notes.createNote({
        title: 'Rename Cache Test',
        content: 'Content.'
      })

      await notes.renameNote(created.id, 'Renamed Title')

      // Should be retrievable by same ID
      const retrieved = await notes.getNoteById(created.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.title).toBe('Renamed Title')
      expect(retrieved!.path).toContain('Renamed Title')
    })

    it('T364: generates unique path on collision', async () => {
      await notes.createNote({
        title: 'Existing Name',
        content: 'First note.'
      })

      const second = await notes.createNote({
        title: 'Will Be Renamed',
        content: 'Second note.'
      })

      const renamed = await notes.renameNote(second.id, 'Existing Name')

      // Should have unique path
      expect(renamed.path).not.toBe('notes/Existing-Name.md')
    })

    it('T364: emits RENAMED event', async () => {
      const { BrowserWindow } = await import('electron')
      const mockSend = vi.fn()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { webContents: { send: mockSend } } as never
      ])

      const created = await notes.createNote({
        title: 'Rename Event Test',
        content: 'Content.'
      })

      mockSend.mockClear()

      await notes.renameNote(created.id, 'Renamed Event Test')

      expect(mockSend).toHaveBeenCalledWith(
        'notes:renamed',
        expect.objectContaining({
          id: created.id,
          oldTitle: 'Rename Event Test',
          newTitle: 'Renamed Event Test'
        })
      )
    })

    it('preserves binary file extension on rename', async () => {
      // #given — a PNG file in the vault with 'image' fileType in cache
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const binaryPath = path.join(tempVault.notesDir, 'photo.png')
      fs.writeFileSync(binaryPath, binaryContent)

      const { insertNoteCache } = await import('@main/database/queries/notes')
      insertNoteCache(testDb.db, {
        id: 'binary-rename-1',
        path: 'notes/photo.png',
        title: 'photo',
        fileType: 'image',
        createdAt: '2026-01-15T12:00:00.000Z',
        modifiedAt: '2026-01-15T12:00:00.000Z'
      })

      // #when
      const renamed = await notes.renameNote('binary-rename-1', 'vacation')

      // #then — extension stays .png, not replaced with .md
      expect(renamed.path).toMatch(/vacation.*\.png$/)
      expect(renamed.path).not.toMatch(/\.md/)

      const newAbsPath = path.join(tempVault.path, renamed.path)
      expect(fs.existsSync(newAbsPath)).toBe(true)
      expect(fs.existsSync(binaryPath)).toBe(false)
      expect(Buffer.compare(fs.readFileSync(newAbsPath), binaryContent)).toBe(0)
    })

    it('binary rename coexists with same-name .md file', async () => {
      // #given — an existing .md note "photo" + a .png file with different name
      await notes.createNote({ title: 'photo', content: 'A note about photos.' })

      const binaryContent = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
      const binaryPath = path.join(tempVault.notesDir, 'camera-shot.png')
      fs.writeFileSync(binaryPath, binaryContent)

      const { insertNoteCache } = await import('@main/database/queries/notes')
      insertNoteCache(testDb.db, {
        id: 'binary-rename-2',
        path: 'notes/camera-shot.png',
        title: 'camera-shot',
        fileType: 'image',
        createdAt: '2026-01-15T12:00:00.000Z',
        modifiedAt: '2026-01-15T12:00:00.000Z'
      })

      // #when — rename .png to "photo" (same base as .md but different ext = no collision)
      const renamed = await notes.renameNote('binary-rename-2', 'photo')

      // #then — photo.md and photo.png coexist, no dedup suffix needed
      expect(renamed.path).toBe('notes/photo.png')
    })
  })

  // ==========================================================================
  // T365: moveNote - folder move + cache update
  // ==========================================================================

  describe('moveNote', () => {
    it('T365: moves file to new folder', async () => {
      const created = await notes.createNote({
        title: 'Move Test',
        content: 'Content to move.'
      })

      const oldPath = path.join(tempVault.path, created.path)
      expect(fs.existsSync(oldPath)).toBe(true)

      const moved = await notes.moveNote(created.id, 'archive')

      // Old file should not exist
      expect(fs.existsSync(oldPath)).toBe(false)

      // New file should exist in archive folder
      const newPath = path.join(tempVault.path, moved.path)
      expect(fs.existsSync(newPath)).toBe(true)
      expect(moved.path).toContain('notes/archive/')
    })

    it('T365: creates target folder if needed', async () => {
      const created = await notes.createNote({
        title: 'Nested Move Test',
        content: 'Content.'
      })

      const targetFolder = path.join(tempVault.notesDir, 'deep', 'nested', 'folder')
      expect(fs.existsSync(targetFolder)).toBe(false)

      await notes.moveNote(created.id, 'deep/nested/folder')

      expect(fs.existsSync(targetFolder)).toBe(true)
    })

    it('T365: handles filename collision in target folder', async () => {
      // Create note in target folder first
      await notes.createNote({
        title: 'Same Name',
        content: 'In target folder.',
        folder: 'target'
      })

      // Create note to move
      const toMove = await notes.createNote({
        title: 'Same Name',
        content: 'In root folder.'
      })

      const moved = await notes.moveNote(toMove.id, 'target')

      // Should have unique path in target
      expect(moved.path).not.toBe('notes/target/Same-Name.md')
    })

    it('T365: emits MOVED event', async () => {
      const { BrowserWindow } = await import('electron')
      const mockSend = vi.fn()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { webContents: { send: mockSend } } as never
      ])

      const created = await notes.createNote({
        title: 'Move Event Test',
        content: 'Content.'
      })

      mockSend.mockClear()

      await notes.moveNote(created.id, 'moved-folder')

      expect(mockSend).toHaveBeenCalledWith(
        'notes:moved',
        expect.objectContaining({
          id: created.id,
          oldPath: created.path
        })
      )
    })

    it('preserves binary content on move (no frontmatter injection)', async () => {
      // #given — a binary file in the vault
      const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const binaryPath = path.join(tempVault.notesDir, 'image.png')
      fs.writeFileSync(binaryPath, binaryContent)

      const { insertNoteCache } = await import('@main/database/queries/notes')
      insertNoteCache(testDb.db, {
        id: 'binary-move-1',
        path: 'notes/image.png',
        title: 'image',
        fileType: 'image',
        createdAt: '2026-01-15T12:00:00.000Z',
        modifiedAt: '2026-01-15T12:00:00.000Z'
      })

      // #when
      const moved = await notes.moveNote('binary-move-1', 'archive')

      // #then — binary content preserved, not serialized with frontmatter
      expect(moved.path).toContain('notes/archive/')
      expect(moved.path).toMatch(/\.png$/)

      const newAbsPath = path.join(tempVault.path, moved.path)
      expect(fs.existsSync(newAbsPath)).toBe(true)
      expect(fs.existsSync(binaryPath)).toBe(false)
      expect(Buffer.compare(fs.readFileSync(newAbsPath), binaryContent)).toBe(0)
    })
  })

  // ==========================================================================
  // T366: deleteNote - file + cache deletion
  // ==========================================================================

  describe('deleteNote', () => {
    it('T366: deletes file from disk', async () => {
      const created = await notes.createNote({
        title: 'Delete Test',
        content: 'Content to delete.'
      })

      const filePath = path.join(tempVault.path, created.path)
      expect(fs.existsSync(filePath)).toBe(true)

      await notes.deleteNote(created.id)

      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('T366: removes from cache', async () => {
      const created = await notes.createNote({
        title: 'Cache Delete Test',
        content: 'Content.'
      })

      await notes.deleteNote(created.id)

      const retrieved = await notes.getNoteById(created.id)
      expect(retrieved).toBeNull()
    })

    it('T366: throws NOT_FOUND for non-existent note', async () => {
      await expect(notes.deleteNote('nonexistent123')).rejects.toThrow('Note not found')
    })

    it('T366: emits DELETED event', async () => {
      const { BrowserWindow } = await import('electron')
      const mockSend = vi.fn()
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { webContents: { send: mockSend } } as never
      ])

      const created = await notes.createNote({
        title: 'Delete Event Test',
        content: 'Content.'
      })

      mockSend.mockClear()

      await notes.deleteNote(created.id)

      expect(mockSend).toHaveBeenCalledWith(
        'notes:deleted',
        expect.objectContaining({
          id: created.id,
          path: created.path,
          source: 'internal'
        })
      )
    })
  })

  // ==========================================================================
  // T367: listNotes - pagination and filters
  // ==========================================================================

  describe('listNotes', () => {
    beforeEach(async () => {
      // Create several notes for list tests
      await notes.createNote({ title: 'Note A', content: 'Content A.', tags: ['alpha'] })
      vi.advanceTimersByTime(1000)
      await notes.createNote({ title: 'Note B', content: 'Content B.', tags: ['beta'] })
      vi.advanceTimersByTime(1000)
      await notes.createNote({
        title: 'Note C',
        content: 'Content C.',
        tags: ['alpha'],
        folder: 'subfolder'
      })
    })

    it('T367: returns notes with pagination', async () => {
      const result = await notes.listNotes({ limit: 2 })

      expect(result.notes.length).toBe(2)
      expect(result.total).toBe(3)
      expect(result.hasMore).toBe(true)
    })

    it('T367: supports offset for pagination', async () => {
      const page1 = await notes.listNotes({ limit: 2, offset: 0 })
      const page2 = await notes.listNotes({ limit: 2, offset: 2 })

      expect(page1.notes.length).toBe(2)
      expect(page2.notes.length).toBe(1)
      expect(page2.hasMore).toBe(false)
    })

    it('T367: filters by folder', async () => {
      // Folder filter uses path prefix, so we need the full relative path
      const result = await notes.listNotes({ folder: 'notes/subfolder' })

      expect(result.notes.length).toBe(1)
      expect(result.notes[0].title).toBe('Note C')
    })

    it('T367: filters by tags', async () => {
      const result = await notes.listNotes({ tags: ['alpha'] })

      expect(result.notes.length).toBe(2)
      expect(result.notes.every((n) => n.tags.includes('alpha'))).toBe(true)
    })

    it('T367: sorts by modified descending (default)', async () => {
      const result = await notes.listNotes({})

      // Most recently created should be first
      expect(result.notes[0].title).toBe('Note C')
    })
  })

  // ==========================================================================
  // T368: getTagsWithCounts - tag aggregation
  // ==========================================================================

  describe('getTagsWithCounts', () => {
    it('T368: returns tags sorted by count descending', async () => {
      await notes.createNote({ title: 'Note 1', content: 'C.', tags: ['common', 'rare'] })
      await notes.createNote({ title: 'Note 2', content: 'C.', tags: ['common'] })
      await notes.createNote({ title: 'Note 3', content: 'C.', tags: ['common'] })

      const tags = notes.getTagsWithCounts()

      // 'common' should be first (3 uses), 'rare' second (1 use)
      expect(tags[0].tag).toBe('common')
      expect(tags[0].count).toBe(3)
      expect(tags[1].tag).toBe('rare')
      expect(tags[1].count).toBe(1)
    })
  })

  // ==========================================================================
  // T369: getNoteLinks - outgoing + incoming
  // ==========================================================================

  describe('getNoteLinks', () => {
    it('T369: returns outgoing links (wiki links in content)', async () => {
      // Create target note first
      const target = await notes.createNote({
        title: 'Target Note',
        content: 'I am the target.'
      })

      // Create source note with wiki link
      const source = await notes.createNote({
        title: 'Source Note',
        content: 'This links to [[Target Note]].'
      })

      const links = await notes.getNoteLinks(source.id)

      expect(links.outgoing.length).toBe(1)
      expect(links.outgoing[0].targetTitle).toBe('Target Note')
      expect(links.outgoing[0].targetId).toBe(target.id)
    })

    it('T369: returns incoming links (backlinks)', async () => {
      const target = await notes.createNote({
        title: 'Linked To',
        content: 'I have backlinks.'
      })

      await notes.createNote({
        title: 'Linker 1',
        content: 'Links to [[Linked To]].'
      })

      await notes.createNote({
        title: 'Linker 2',
        content: 'Also links to [[Linked To]].'
      })

      const links = await notes.getNoteLinks(target.id)

      expect(links.incoming.length).toBe(2)
    })

    it('T369: handles unresolved links (targetId: null)', async () => {
      const source = await notes.createNote({
        title: 'Broken Link Note',
        content: 'Links to [[Non Existent Page]].'
      })

      const links = await notes.getNoteLinks(source.id)

      expect(links.outgoing.length).toBe(1)
      expect(links.outgoing[0].targetTitle).toBe('Non Existent Page')
      expect(links.outgoing[0].targetId).toBeNull()
    })
  })

  // ==========================================================================
  // T370: Folder operations
  // ==========================================================================

  describe('folder operations', () => {
    describe('getFolders', () => {
      it('T370: lists all folders in notes directory', async () => {
        // Create some notes in folders
        await notes.createNote({ title: 'A', content: 'C.', folder: 'folder1' })
        await notes.createNote({ title: 'B', content: 'C.', folder: 'folder2' })
        await notes.createNote({ title: 'C', content: 'C.', folder: 'folder1/nested' })

        const folders = await notes.getFolders()
        const folderPaths = folders.map((f) => f.path)

        expect(folderPaths).toContain('folder1')
        expect(folderPaths).toContain('folder2')
        expect(folderPaths).toContain('folder1/nested')
      })
    })

    describe('createFolder', () => {
      it('T370: creates nested directories', async () => {
        await notes.createFolder('new/nested/folder')

        const folderPath = path.join(tempVault.notesDir, 'new', 'nested', 'folder')
        expect(fs.existsSync(folderPath)).toBe(true)
      })
    })

    describe('renameFolder', () => {
      it('T370: renames folder atomically', async () => {
        await notes.createFolder('old-name')
        await notes.createNote({ title: 'Inside', content: 'C.', folder: 'old-name' })

        await notes.renameFolder('old-name', 'new-name')

        expect(fs.existsSync(path.join(tempVault.notesDir, 'old-name'))).toBe(false)
        expect(fs.existsSync(path.join(tempVault.notesDir, 'new-name'))).toBe(true)
        // Note should still exist in renamed folder
        expect(fs.existsSync(path.join(tempVault.notesDir, 'new-name', 'Inside.md'))).toBe(true)
      })
    })

    describe('deleteFolder', () => {
      it('T370: deletes folder recursively', async () => {
        await notes.createNote({ title: 'To Delete', content: 'C.', folder: 'delete-me' })

        const folderPath = path.join(tempVault.notesDir, 'delete-me')
        expect(fs.existsSync(folderPath)).toBe(true)

        await notes.deleteFolder('delete-me')

        expect(fs.existsSync(folderPath)).toBe(false)
      })
    })
  })

  // ==========================================================================
  // T371: noteExists - by title and path
  // ==========================================================================

  describe('noteExists', () => {
    it('T371: returns true for existing path', async () => {
      const created = await notes.createNote({
        title: 'Exists Test',
        content: 'Content.'
      })

      const exists = await notes.noteExists(created.path)
      expect(exists).toBe(true)
    })

    it('T371: returns true for existing title', async () => {
      await notes.createNote({
        title: 'Title Exists',
        content: 'Content.'
      })

      const exists = await notes.noteExists('Title Exists')
      expect(exists).toBe(true)
    })

    it('T371: returns false for non-existent', async () => {
      const exists = await notes.noteExists('Does Not Exist')
      expect(exists).toBe(false)
    })
  })

  // ==========================================================================
  // T372: Snapshot operations
  // ==========================================================================

  describe('snapshot operations', () => {
    describe('createSnapshot', () => {
      it('T372: creates snapshot with deduplication', async () => {
        const created = await notes.createNote({
          title: 'Snapshot Test',
          content: 'Original content.'
        })

        const filePath = path.join(tempVault.path, created.path)
        const fileContent = fs.readFileSync(filePath, 'utf-8')

        // Create first snapshot
        const snapshot1 = notes.createSnapshot(created.id, fileContent, created.title, 'manual')
        expect(snapshot1).not.toBeNull()

        // Try to create duplicate - should be skipped
        const snapshot2 = notes.createSnapshot(created.id, fileContent, created.title, 'manual')
        expect(snapshot2).toBeNull()
      })
    })

    describe('getVersionHistory', () => {
      it('T372: returns snapshots sorted by date', async () => {
        const created = await notes.createNote({
          title: 'History Test',
          content: 'Version 1.'
        })

        const filePath = path.join(tempVault.path, created.path)

        // Create snapshots at different times
        const content1 = fs.readFileSync(filePath, 'utf-8')
        notes.createSnapshot(created.id, content1, created.title, 'manual')

        vi.advanceTimersByTime(60000)

        await notes.updateNote({ id: created.id, content: 'Version 2.' })
        const content2 = fs.readFileSync(filePath, 'utf-8')
        notes.createSnapshot(created.id, content2, created.title, 'manual', true)

        const history = notes.getVersionHistory(created.id)

        expect(history.length).toBeGreaterThanOrEqual(1)
        // Most recent should be first
        expect(new Date(history[0].createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(history[history.length - 1].createdAt).getTime()
        )
      })
    })

    describe('getVersion', () => {
      it('T372: returns full content for snapshot', async () => {
        const created = await notes.createNote({
          title: 'Get Version Test',
          content: 'Original content here.'
        })

        const filePath = path.join(tempVault.path, created.path)
        const fileContent = fs.readFileSync(filePath, 'utf-8')

        const snapshot = notes.createSnapshot(created.id, fileContent, created.title, 'manual')

        const version = notes.getVersion(snapshot!.id)

        expect(version).not.toBeNull()
        expect(version!.fileContent).toBe(fileContent)
        expect(version!.title).toBe('Get Version Test')
      })

      it('T372: returns null for non-existent snapshot', async () => {
        const version = notes.getVersion('nonexistent-snapshot-id')
        expect(version).toBeNull()
      })
    })

    describe('restoreVersion', () => {
      it('T372: restores file content and creates backup', async () => {
        const created = await notes.createNote({
          title: 'Restore Test',
          content: 'Original content.'
        })

        const filePath = path.join(tempVault.path, created.path)
        const originalContent = fs.readFileSync(filePath, 'utf-8')

        // Create snapshot of original
        const snapshot = notes.createSnapshot(created.id, originalContent, created.title, 'manual')

        // Update note
        await notes.updateNote({ id: created.id, content: 'Modified content.' })

        // Restore to original
        const restored = await notes.restoreVersion(snapshot!.id)

        expect(restored.content).toBe('Original content.')

        // Should have created backup snapshot before restore
        const history = notes.getVersionHistory(created.id)
        expect(history.length).toBeGreaterThanOrEqual(2)
      })
    })
  })
})
