/**
 * A note's tags or properties edit that lands while a write-back pass has read
 * the file and not yet written it (#5472). The pass writes back the
 * frontmatter it read, and the edit leaves the doc as it was, so the re-arm
 * after the pass cannot see it: the edit waits for the pass instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import type { NoteUpdateInput } from './notes-crud'
import type * as FileOps from './file-ops'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import * as vaultIndex from './status'
import * as database from '../database'
import * as databaseClient from '../database/client'
import { createNote, updateNote } from './notes'
import { resetWritebackState, writebackNow } from '../sync/crdt-writeback'
import { markdownToYFragment } from '../sync/blocknote-converter'

const hold = vi.hoisted(() => ({
  next: null as null | { reached: () => void; release: Promise<void> }
}))

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]), fromId: () => null },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('../notes/runtime-effects', () => ({ syncNoteUpdate: vi.fn() }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
// The next file write waits here, after its writer read the file and built its bytes.
vi.mock('./file-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof FileOps>()
  return {
    ...actual,
    atomicWrite: async (...args: Parameters<typeof actual.atomicWrite>) => {
      const next = hold.next
      if (next) {
        hold.next = null
        next.reached()
        await next.release
      }
      return actual.atomicWrite(...args)
    }
  }
})

describe('a note tags or properties edit between a write-back read and write (#5472)', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('note-metadata-writeback')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)
    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(databaseClient, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(databaseClient, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    hold.next = null
    resetWritebackState()
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  it.each<[string, Omit<NoteUpdateInput, 'id'>, string]>([
    ['tags', { headerTags: { add: ['focus'] } }, '- focus'],
    ['properties', { properties: { mood: 'calm' } }, 'mood: calm']
  ])('the %s edit and the typed body both stay in the file', async (_n, edit, kept) => {
    const note = await createNote({ title: 'Race', content: 'Morning.' })
    const doc = new Y.Doc()
    await markdownToYFragment('Morning. Typed.', doc.getXmlFragment(CRDT_FRAGMENT_NAME), note.path)
    let release = (): void => {}
    const reached = new Promise<void>((resolve) => {
      hold.next = {
        reached: resolve,
        release: new Promise<void>((r) => {
          release = r
        })
      }
    })
    const writeback = writebackNow(note.id, doc)
    await reached
    const update = updateNote({ id: note.id, ...edit })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await Promise.all([writeback, update])
    const onDisk = fs.readFileSync(path.join(vault.path, note.path), 'utf8')
    expect.soft(onDisk).toContain(kept)
    expect.soft(onDisk).toContain('Morning. Typed.')
  })
})
