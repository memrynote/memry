/**
 * The day merge adds a folded foreign entry's tags to the day file. A user's
 * tag edit queued behind a running write-back pass of the day lands first, so
 * the merge must read the day's tags in its own turn, after that edit, not
 * before it (#5481 review, finding 4).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as Y from 'yjs'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  asSyncDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import type { JournalSyncService } from './journal-sync'
import * as vaultIndex from '../vault/status'
import * as fileOps from '../vault/file-ops'
import * as database from '../database'
import * as databaseClient from '../database/client'
import * as journalSync from './journal-sync'
import { registerJournalHandlers } from '../ipc/journal-handlers'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { resetWritebackState, writebackNow } from './crdt-writeback'
import { markdownToYFragment } from './blocknote-converter'
import { journalHandler } from './item-handlers/journal-handler'
import { runJournalDayMerges } from './journal-day-merge'
import { parseJournalEntry } from '../vault/journal'
import { resolveJournalEntryId } from '../journal/create-entry'

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }
  return {
    app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
    ipcMain: mockIpcMain,
    BrowserWindow: { getAllWindows: vi.fn(() => [mockWindow]), fromId: () => null },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

const DATE = '2026-05-10'
const FOREIGN = 'vcpzueguep8y'

function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child
    if (child instanceof Y.XmlElement) return firstText(child)
  }
  throw new Error('no text in the doc')
}

describe('the day merge tags, behind a running pass of the day', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    vault = createTestVault('journal-day-merge-tags-turn')
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
    const sync: Pick<JournalSyncService, 'enqueueRecoveredDelete'> = {
      enqueueRecoveredDelete: vi.fn()
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the drain uses only enqueueRecoveredDelete
    vi.spyOn(journalSync, 'getJournalSyncService').mockReturnValue(sync as JournalSyncService)
    dataDb.db
      .insert(syncDevices)
      .values({
        id: 'me',
        name: 'This Mac',
        platform: 'macos',
        appVersion: '1',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'key'
      })
      .run()
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

  it('keeps a tag edit queued behind the pass and adds the foreign tags to it', async () => {
    await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, { date: DATE, content: 'Morning.' })
    const id = resolveJournalEntryId(DATE)
    const file = path.join(vault.path, 'journal', `${DATE}.md`)

    // A pass of the day holds in its file write.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const passWriting = new Promise<void>((resolve) => (reached = resolve))
    const realWrite = fileOps.atomicWrite
    let holdNext = true
    vi.spyOn(fileOps, 'atomicWrite').mockImplementation(async (target, content) => {
      if (holdNext && target === file) {
        holdNext = false
        reached()
        await held
      }
      return realWrite(target, content)
    })
    const doc = getCrdtProvider().getDoc(id) as Y.Doc
    await markdownToYFragment('Morning.', doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    const text = firstText(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    text.insert(text.length, ' Typed.')
    const pass = writebackNow(id, doc)
    await passWriting

    // The user tags the day; the edit waits for the pass.
    const edit = invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date: DATE, tags: ['y'] })

    // A foreign entry tagged `x` folds into the day meanwhile.
    journalHandler.applyUpsert(
      { db: asSyncDb(dataDb.db), emit: vi.fn() },
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['x'] },
      { b: 1 }
    )
    const drain = runJournalDayMerges(asSyncDb(dataDb.db), async () => true)
    await vi.waitFor(() => {
      // oxlint-disable-next-line typescript/no-base-to-string -- XmlFragment toString is its text
      expect(String(getCrdtProvider().getDoc(id)?.getXmlFragment(CRDT_FRAGMENT_NAME))).toContain(
        'theirs'
      )
    })
    // Let the drain go on to queue its tag write.
    await new Promise((resolve) => setImmediate(resolve))

    release()
    await Promise.all([pass, edit, drain])

    expect(parseJournalEntry(fs.readFileSync(file, 'utf8'), DATE).frontmatter.tags).toEqual([
      'y',
      'x'
    ])
  })

  // Core `set_tags` dedupes the whole list by tag key, keeping the first
  // spelling; the desktop write keeps one spelling per key too (#5247 A18).
  it('writes one spelling per tag key when the day file holds case variants', async () => {
    await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, { date: DATE, content: 'Morning.' })
    const file = path.join(vault.path, 'journal', `${DATE}.md`)
    fs.writeFileSync(file, `---\ndate: ${DATE}\ntags:\n  - Work\n  - work\n---\nMorning.\n`)

    journalHandler.applyUpsert(
      { db: asSyncDb(dataDb.db), emit: vi.fn() },
      FOREIGN,
      { date: DATE, content: 'theirs\n', tags: ['x', 'WORK'] },
      { b: 1 }
    )
    await runJournalDayMerges(asSyncDb(dataDb.db), async () => true)

    expect(parseJournalEntry(fs.readFileSync(file, 'utf8'), DATE).frontmatter.tags).toEqual([
      'Work',
      'x'
    ])
  })
})
