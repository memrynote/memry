/**
 * Path-form wiki-links (`[[Folder/Note]]`, #2562) follow their target through
 * a rename, a move and a folder rename: asserted on the vault files on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import type { DataDb } from '@main/database/types'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import * as projections from '../projections'

// ============================================================================
// Type-Safe Mocks
// ============================================================================

// Mock electron (must be at module level)
vi.mock('electron', () => {
  const mockWebContents = { send: vi.fn() }
  const mockWindow = { isDestroyed: () => false, webContents: mockWebContents }

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

// The move path has to hand the rewritten body to the note's Y.Doc, and there is
// no doc open in these tests, so the call is only observable as a call. It is
// load-bearing rather than bookkeeping: the doc is keyed by note id and survives
// the move holding the pre-move body, so without this the next write-back
// serializes the stale refs straight back over the file the move just corrected
// — and persists them.
const crdtMocks = vi.hoisted(() => ({
  feedExternalEditToCrdt: vi.fn(async () => false)
}))
vi.mock('../sync/crdt-external-feed', () => ({
  feedExternalEditToCrdt: crdtMocks.feedExternalEditToCrdt
}))

// ============================================================================
// Test Suite
// ============================================================================

describe('path-form wiki-links follow their target (#2562)', () => {
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
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    // Inject test database - spyOn ensures type compatibility
    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db as unknown as DataDb)
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

  const readVaultFile = (relativePath: string): string =>
    fs.readFileSync(path.join(tempVault.path, relativePath), 'utf-8')

  it('moveNote rewrites inbound path links and leaves title links alone', async () => {
    const target = await notes.createNote({ title: 'Plan', content: 'Body.', folder: 'Work' })
    const source = await notes.createNote({
      title: 'Source',
      content: 'See [[work/plan#Goals|the plan]], [[Plan]] and [[Work/Planner]].'
    })
    await projections.flushProjectionEvents()

    await notes.moveNote(target.id, 'Archive/2026')

    expect(readVaultFile(source.path)).toContain(
      'See [[Archive/2026/Plan#Goals|the plan]], [[Plan]] and [[Work/Planner]].'
    )
  })

  it('renameFolder rewrites path links to every note inside the folder', async () => {
    await notes.createFolder('Projects')
    const top = await notes.createNote({ title: 'Top', content: 'T.', folder: 'Projects' })
    await notes.createNote({ title: 'Deep', content: 'D.', folder: 'Projects/Sub' })
    const source = await notes.createNote({
      title: 'Index',
      content: '[[Projects/Top]] and [[/Projects/Sub/Deep#H]] and [[Top]]'
    })
    await projections.flushProjectionEvents()

    await notes.renameFolder('Projects', 'Areas')

    expect(readVaultFile(source.path)).toContain(
      '[[Areas/Top]] and [[/Areas/Sub/Deep#H]] and [[Top]]'
    )
    expect((await notes.getNoteById(top.id))?.path).toBe('Areas/Top.md')
  })

  it('renameNote rewrites path links along with title links', async () => {
    const target = await notes.createNote({ title: 'Old', content: 'O.', folder: 'Work' })
    const source = await notes.createNote({
      title: 'Linker',
      content: '[[Work/Old]] and [[Old|label]]'
    })
    await projections.flushProjectionEvents()

    await notes.renameNote(target.id, 'New')

    expect(readVaultFile(source.path)).toContain('[[Work/New]] and [[New|label]]')
  })
})
