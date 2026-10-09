/**
 * updateNote's header tags against a real vault: an echoed `tags` list must not
 * promote inline mentions, and an explicit edit composes with a body's delta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import * as vaultIndex from './index'
import * as database from '../database'
import { createNote, updateNote } from './notes'

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]) },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('../notes/runtime-effects', () => ({ syncNoteUpdate: vi.fn() }))

describe('updateNote header tags', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('note-write-tags')
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
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  const header = (raw: string): string[] => {
    const block = raw.split('---')[1] ?? ''
    return [...block.matchAll(/^\s+- (.+)$/gm)].map((m) => m[1])
  }
  const read = (notePath: string): string =>
    fs.readFileSync(path.join(vault.path, notePath), 'utf8')

  it('does not promote an inline-only tag echoed back in `tags`', async () => {
    const note = await createNote({ title: 'Echo', content: 'Met #lead today.', tags: ['work'] })
    const { note: updated } = await updateNote({ id: note.id, tags: ['work', 'lead'] })
    expect(updated.headerTags).toEqual(['work'])
    expect(header(read(note.path))).toEqual(['work'])
  })

  it('removes a header tag the `tags` list leaves out', async () => {
    const note = await createNote({ title: 'Drop', content: 'Met #lead.', tags: ['work', 'home'] })
    await updateNote({ id: note.id, tags: ['home', 'lead'] })
    expect(header(read(note.path))).toEqual(['home'])
  })

  it('applies an explicit header edit and the new body tags together', async () => {
    const note = await createNote({ title: 'Both', content: 'Plain.', tags: ['work'] })
    await updateNote({ id: note.id, headerTags: { add: ['urgent'] }, content: 'Now #fresh.' })
    expect(header(read(note.path))).toEqual(['work', 'urgent', 'fresh'])
  })

  it('leaves the header alone for a body Memry wrote itself', async () => {
    const note = await createNote({ title: 'Tpl', content: '', tags: ['work'] })
    await updateNote({ id: note.id, content: 'Template #stub.', ignoreInlineTags: true })
    expect(header(read(note.path))).toEqual(['work'])
  })
})
