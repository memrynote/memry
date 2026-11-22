/**
 * A journal entry created with tags seeds its doc's `tags` array. A later
 * tags-only `journal:updateEntry` writes only the file, so that array goes
 * stale; the write-back of the next keystroke must keep the file's tags
 * (#5476).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as Y from 'yjs'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import * as vaultIndex from '../vault/status'
import * as database from '../database'
import * as databaseClient from '../database/client'
import { registerJournalHandlers } from '../ipc/journal-handlers'
import { getCrdtProvider, resetCrdtProvider } from '../sync/crdt-provider'
import { resetWritebackState, writebackNow } from '../sync/crdt-writeback'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { resolveJournalEntryId } from './create-entry'

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
    ipcMain: mockIpcMain,
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]), fromId: () => null },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child
    if (child instanceof Y.XmlElement) return firstText(child)
  }
  throw new Error('no text in the doc')
}

describe('a tags-only journal update, then a keystroke (#5476)', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('journal-tags-writeback')
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
    registerJournalHandlers()
  })

  afterEach(() => {
    resetWritebackState()
    resetCrdtProvider()
    resetIpcMocks()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  it('keeps the file tags the update wrote', async () => {
    const date = '2026-05-10'
    await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, {
      date,
      content: 'Morning.',
      tags: ['a']
    })
    const id = resolveJournalEntryId(date)
    const doc = getCrdtProvider().getDoc(id) as Y.Doc
    expect(doc.getArray('tags').toArray()).toEqual(['a'])

    await invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date, tags: ['b'] })
    const file = path.join(vault.path, 'journal', `${date}.md`)
    expect(fs.readFileSync(file, 'utf8')).toContain('- b')

    // The editor seeds the body it opened with, then the user types.
    await markdownToYFragment('Morning.', doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    const text = firstText(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    text.insert(text.length, ' Typed.')
    await writebackNow(id, doc)

    const onDisk = fs.readFileSync(file, 'utf8')
    expect.soft(onDisk).toContain('Morning. Typed.')
    expect.soft(onDisk).toContain('- b')
    expect.soft(onDisk).not.toContain('- a')
  })
})
