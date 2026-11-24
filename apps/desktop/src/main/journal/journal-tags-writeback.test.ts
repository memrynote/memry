/**
 * A journal entry created with tags seeds its doc's `tags` array. A later
 * tags-only `journal:updateEntry` writes only the file, so that array goes
 * stale; the write-back of the next keystroke must keep the file's tags
 * (#5476). The create queues itself for sync and tells the windows after its
 * write-back turn; a quit or a tags save can land in between (REVIEW-5633,
 * REVIEW-5657).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as Y from 'yjs'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import type { JournalEntry } from '@memry/contracts/journal-api'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
// After mock-ipc: the electron mock below hands out its `ipcMain`.
import { BrowserWindow } from 'electron'
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
import * as projections from '../projections'
import * as vaultJournal from '../vault/journal'
import { registerJournalHandlers } from '../ipc/journal-handlers'
import { getCrdtProvider, resetCrdtProvider } from '../sync/crdt-provider'
import { flushPendingWritebacks, resetWritebackState, writebackNow } from '../sync/crdt-writeback'
import { enqueueLocalSyncCreate } from '../sync/local-mutations'
import { markdownToYFragment } from '../sync/blocknote-converter'
import { resolveJournalEntryId } from './create-entry'
import { addJournalTags } from './update-entry'

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

describe('a tags-only journal update, then a keystroke (#5476)', () => {
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

interface Hold {
  reached: Promise<void>
  release: () => void
  /** Resolves once `reached`, then waits for `release`. */
  wait: () => Promise<void>
}

function hold(): Hold {
  let release!: () => void
  const busy = new Promise<void>((resolve) => (release = resolve))
  let reach!: () => void
  const reached = new Promise<void>((resolve) => (reach = resolve))
  return {
    reached,
    release,
    wait: async () => {
      reach()
      await busy
    }
  }
}

/** Holds the projection lane, which the create's sync enqueue waits on. */
function holdProjectionLane(): Hold {
  const lane = hold()
  vi.spyOn(projections, 'flushProjectionEvents').mockImplementation(lane.wait)
  return lane
}

/** Holds the create's file write. */
function holdFileWrite(): Hold {
  const write = hold()
  const real = vaultJournal.writeJournalEntryWithContent
  vi.spyOn(vaultJournal, 'writeJournalEntryWithContent').mockImplementation(async (...args) => {
    await write.wait()
    return real(...args)
  })
  return write
}

const creates: Array<[string, (date: string) => Promise<JournalEntry>]> = [
  [
    'journal:createEntry',
    (date) => invokeHandler(JournalChannels.invoke.CREATE_ENTRY, { date, content: 'Morning.' })
  ],
  [
    'a tags save of a day with no file',
    (date) => invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date, tags: ['focus'] })
  ],
  [
    'a body save of a day with no file',
    (date) => invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date, content: 'Morning.' })
  ]
]

describe.each([
  ['its sync enqueue', holdProjectionLane],
  ['its file write', holdFileWrite]
])('a journal create right before a quit, during %s (REVIEW-5633)', (_during, holdCreate) => {
  // The flush stops waiting for the create after a capped wait. Faked, the
  // cap never runs out under a slow machine's create (REVIEW-5666).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(creates)('%s: queued for sync while the sync runtime still runs', async (_, create) => {
    const date = '2026-05-11'
    const lane = holdCreate()
    // The quit stops the sync runtime once the write-back flush settles; an
    // enqueue after that has no service and is dropped.
    let runtimeUp = true
    const queued: unknown[][] = []
    vi.mocked(enqueueLocalSyncCreate).mockImplementation((...args) => {
      if (runtimeUp) queued.push(args)
    })

    const saved = create(date)
    await lane.reached
    const quit = flushPendingWritebacks().then(() => (runtimeUp = false))
    await new Promise((resolve) => setImmediate(resolve))
    lane.release()
    await Promise.all([quit, saved])

    expect(queued).toEqual([['journal', resolveJournalEntryId(date), date]])
  })
})

describe('a tags save while a journal create is queued (REVIEW-5633)', () => {
  // The window that created the day caches the reply as the entry, and its
  // next tags save sends that whole list: a reply without the merge's tag
  // would drop it from the file.
  it.each(creates)('%s: the reply carries a tag another writer added', async (_, create) => {
    const date = '2026-05-13'
    const lane = holdProjectionLane()
    const created = create(date)
    await lane.reached

    await addJournalTags(date, ['merged'])
    lane.release()

    expect((await created).tags).toContain('merged')
  })

  it('the last event the windows get for the day carries the newer tags', async () => {
    const date = '2026-05-12'
    const lane = holdProjectionLane()
    const created = invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date, tags: ['a'] })
    await lane.reached

    await invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date, tags: ['a', 'b'] })
    lane.release()
    await created

    const events = vi
      .mocked(BrowserWindow.getAllWindows()[0].webContents.send)
      .mock.calls.filter(
        ([channel, event]) =>
          (channel === JournalChannels.events.ENTRY_CREATED ||
            channel === JournalChannels.events.ENTRY_UPDATED) &&
          (event as { date: string }).date === date
      )
    expect(events.map(([channel]) => channel)).toContain(JournalChannels.events.ENTRY_CREATED)
    const [, last] = events[events.length - 1]
    expect((last as { entry: { tags: string[] } }).entry.tags).toEqual(['a', 'b'])
  })
})
