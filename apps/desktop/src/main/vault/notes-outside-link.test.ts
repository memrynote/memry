/**
 * Note readers outside the open, edit and sync paths (#2936). A note file
 * swapped for a symlink to a file outside the vault is refused the way
 * `getNoteById` refuses it (#2789): the outside text never reaches a vault
 * file, a snapshot or a reply, and the link is left as the user made it. The
 * vault, both databases and the projector are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import {
  startProjectionRuntime,
  stopProjectionRuntime,
  flushProjectionEvents
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import * as vaultIndex from './index'
import * as database from '../database'
import * as notes from './notes'
import { appendBlocksToNote } from './append-blocks'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(async () => undefined) }))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))

const SECRET = 'Outside secret [[Target]]\n'
const OUTSIDE_MESSAGE = 'points outside the vault. Memry reads only files inside the vault.'

describe('note readers and a note file linked outside the vault', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let outside: string
  let secret: string

  beforeEach(() => {
    vault = createTestVault('notes-outside-link')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    outside = fs.mkdtempSync(path.join(path.dirname(vault.path), 'notes-outside-target-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, SECRET)

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
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
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
    fs.rmSync(outside, { recursive: true, force: true })
  })

  function swapForLink(relativePath: string): string {
    const file = path.join(vault.path, relativePath)
    fs.unlinkSync(file)
    fs.symlinkSync(secret, file)
    return file
  }

  function expectSecretNowhereInVault(link: string): void {
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET)
    const entries = fs.readdirSync(vault.path, { recursive: true, withFileTypes: true })
    for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf-8')
      expect(text).not.toContain('Outside secret')
    }
  }

  it('leaves a linked source out of the inbound link rewrite of a rename', async () => {
    const target = await notes.createNote({ title: 'Target', content: 'Target body.' })
    const source = await notes.createNote({ title: 'Source', content: 'See [[Target]].' })
    await flushProjectionEvents()
    const link = swapForLink(source.path)

    await notes.renameNote(target.id, 'Renamed')

    expectSecretNowhereInVault(link)
  })

  it('refuses to append blocks to a linked target note', async () => {
    const from = await notes.createNote({ title: 'From', content: 'Moved block.' })
    const to = await notes.createNote({ title: 'To', content: 'Target body.' })
    const link = swapForLink(to.path)

    await expect(
      appendBlocksToNote({ sourceNoteId: from.id, targetNoteId: to.id, markdown: 'Moved block.' })
    ).rejects.toThrow(`${to.path} ${OUTSIDE_MESSAGE}`)
    expectSecretNowhereInVault(link)
  })

  it('refuses to rename or move a linked note', async () => {
    const note = await notes.createNote({ title: 'Linked', content: 'Vault body.' })
    const link = swapForLink(note.path)
    fs.mkdirSync(path.join(vault.path, 'archive'))

    await expect(notes.renameNote(note.id, 'Elsewhere')).rejects.toThrow(OUTSIDE_MESSAGE)
    await expect(notes.moveNote(note.id, 'archive')).rejects.toThrow(OUTSIDE_MESSAGE)
    expectSecretNowhereInVault(link)
  })

  it('refuses a version restore over a linked note and snapshots nothing from it', async () => {
    const note = await notes.createNote({ title: 'Versioned', content: 'Original.' })
    const snapshot = notes.createSnapshot(note.id, 'Original.\n', note.title, 'manual')
    const link = swapForLink(note.path)

    await expect(notes.restoreVersion(snapshot!.id)).rejects.toThrow(
      `${note.path} ${OUTSIDE_MESSAGE}`
    )
    const stored = notes.getVersionHistory(note.id).map((item) => notes.getVersion(item.id))
    expect(stored.map((detail) => detail?.fileContent).join()).not.toContain('Outside secret')
    expectSecretNowhereInVault(link)
  })

  it('refuses an unindexed path linked outside', async () => {
    fs.symlinkSync(secret, path.join(vault.path, 'notes', 'unindexed.md'))

    await expect(notes.getNoteByPath('notes/unindexed.md')).rejects.toThrow(
      `notes/unindexed.md ${OUTSIDE_MESSAGE}`
    )
  })

  it('lists a linked backlink source without reading its text', async () => {
    const target = await notes.createNote({ title: 'Target', content: 'Target body.' })
    const source = await notes.createNote({ title: 'Source', content: 'See [[Target]].' })
    await flushProjectionEvents()
    swapForLink(source.path)

    const { incoming } = await notes.getNoteLinks(target.id)

    expect(incoming).toEqual([expect.objectContaining({ sourceId: source.id, contexts: [] })])
  })
})
