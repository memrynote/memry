/**
 * Unlinked mentions (#3320) through the real index and vault files: the list
 * and the "Link" action.
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
import { createSearchProjector } from '../projections/projectors/search-projector'
import * as projections from '../projections'
import { createFtsTable } from '../database/fts'

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

describe('unlinked mentions (#3320)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let testDb: TestDatabaseResult

  // Import modules after mocks are set up
  let vaultIndex: typeof import('./index')
  let database: typeof import('../database')
  let notes: typeof import('./notes')
  let mentions: typeof import('./unlinked-mentions')

  beforeEach(async () => {
    // Create fresh test fixtures
    tempVault = createTestVault('notes-test')
    dataDb = createTestDataDb()
    testDb = createTestIndexDb()
    createFtsTable(testDb.db)

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
    vi.spyOn(database, 'isIndexDatabaseInitialized').mockReturnValue(true)

    mentions = await import('./unlinked-mentions')
    startProjectionRuntime([
      createNoteDerivedStateProjector(() => tempVault.path),
      createSearchProjector(() => tempVault.path)
    ])
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

  it('lists plain-text mentions of the title and aliases, and Link writes a wiki link', async () => {
    const target = await notes.createNote({ title: 'Project Plan', content: 'Body.' })
    await notes.updateNote({ id: target.id, aliases: { add: ['Roadmap'], remove: [] } })
    const source = await notes.createNote({
      title: 'Standup',
      content: 'Talked about the project plan, then the `roadmap` code and the roadmap.'
    })
    await notes.createNote({ title: 'Linked', content: 'The project plan, see [[Project Plan]].' })
    await notes.createNote({ title: 'Near miss', content: 'Projects planned around roadmaps.' })
    await projections.flushProjectionEvents()

    const found = await mentions.getUnlinkedMentions(target.id)
    expect(found.map((m) => m.sourceTitle)).toEqual(['Standup'])
    expect(found[0].contexts.map((c) => c.snippet.slice(c.linkStart, c.linkEnd))).toEqual([
      'project plan',
      'roadmap'
    ])

    expect(
      await mentions.linkUnlinkedMentionInSource({
        sourceId: source.id,
        targetId: target.id,
        ordinal: 1
      })
    ).toBe(true)
    expect(readVaultFile(source.path)).toContain(
      'the project plan, then the `roadmap` code and the [[Project Plan|roadmap]].'
    )
    await projections.flushProjectionEvents()
    expect(await mentions.getUnlinkedMentions(target.id)).toEqual([])

    expect(
      await mentions.linkUnlinkedMentionInSource({
        sourceId: source.id,
        targetId: target.id,
        ordinal: 5
      })
    ).toBe(false)
  })
})
