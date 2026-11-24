/**
 * A vault close flushes the armed write-backs and stores the docs, then drops
 * the write-back state. A keystroke that lands during either step arms one
 * more pass. It belongs to the closing vault; armed past the close, it fired
 * into whichever vault was open by then, and a journal day has the same id in
 * every vault (#5247 OL-M35).
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
import * as vaultStatus from '../vault/status'
import * as fileOps from '../vault/file-ops'
import * as database from '../database'
import * as databaseClient from '../database/client'
import { closeVault } from '../vault'
import { parseJournalEntry } from '../vault/journal'
import { registerJournalHandlers } from '../ipc/journal-handlers'
import { resolveJournalEntryId } from '../journal/create-entry'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import { flushPendingWritebacks, resetWritebackState } from './crdt-writeback'
import { markdownToYFragment } from './blocknote-converter'
import type * as PersistenceModule from './crdt-persistence'

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

/** The CRDT store, in memory, for a provider whose persistence is initialized. */
const store = vi.hoisted(() => ({
  updates: new Map<string, Uint8Array[]>(),
  /** Runs inside the next doc flush. */
  nextFlush: null as null | (() => Promise<void>)
}))
vi.mock('./crdt-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof PersistenceModule>()
  return {
    ...actual,
    openCrdtPersistence: async () => ({
      getYDoc: async (noteId: string) => {
        const doc = new Y.Doc()
        for (const update of store.updates.get(noteId) ?? []) Y.applyUpdate(doc, update)
        return doc
      },
      storeUpdate: async (noteId: string, update: Uint8Array) => {
        store.updates.set(noteId, [...(store.updates.get(noteId) ?? []), update])
      },
      flushDocument: async () => {
        const flush = store.nextFlush
        store.nextFlush = null
        await flush?.()
      },
      clearDocument: async (noteId: string) => {
        store.updates.delete(noteId)
      },
      destroy: () => {},
      getMeta: async () => undefined,
      setMeta: async () => {}
    })
  }
})
vi.mock('./crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/unused', vaultUuid: 'vault-a' })
}))
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => false }))

const DATE = '2026-05-10'
const EDITOR_WINDOW = 7

interface OpenVault {
  vault: TestVaultResult
  dataDb: TestDatabaseResult
  indexDb: TestDatabaseResult
}

function makeVault(name: string): OpenVault {
  return { vault: createTestVault(name), dataDb: createTestDataDb(), indexDb: createTestIndexDb() }
}

/** Points the vault status, config and both databases at `open`. */
function bind(open: OpenVault): void {
  vi.spyOn(vaultStatus, 'getStatus').mockReturnValue({
    isOpen: true,
    path: open.vault.path,
    isIndexing: false,
    indexProgress: 100,
    error: null
  } satisfies VaultStatus)
  vi.spyOn(vaultStatus, 'getConfig').mockReturnValue({
    excludePatterns: ['.git', 'node_modules', '.trash'],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  } satisfies VaultConfig)
  vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(open.dataDb.db))
  vi.spyOn(database, 'getIndexDatabase').mockReturnValue(open.indexDb.db)
  vi.spyOn(databaseClient, 'getDatabase').mockReturnValue(asClientDb(open.dataDb.db))
  vi.spyOn(databaseClient, 'getIndexDatabase').mockReturnValue(open.indexDb.db)
}

function dayFile(open: OpenVault): string {
  return path.join(open.vault.path, 'journal', `${DATE}.md`)
}

function dayBody(open: OpenVault): string {
  return parseJournalEntry(fs.readFileSync(dayFile(open), 'utf8'), DATE).content
}

function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child
    if (child instanceof Y.XmlElement) return firstText(child)
  }
  throw new Error('no text in the doc')
}

/** A keystroke from the editor window, sent as `crdt:apply-update` sends it. */
function type(noteId: string, text: string): void {
  const doc = getCrdtProvider().getDoc(noteId) as Y.Doc
  const editor = new Y.Doc()
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc))
  const node = firstText(editor.getXmlFragment(CRDT_FRAGMENT_NAME))
  node.insert(node.length, text)
  const update = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(doc))
  getCrdtProvider().applyIpcUpdate(noteId, update, EDITOR_WINDOW)
}

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

/** Holds the next write of `file`. */
function holdNextWrite(file: string): Hold {
  const write = hold()
  const realWrite = fileOps.atomicWrite
  let holdNext = true
  vi.spyOn(fileOps, 'atomicWrite').mockImplementation(async (target, content) => {
    if (holdNext && target === file) {
      holdNext = false
      await write.wait()
    }
    return realWrite(target, content)
  })
  return write
}

/** Holds the next store flush of a doc. */
function holdNextStoreFlush(): Hold {
  const flush = hold()
  store.nextFlush = flush.wait
  return flush
}

/** Creates the day in vault A, its doc open as the editor seeded it. */
async function openDay(): Promise<string> {
  await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, { date: DATE, content: 'From A.' })
  const id = resolveJournalEntryId(DATE)
  const doc = getCrdtProvider().getDoc(id) as Y.Doc
  await markdownToYFragment('From A.', doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return id
}

async function openTypedDay(): Promise<string> {
  const id = await openDay()
  type(id, ' Typed.')
  return id
}

describe('a keystroke while the vault closes', () => {
  let vaultA: OpenVault
  let vaultB: OpenVault

  beforeEach(() => {
    store.updates.clear()
    store.nextFlush = null
    vaultA = makeVault('writeback-vault-close-a')
    vaultB = makeVault('writeback-vault-close-b')
    bind(vaultA)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    registerJournalHandlers()
  })

  afterEach(() => {
    resetWritebackState()
    resetCrdtProvider()
    vi.useRealTimers()
    resetIpcMocks()
    vi.restoreAllMocks()
    for (const open of [vaultA, vaultB]) {
      open.indexDb.close()
      open.dataDb.close()
      open.vault.cleanup()
    }
  })

  it('lands in the closing vault, and never in the same day of the next vault', async () => {
    const id = await openTypedDay()

    // The close flushes that pass; the editor sends one more keystroke while
    // the pass writes the file.
    const write = holdNextWrite(dayFile(vaultA))
    const closing = closeVault()
    await write.reached
    type(id, ' More.')
    write.release()
    await closing

    // Vault B opens. It has the same day, which no editor has open.
    bind(vaultB)
    await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, { date: DATE, content: 'From B.' })
    await getCrdtProvider().closeIfInactive(id)
    await vi.advanceTimersByTimeAsync(10_000)
    // Waits for a pass the timers started.
    await flushPendingWritebacks()

    expect.soft(dayBody(vaultA)).toContain('From A. Typed. More.')
    expect.soft(dayBody(vaultB)).toContain('From B.')
    expect.soft(dayBody(vaultB)).not.toContain('From A.')
  })

  it('lands in the closing vault when it arrives while the close stores the docs', async () => {
    await getCrdtProvider().initPersistence()
    const id = await openTypedDay()

    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    type(id, ' More.')
    storing.release()
    await closing

    expect(dayBody(vaultA)).toContain('From A. Typed. More.')
  })

  it('lands a closed day whose file write failed in the closing vault', async () => {
    await getCrdtProvider().initPersistence()
    const id = await openDay()
    // The editor closes the day; its doc stays in the store.
    await getCrdtProvider().closeIfInactive(id)

    // The body save feeds the closed day's doc, then its file write fails.
    const realGuard = fileOps.beforeGuardedWrite
    let failNext = true
    vi.spyOn(fileOps, 'beforeGuardedWrite').mockImplementation(async (target) => {
      if (failNext && target === dayFile(vaultA)) {
        failNext = false
        throw new Error('disk full')
      }
      return realGuard(target)
    })
    await expect(
      invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date: DATE, content: 'Rewritten.' })
    ).rejects.toThrow('disk full')
    expect(getCrdtProvider().getDoc(id)).toBeUndefined()

    await closeVault()

    expect(dayBody(vaultA)).toContain('Rewritten.')
  })
})
