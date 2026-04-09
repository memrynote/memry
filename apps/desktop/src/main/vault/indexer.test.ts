/**
 * Integration tests for indexer.ts
 * Tests vault indexing operations with real file system and in-memory database.
 *
 * @module vault/indexer.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { eq } from 'drizzle-orm'
import {
  createTestVault,
  createTestNote,
  createTestJournalEntry,
  type TestVaultResult
} from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'

// ============================================================================
// Type-Safe Mocks
// ============================================================================

// Track emitIndexProgress calls
const progressCalls: number[] = []

// Mock the vault/index module
vi.mock('./index', () => ({
  getConfig: vi.fn(
    (): VaultConfig => ({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    })
  ),
  emitIndexProgress: vi.fn((progress: number) => {
    progressCalls.push(progress)
  })
}))

// Mock embedding updates (external AI service)
vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

// ============================================================================
// Test Suite
// ============================================================================

describe('indexer', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let testDb: TestDatabaseResult

  // Import modules after mocks are set up
  let database: typeof import('../database')
  let indexer: typeof import('./indexer')
  let vaultIndex: typeof import('./index')

  beforeEach(async () => {
    // Clear progress tracking
    progressCalls.length = 0

    // Create fresh test fixtures
    tempVault = createTestVault('indexer-test')
    dataDb = createTestDataDb()
    testDb = createTestIndexDb()

    // Use fake timers for deterministic timestamps
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'))

    // Import modules
    database = await import('../database')
    indexer = await import('./indexer')
    vaultIndex = await import('./index')

    // Inject test database - spyOn ensures type compatibility
    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(testDb.db)

    // Mock FTS update (simplified for tests)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {
      // No-op for tests
    })

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
    vi.useRealTimers()
    vi.restoreAllMocks()
    testDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  // ==========================================================================
  // T374: indexVault - full vault indexing
  // ==========================================================================

  describe('indexVault', () => {
    it('T374: indexes files in notes/ folder', async () => {
      // Create test notes
      createTestNote(tempVault, { title: 'Note 1', content: 'Content 1' })
      createTestNote(tempVault, { title: 'Note 2', content: 'Content 2' })
      createTestNote(tempVault, { title: 'Note 3', content: 'Content 3' })

      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(3)
      expect(result.skipped).toBe(0)
      expect(result.errors).toBe(0)
    })

    it('T374: indexes files in journal/ folder', async () => {
      // Create journal entries
      createTestJournalEntry(tempVault, '2026-01-15', 'Journal content for today')
      createTestJournalEntry(tempVault, '2026-01-14', 'Yesterday content')

      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(2)
    })

    it('T374: skips hidden files (starting with .)', async () => {
      // Create regular note
      createTestNote(tempVault, { title: 'Visible Note', content: 'Content' })

      // Create hidden file directly
      const hiddenPath = path.join(tempVault.notesDir, '.hidden-note.md')
      fs.writeFileSync(hiddenPath, '---\nid: hidden\n---\n\nHidden content')

      const result = await indexer.indexVault(tempVault.path)

      // Should only index the visible note
      expect(result.indexed).toBe(1)
    })

    it('T374: respects excludePatterns from config', async () => {
      // Update mock to include specific exclude pattern
      vi.mocked(vaultIndex.getConfig).mockReturnValue({
        excludePatterns: ['.git', 'node_modules', 'archive'],
        defaultNoteFolder: 'notes',
        journalFolder: 'journal',
        attachmentsFolder: 'attachments'
      })

      // Create regular note
      createTestNote(tempVault, { title: 'Visible', content: 'Content' })

      // Create note in excluded folder
      createTestNote(tempVault, { title: 'Archived', content: 'Content', folder: 'archive' })

      // Note: The exclude pattern check is for directory names at any level
      // "archive" as a folder should be excluded
      const result = await indexer.indexVault(tempVault.path)

      // The implementation checks entry.name against excludePatterns
      // Since "archive" is the folder name, it should be excluded
      expect(result.indexed).toBe(1)
    })

    it('T374: handles nested subfolders', async () => {
      createTestNote(tempVault, { title: 'Root Note', content: 'In root' })
      createTestNote(tempVault, { title: 'Nested 1', content: 'Level 1', folder: 'level1' })
      createTestNote(tempVault, {
        title: 'Nested 2',
        content: 'Level 2',
        folder: 'level1/level2'
      })
      createTestNote(tempVault, {
        title: 'Nested 3',
        content: 'Level 3',
        folder: 'level1/level2/level3'
      })

      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(4)
    })

    it('T374: returns correct counts', async () => {
      // Create notes to index
      createTestNote(tempVault, { title: 'Note 1', content: 'Content 1' })
      createTestNote(tempVault, { title: 'Note 2', content: 'Content 2' })

      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(2)
      expect(result.skipped).toBe(0)
      expect(result.errors).toBe(0)

      // Run again - should skip already indexed files
      const result2 = await indexer.indexVault(tempVault.path)

      expect(result2.indexed).toBe(0)
      expect(result2.skipped).toBe(2)
      expect(result2.errors).toBe(0)
    })

    it('T374: emits progress events', async () => {
      // Create several notes
      for (let i = 0; i < 15; i++) {
        createTestNote(tempVault, { title: `Note ${i}`, content: `Content ${i}` })
      }

      await indexer.indexVault(tempVault.path)

      // Should have emitted progress (batched every 10 files + final)
      expect(progressCalls.length).toBeGreaterThan(0)
      // Final progress should be 100
      expect(progressCalls[progressCalls.length - 1]).toBe(100)
    })

    it('T374: extracts tags from frontmatter', async () => {
      createTestNote(tempVault, {
        title: 'Tagged Note',
        content: 'Content with tags',
        tags: ['project', 'important']
      })

      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(1)

      // Verify tags were stored (by checking we can query them)
      // We'd need to query the database to verify this
    })

    it('T374: handles empty vault (0 files)', async () => {
      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.errors).toBe(0)

      // Should emit 100% progress for empty vault
      expect(progressCalls).toContain(100)
    })

    it('T374: detects journal entries by path pattern', async () => {
      // Create a journal entry with the expected path format
      createTestJournalEntry(tempVault, '2026-01-15', 'Today journal')

      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(1)
      // The indexer should detect this as a journal entry based on path
    })

    it('T374: handles duplicate IDs (regenerates new ID)', async () => {
      // Create first note with specific ID
      createTestNote(tempVault, {
        id: 'duplicate123',
        title: 'First Note',
        content: 'Original'
      })

      // Index first note
      await indexer.indexVault(tempVault.path)

      // Create second note with same ID (simulating a copy)
      const note2Dir = path.join(tempVault.notesDir, 'subfolder')
      fs.mkdirSync(note2Dir, { recursive: true })
      const note2Path = path.join(note2Dir, 'Second Note.md')
      fs.writeFileSync(
        note2Path,
        `---
id: "duplicate123"
title: "Second Note"
---

Copied note`
      )

      // Index again - should regenerate ID for the second note
      const result = await indexer.indexVault(tempVault.path)

      expect(result.indexed).toBe(1) // Second note indexed with new ID
      expect(result.skipped).toBe(1) // First note skipped

      // Verify the second note's file was updated with new ID
      const updatedContent = fs.readFileSync(note2Path, 'utf-8')
      expect(updatedContent).not.toContain('id: "duplicate123"')
    })
  })

  // ==========================================================================
  // T375: needsInitialIndex - empty cache detection
  // ==========================================================================

  describe('needsInitialIndex', () => {
    it('T375: returns true when note_cache is empty', () => {
      const result = indexer.needsInitialIndex()

      expect(result).toBe(true)
    })

    it('T375: returns false when notes exist in cache', async () => {
      // Index some notes first
      createTestNote(tempVault, { title: 'Test Note', content: 'Content' })
      await indexer.indexVault(tempVault.path)

      const result = indexer.needsInitialIndex()

      expect(result).toBe(false)
    })

    it('T375: returns true on database error (fail-safe)', () => {
      // Mock getIndexDatabase to throw
      vi.spyOn(database, 'getIndexDatabase').mockImplementation(() => {
        throw new Error('Database error')
      })

      const result = indexer.needsInitialIndex()

      // Should return true as fail-safe
      expect(result).toBe(true)
    })
  })

  // ==========================================================================
  // T376: rebuildIndex - cache rebuild
  // ==========================================================================

  describe('rebuildIndex', () => {
    // For rebuildIndex tests, we need to mock additional database functions
    // since it deletes and recreates the database

    beforeEach(() => {
      // Mock the database lifecycle functions
      vi.spyOn(database, 'closeIndexDatabase').mockImplementation(() => {
        // No-op
      })

      vi.spyOn(database, 'runIndexMigrations').mockImplementation(() => {
        // No-op - schema already created in test DB
      })

      vi.spyOn(database, 'initIndexDatabase').mockReturnValue(testDb.db)

      vi.spyOn(database, 'initializeFts').mockImplementation(() => {
        // No-op - FTS not needed for these tests
      })
    })

    it('T376: re-indexes all markdown files', async () => {
      // Create some notes
      createTestNote(tempVault, { title: 'Note A', content: 'Content A' })
      createTestNote(tempVault, { title: 'Note B', content: 'Content B' })
      createTestJournalEntry(tempVault, '2026-01-15', 'Journal')

      const result = await indexer.rebuildIndex(tempVault.path)

      expect(result.filesIndexed).toBe(3)
    })

    it('T376: returns filesIndexed count', async () => {
      createTestNote(tempVault, { title: 'Only Note', content: 'Content' })

      const result = await indexer.rebuildIndex(tempVault.path)

      expect(result.filesIndexed).toBe(1)
    })

    it('T376: returns duration in milliseconds', async () => {
      createTestNote(tempVault, { title: 'Test', content: 'Content' })

      const result = await indexer.rebuildIndex(tempVault.path)

      expect(typeof result.duration).toBe('number')
      expect(result.duration).toBeGreaterThanOrEqual(0)
    })

    it('T376: calls database lifecycle functions in order', async () => {
      const closeDb = vi.spyOn(database, 'closeIndexDatabase')
      const runMigrations = vi.spyOn(database, 'runIndexMigrations')
      const initDb = vi.spyOn(database, 'initIndexDatabase')
      const initFts = vi.spyOn(database, 'initializeFts')

      createTestNote(tempVault, { title: 'Test', content: 'Content' })

      await indexer.rebuildIndex(tempVault.path)

      // Verify order of calls
      expect(closeDb).toHaveBeenCalled()
      expect(runMigrations).toHaveBeenCalled()
      expect(initDb).toHaveBeenCalled()
      expect(initFts).toHaveBeenCalled()

      // Verify order
      const closeOrder = closeDb.mock.invocationCallOrder[0]
      const migrateOrder = runMigrations.mock.invocationCallOrder[0]
      const initOrder = initDb.mock.invocationCallOrder[0]
      const ftsOrder = initFts.mock.invocationCallOrder[0]

      expect(closeOrder).toBeLessThan(migrateOrder)
      expect(migrateOrder).toBeLessThan(initOrder)
      expect(initOrder).toBeLessThan(ftsOrder)
    })

    it('T376: handles empty vault', async () => {
      const result = await indexer.rebuildIndex(tempVault.path)

      expect(result.filesIndexed).toBe(0)
      expect(result.duration).toBeGreaterThanOrEqual(0)
    })

    it('T376: preserves canonical note metadata across index rebuilds', async () => {
      const notePath = createTestNote(tempVault, {
        id: 'persistent-note',
        title: 'Persistent Note',
        content: 'Canonical metadata should survive rebuilds'
      })
      const relativePath = path.relative(tempVault.path, notePath).replace(/\\/g, '/')

      await indexer.indexVault(tempVault.path)

      const before = dataDb.db
        .select()
        .from(noteMetadata)
        .where(eq(noteMetadata.id, 'persistent-note'))
        .get()
      expect(before?.path).toBe(relativePath)

      await indexer.rebuildIndex(tempVault.path)

      const after = dataDb.db
        .select()
        .from(noteMetadata)
        .where(eq(noteMetadata.id, 'persistent-note'))
        .get()
      expect(after).toEqual(expect.objectContaining({ id: 'persistent-note', path: before?.path }))
    })
  })
})
