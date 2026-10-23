import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const state = vi.hoisted(() => ({ data: null as unknown, index: null as unknown }))
const sync = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
}))
vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClientModule>()),
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index
}))
vi.mock('../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: () => ({ getDoc: () => undefined, updateMeta: vi.fn(), purge: vi.fn() })
}))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => false) }))
vi.mock('../sync/local-mutations', () => sync)

import * as vaultIndex from '../vault/index'
import { createNote } from '../vault/notes'
import { parseNote } from '../vault/frontmatter'
import { resolveLinkTargets } from '@main/database/queries/notes'
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { editNoteAliasesCommand } from './note-aliases'
import type * as ClientModule from '../database/client'

describe('editNoteAliasesCommand', () => {
  let vault: TestVaultResult
  let data: TestDatabaseResult
  let index: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('note-aliases')
    data = createTestDataDb()
    index = createTestIndexDb()
    state.data = data.db
    state.index = index.db
    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)
    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: [],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      journalDateFormat: 'YYYY-MM-DD',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    sync.enqueueLocalSyncUpdate.mockClear()
    data.close()
    index.close()
    vault.cleanup()
  })

  async function noteWithFile(bytes: string): Promise<{ id: string; file: string }> {
    const note = await createNote({ title: 'Kaan', content: 'Body' })
    await flushProjectionEvents()
    const file = path.join(vault.path, note.path)
    fs.writeFileSync(file, bytes)
    return { id: note.id, file }
  }

  it('edits only the aliases key, deletes it when empty, and syncs only real changes', async () => {
    const original = '---\nstatus: draft # keep me\n---\nBody\n'
    const { id, file } = await noteWithFile(original)

    await expect(
      editNoteAliasesCommand({ id, add: ['K.', 'KY', 'k.'], remove: [] })
    ).resolves.toEqual({
      aliases: ['K.', 'KY']
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(
      '---\nstatus: draft # keep me\naliases:\n  - K.\n  - KY\n---\nBody\n'
    )
    await flushProjectionEvents()
    expect(resolveLinkTargets(index.db, ['ky']).get('ky')?.noteId).toBe(id)
    expect(sync.enqueueLocalSyncUpdate).toHaveBeenCalledTimes(1)

    await editNoteAliasesCommand({ id, add: ['ky'], remove: ['nope'] })
    expect(sync.enqueueLocalSyncUpdate).toHaveBeenCalledTimes(1)

    await expect(editNoteAliasesCommand({ id, add: [], remove: ['k.', 'KY'] })).resolves.toEqual({
      aliases: []
    })
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    await flushProjectionEvents()
    expect(resolveLinkTargets(index.db, ['ky']).get('ky')).toBeNull()
    expect(sync.enqueueLocalSyncUpdate).toHaveBeenCalledTimes(2)
  })

  it('lands two racing disjoint edits', async () => {
    const { id, file } = await noteWithFile('---\naliases: [A]\n---\nBody\n')

    await Promise.all([
      editNoteAliasesCommand({ id, add: ['B'], remove: [] }),
      editNoteAliasesCommand({ id, add: ['C'], remove: ['A'] })
    ])

    const aliases = parseNote(fs.readFileSync(file, 'utf8')).frontmatter.aliases ?? []
    expect([...aliases].sort()).toEqual(['B', 'C'])
  })
})
