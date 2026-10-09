/**
 * mergeEntityProperties against a real vault and index: concurrent single-key
 * writes (an agent-fill accept racing a field edit) must both land.
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
import * as vaultIndex from '../vault/index'
import * as database from '../database'
import { createNote, updateNote } from '../vault/notes'
import { mergeEntityProperties, getEntityPropertiesRecord } from './entity-properties'

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]) },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('./runtime-effects', () => ({ syncNoteUpdate: vi.fn() }))

describe('mergeEntityProperties', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('entity-properties-merge')
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

  it('keeps both of two concurrent single-key writes and the keys neither touched', async () => {
    const note = await createNote({
      title: 'Ada',
      content: 'Body.',
      properties: { status: 'draft' }
    })

    const [first, second] = await Promise.all([
      mergeEntityProperties(note.id, { company: 'Acme' }),
      mergeEntityProperties(note.id, { role: 'Engineer' })
    ])

    expect(first).toEqual({ success: true })
    expect(second).toEqual({ success: true })
    expect(getEntityPropertiesRecord(note.id)).toEqual({
      status: 'draft',
      company: 'Acme',
      role: 'Engineer'
    })
    const raw = fs.readFileSync(path.join(vault.path, note.path), 'utf8')
    expect(raw).toMatch(/^company: Acme$/m)
    expect(raw).toMatch(/^role: Engineer$/m)
    expect(raw).toMatch(/^status: draft$/m)
  })

  it('removes a key given null and leaves the rest', async () => {
    const note = await createNote({
      title: 'Grace',
      content: '',
      properties: { status: 'draft', role: 'Admiral' }
    })

    await mergeEntityProperties(note.id, { role: null })

    expect(getEntityPropertiesRecord(note.id)).toEqual({ status: 'draft' })
  })

  it('keeps a key an external editor wrote that the index has not seen yet', async () => {
    const note = await createNote({ title: 'Linus', content: 'Body.', properties: { a: 'one' } })
    const file = path.join(vault.path, note.path)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^a: one$/m, 'a: one\nb: two'))

    await mergeEntityProperties(note.id, { c: 'three' })

    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toMatch(/^a: one$/m)
    expect(raw).toMatch(/^b: two$/m)
    expect(raw).toMatch(/^c: three$/m)
  })

  it('keeps a header tag edit that races a property merge', async () => {
    const note = await createNote({ title: 'Ken', content: 'Body.', properties: { a: 'one' } })

    await Promise.all([
      updateNote({ id: note.id, headerTags: { add: ['person'] } }),
      mergeEntityProperties(note.id, { c: 'three' })
    ])

    const raw = fs.readFileSync(path.join(vault.path, note.path), 'utf8')
    expect(raw).toMatch(/^c: three$/m)
    expect(raw).toMatch(/person/)
  })
})
