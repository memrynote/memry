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
import { flushPendingWritebacks, hasArmedWritebacks, resetWritebackState } from './crdt-writeback'
import { markdownToYFragment } from './blocknote-converter'
import { getNoteCacheById, insertNoteCache } from '../database/queries/notes'
import { generateContentHash } from '../vault/frontmatter'
import { checkForRename, clearAllPendingDeletes, trackPendingDelete } from '../vault/rename-tracker'
import { pushFinalSnapshots } from './final-snapshot-push'
import type * as PersistenceModule from './crdt-persistence'
import type * as LoggerModule from '../lib/logger'

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

/** Error and warning lines logged in any scope. */
const errors = vi.hoisted(() => [] as Array<{ scope: string; message: unknown; context: unknown }>)
const warnings = vi.hoisted(
  () => [] as Array<{ scope: string; message: unknown; context: unknown }>
)
vi.mock('../lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof LoggerModule>()
  return {
    ...actual,
    createLogger: (scope: string) => {
      const scoped = actual.createLogger(scope)
      return Object.assign(Object.create(scoped), {
        error: (message: unknown, context?: unknown) => {
          errors.push({ scope, message, context })
          scoped.error(message, context)
        },
        warn: (message: unknown, context?: unknown) => {
          warnings.push({ scope, message, context })
          scoped.warn(message, context)
        }
      })
    }
  }
})

/** The CRDT store, in memory, for a provider whose persistence is initialized. */
const store = vi.hoisted(() => ({
  updates: new Map<string, Uint8Array[]>(),
  /** Runs inside the next doc flush. */
  nextFlush: null as null | (() => Promise<void>),
  /** Runs inside the next stored update. */
  nextUpdate: null as null | (() => Promise<void>),
  /** The tail of each opened store's call queue. */
  queues: [] as Promise<unknown>[],
  /** The store's LevelDB lock is held: an open finds no store. */
  locked: false,
  /** `destroy` calls made, and those the store ran. */
  destroyCalls: 0,
  destroysRun: 0
}))
vi.mock('./crdt-persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof PersistenceModule>()
  return {
    ...actual,
    openCrdtPersistence: async () => {
      if (store.locked) return null
      // y-leveldb runs every call of a store through one queue (`_transact`),
      // so a call that holds holds every later one.
      const queue = store.queues.push(Promise.resolve()) - 1
      const transact = <T>(call: () => Promise<T>): Promise<T> => {
        const run = store.queues[queue].then(call)
        store.queues[queue] = run.catch(() => {})
        return run
      }
      return {
        getYDoc: (noteId: string) =>
          transact(async () => {
            const doc = new Y.Doc()
            for (const update of store.updates.get(noteId) ?? []) Y.applyUpdate(doc, update)
            return doc
          }),
        storeUpdate: (noteId: string, update: Uint8Array) =>
          transact(async () => {
            const stored = store.nextUpdate
            store.nextUpdate = null
            await stored?.()
            store.updates.set(noteId, [...(store.updates.get(noteId) ?? []), update])
          }),
        flushDocument: () =>
          transact(async () => {
            const flush = store.nextFlush
            store.nextFlush = null
            await flush?.()
          }),
        clearDocument: (noteId: string) =>
          transact(async () => {
            store.updates.delete(noteId)
          }),
        destroy: () => {
          store.destroyCalls++
          return transact(async () => {
            store.destroysRun++
          })
        },
        getMeta: () => transact(async () => undefined),
        setMeta: () => transact(async () => {})
      }
    }
  }
})
vi.mock('./crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/unused', vaultUuid: 'vault-a' })
}))
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => false }))

const DATE = '2026-05-10'
const OTHER_DATE = '2026-05-11'
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

function dayFile(open: OpenVault, date = DATE): string {
  return path.join(open.vault.path, 'journal', `${date}.md`)
}

function dayBody(open: OpenVault, date = DATE): string {
  return parseJournalEntry(fs.readFileSync(dayFile(open, date), 'utf8'), date).content
}

function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child
    if (child instanceof Y.XmlElement) return firstText(child)
  }
  throw new Error('no text in the doc')
}

function bodyText(doc: Y.Doc): string {
  return firstText(doc.getXmlFragment(CRDT_FRAGMENT_NAME)).toString()
}

/** The day's body as the store holds it. */
function storedBody(noteId: string): string {
  const doc = new Y.Doc()
  for (const update of store.updates.get(noteId) ?? []) Y.applyUpdate(doc, update)
  return bodyText(doc)
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

/** Fails every write of `file` until `stop`. */
function failWrites(file: string): { stop: () => void } {
  const realWrite = fileOps.atomicWrite
  let failing = true
  vi.spyOn(fileOps, 'atomicWrite').mockImplementation(async (target, content) => {
    if (failing && target === file) throw new Error('disk full')
    return realWrite(target, content)
  })
  return { stop: () => (failing = false) }
}

/** Fails the next guarded write of `file`, before it writes. */
function failNextGuardedWrite(file: string): void {
  const realGuard = fileOps.beforeGuardedWrite
  let failNext = true
  vi.spyOn(fileOps, 'beforeGuardedWrite').mockImplementation(async (target) => {
    if (failNext && target === file) {
      failNext = false
      throw new Error('disk full')
    }
    return realGuard(target)
  })
}

/** Holds the next store flush of a doc. */
function holdNextStoreFlush(): Hold {
  const flush = hold()
  store.nextFlush = flush.wait
  return flush
}

/** Holds the next stored update of a doc. */
function holdNextStoreUpdate(): Hold {
  const update = hold()
  store.nextUpdate = update.wait
  return update
}

/** Advances the fake clock one step, then lets the real I/O between its timers run. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(250)
  await new Promise((resolve) => setImmediate(resolve))
}

/** Runs the fake clock until `work` settles. */
async function settle<T>(work: Promise<T>): Promise<T> {
  const finished = work.then(
    () => true,
    () => true
  )
  let settled = false
  while (!settled) settled = await Promise.race([finished, tick().then(() => false)])
  return work
}

function stalledStoreLogs(): unknown[] {
  return errors
    .filter(
      ({ message }) => message === 'CRDT store stalled; the vault closed without waiting for it'
    )
    .map(({ context }) => context)
}

/**
 * Indexes the day as the vault's indexer does, its file the baseline, so the
 * write-back's outside-edit check runs. Resolves the file.
 */
function indexDay(open: OpenVault, id: string, date = DATE): string {
  const raw = fs.readFileSync(dayFile(open, date), 'utf8')
  insertNoteCache(open.indexDb.db, {
    id,
    path: `journal/${date}.md`,
    title: date,
    createdAt: '2026-05-10T00:00:00.000Z',
    modifiedAt: '2026-05-10T00:00:00.000Z',
    contentHash: generateContentHash(raw)
  })
  return raw
}

/** Creates the day in vault A, its doc open as the editor seeded it. */
async function openDay(date = DATE): Promise<string> {
  await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, { date, content: 'From A.' })
  const id = resolveJournalEntryId(date)
  const doc = getCrdtProvider().getDoc(id) as Y.Doc
  await markdownToYFragment('From A.', doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  return id
}

async function openTypedDay(): Promise<string> {
  const id = await openDay()
  type(id, ' Typed.')
  return id
}

/**
 * The next session: the process ended without closing the vault (a quit cut
 * short, a forced exit, a crash), and the store opens afresh with what it holds.
 */
async function restart(): Promise<void> {
  resetWritebackState()
  resetCrdtProvider()
  store.queues = []
  await getCrdtProvider().initPersistence()
}

/** Types into the day while the store stalls, and lets its pass write `file`. */
async function typeIntoStalledStore(id: string, text: string, file: string): Promise<Hold> {
  const storing = holdNextStoreUpdate()
  type(id, text)
  await storing.reached
  // The pass's file write is real I/O: a loaded runner needs more event-loop
  // turns than a fixed count, so wait on real time and step the fake clock.
  await vi.waitFor(
    async () => {
      await tick()
      expect(fs.readFileSync(file, 'utf8')).toContain(text.trim())
    },
    { timeout: 10_000, interval: 10 }
  )
  return storing
}

describe('a keystroke while the vault closes', () => {
  let vaultA: OpenVault
  let vaultB: OpenVault

  beforeEach(() => {
    store.updates.clear()
    store.nextFlush = null
    store.nextUpdate = null
    store.queues = []
    errors.length = 0
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
    failNextGuardedWrite(dayFile(vaultA))
    await expect(
      invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date: DATE, content: 'Rewritten.' })
    ).rejects.toThrow('disk full')
    expect(getCrdtProvider().getDoc(id)).toBeUndefined()

    await closeVault()

    expect(dayBody(vaultA)).toContain('Rewritten.')
  })

  it('lands a closed day whose save failed while the close wrote another day', async () => {
    await getCrdtProvider().initPersistence()
    const id = await openDay()
    await getCrdtProvider().closeIfInactive(id)
    const otherId = await openDay(OTHER_DATE)
    type(otherId, ' Typed.')

    // The close's write-back flush writes the other day. Meanwhile the closed
    // day's body save feeds its doc, then its file write fails, which arms a
    // retry for the closed doc.
    const write = holdNextWrite(dayFile(vaultA, OTHER_DATE))
    const closing = closeVault()
    await write.reached
    failNextGuardedWrite(dayFile(vaultA))
    await expect(
      invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, { date: DATE, content: 'Rewritten.' })
    ).rejects.toThrow('disk full')
    write.release()
    await closing

    expect.soft(dayBody(vaultA, OTHER_DATE)).toContain('From A. Typed.')
    expect.soft(dayBody(vaultA)).toContain('Rewritten.')
  })

  it('the flush of a quit lands a keystroke typed while its own pass wrote', async () => {
    const id = await openTypedDay()

    const write = holdNextWrite(dayFile(vaultA))
    const flushing = flushPendingWritebacks()
    await write.reached
    type(id, ' More.')
    write.release()
    await flushing

    expect.soft(dayBody(vaultA)).toContain('From A. Typed. More.')
    expect.soft(hasArmedWritebacks()).toBe(false)
  })
})

describe('a CRDT store that stalls while the vault closes (#5698)', () => {
  let vaultA: OpenVault

  beforeEach(async () => {
    store.updates.clear()
    store.nextFlush = null
    store.nextUpdate = null
    store.queues = []
    store.locked = false
    store.destroyCalls = 0
    store.destroysRun = 0
    errors.length = 0
    warnings.length = 0
    vaultA = makeVault('writeback-store-stall-a')
    bind(vaultA)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    registerJournalHandlers()
    await getCrdtProvider().initPersistence()
  })

  afterEach(() => {
    clearAllPendingDeletes()
    resetWritebackState()
    resetCrdtProvider()
    vi.useRealTimers()
    resetIpcMocks()
    vi.restoreAllMocks()
    vaultA.indexDb.close()
    vaultA.dataDb.close()
    vaultA.vault.cleanup()
  })

  it('closes the vault with the keystroke in its file, and the store keeps it for the reopen', async () => {
    const id = await openTypedDay()

    // The store never answers the close's flush. A keystroke lands behind it.
    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    type(id, ' More.')
    await settle(closing)

    expect.soft(dayBody(vaultA)).toContain('From A. Typed. More.')
    expect.soft(storedBody(id)).not.toContain('More.')
    expect
      .soft(stalledStoreLogs())
      .toEqual([expect.objectContaining({ stalledFlushNoteId: id, unstoredNoteIds: [id] })])

    // The store recovers, and lands the keystroke before its close.
    storing.release()
    await Promise.all(store.queues)
    await getCrdtProvider().initPersistence()
    const doc = await getCrdtProvider().open(id, EDITOR_WINDOW)

    expect(bodyText(doc)).toBe('From A. Typed. More.')
  })

  it('waits for the pass a debounce started while the store stalled', async () => {
    const id = await openTypedDay()

    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    const write = holdNextWrite(dayFile(vaultA))
    type(id, ' More.')
    let closed = false
    void closing.then(() => (closed = true))
    // Well past the debounce and every store wait of the close.
    for (let step = 0; step < 40; step++) await tick()
    await write.reached

    expect.soft(closed).toBe(false)
    write.release()
    await settle(closing)
    expect(dayBody(vaultA)).toContain('From A. Typed. More.')
  })

  it('keeps a keystroke whose file write failed for the reopen, which writes it back', async () => {
    const id = await openTypedDay()

    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    const disk = failWrites(dayFile(vaultA))
    type(id, ' More.')
    await settle(closing)
    disk.stop()

    expect.soft(dayBody(vaultA)).not.toContain('More.')
    expect.soft(stalledStoreLogs()).toHaveLength(1)

    storing.release()
    await Promise.all(store.queues)
    await getCrdtProvider().initPersistence()
    await getCrdtProvider().open(id, EDITOR_WINDOW)
    type(id, ' Again.')
    await flushPendingWritebacks()

    expect(dayBody(vaultA)).toContain('From A. Typed. More. Again.')
  })

  it('reopens a store that never recovered with the keystroke the close wrote to the file', async () => {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    indexDay(vaultA, id)

    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    type(id, ' More.')
    await settle(closing)

    // The store never answers again. The next session opens it afresh, with
    // the doc it holds from before the keystroke.
    store.queues = []
    await getCrdtProvider().initPersistence()
    const doc = await getCrdtProvider().open(id, EDITOR_WINDOW)

    // Its first open takes the file in, so no pass writes the older doc over it.
    expect.soft(bodyText(doc)).toBe('From A. Typed. More.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More.')
  })

  it('closes when a pass takes in an outside edit behind the stalled store', async () => {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    const written = indexDay(vaultA, id)

    // The store stalls on a keystroke; the file changes outside the app, and
    // the keystroke's pass takes that edit in, which waits on the store.
    const storing = holdNextStoreUpdate()
    type(id, ' More.')
    await storing.reached
    fs.writeFileSync(dayFile(vaultA), written.replace('From A. Typed.', 'From A. Typed. Outside.'))
    const close = { done: false }
    void closeVault().then(() => (close.done = true))
    for (let step = 0; step < 200 && !close.done; step++) await tick()

    expect(close.done).toBe(true)
    expect.soft(dayBody(vaultA)).toContain('From A. Typed. Outside.')

    store.queues = []
    await getCrdtProvider().initPersistence()
    const doc = await getCrdtProvider().open(id, EDITOR_WINDOW)

    expect(bodyText(doc)).toContain('From A. Typed. Outside.')
  })

  it('the stall log is out while the store still holds its close', async () => {
    const id = await openTypedDay()

    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    await settle(closing)

    expect.soft(stalledStoreLogs()).toEqual([expect.objectContaining({ stalledFlushNoteId: id })])
    expect.soft(store.destroyCalls).toBe(1)
    expect(store.destroysRun).toBe(0)
  })

  it('a reopen that finds the store still locked says which note stalled it', async () => {
    const id = await openTypedDay()

    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    await settle(closing)
    store.locked = true
    await getCrdtProvider().initPersistence()

    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: 'A store call stalled at the last vault close; this session runs in memory',
        context: { stalledFlushNoteId: id }
      })
    )
  })

  it('a quit cut short behind a stalled store keeps both days for the next session (Q1)', async () => {
    const dayA = await openTypedDay()
    const dayB = await openDay(OTHER_DATE)
    await flushPendingWritebacks()
    indexDay(vaultA, dayA)
    const writtenB = indexDay(vaultA, dayB, OTHER_DATE)

    // Day A: the store stalls on a keystroke, whose pass writes it to the file.
    await typeIntoStalledStore(dayA, ' More.', dayFile(vaultA))
    expect(dayBody(vaultA)).toContain('From A. Typed. More.')
    // Day B: an outside edit, then a keystroke whose pass takes the edit in,
    // which waits on the store.
    fs.writeFileSync(dayFile(vaultA, OTHER_DATE), writtenB.replace('From A.', 'From A. Outside.'))
    type(dayB, ' Typed.')
    for (let step = 0; step < 12; step++) await tick()

    // The quit's flush-writebacks step.
    getCrdtProvider().beginClose()
    const flush = { done: false }
    void flushPendingWritebacks().then(() => (flush.done = true))
    for (let step = 0; step < 200 && !flush.done; step++) await tick()
    expect(flush.done).toBe(true)
    expect.soft(warnings).toContainEqual(
      expect.objectContaining({
        message: 'A store wait gave up: the CRDT store stalled while the vault closed',
        context: expect.objectContaining({ noteId: dayB })
      })
    )

    // The quit's budget ends before the vault closes.
    await restart()
    const docA = await getCrdtProvider().open(dayA, EDITOR_WINDOW)
    const docB = await getCrdtProvider().open(dayB, EDITOR_WINDOW)
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(docA)).toBe('From A. Typed. More.')
    expect.soft(dayBody(vaultA)).toContain('From A. Typed. More.')
    expect.soft(bodyText(docB)).toContain('From A. Outside.')
    expect(dayBody(vaultA, OTHER_DATE)).toContain('From A. Outside.')
  })

  it('a forced exit after a write the stalled store never held keeps the edit', async () => {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    indexDay(vaultA, id)

    await typeIntoStalledStore(id, ' More.', dayFile(vaultA))
    expect(dayBody(vaultA)).toContain('From A. Typed. More.')

    await restart()
    const doc = await getCrdtProvider().open(id, EDITOR_WINDOW)
    type(id, ' Again.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Again.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Again.')
  })

  it('records the written file as stored once the store recovers', async () => {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    indexDay(vaultA, id)

    const storing = await typeIntoStalledStore(id, ' More.', dayFile(vaultA))
    storing.release()
    await Promise.all(store.queues)
    await tick()

    const written = fs.readFileSync(dayFile(vaultA), 'utf8')
    expect(getNoteCacheById(vaultA.indexDb.db, id)).toMatchObject({
      contentHash: generateContentHash(written),
      pendingWriteHash: null
    })
  })

  it('an outside rename after a stalled close keeps the note (R1)', async () => {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    indexDay(vaultA, id)

    const storing = holdNextStoreFlush()
    const closing = closeVault()
    await storing.reached
    type(id, ' More.')
    await settle(closing)

    // The watcher's unlink of the day, then the add of its moved file.
    const cached = getNoteCacheById(vaultA.indexDb.db, id)
    const onRealDelete = vi.fn(async () => {})
    trackPendingDelete(id, cached?.contentHash ?? '', `journal/${DATE}.md`, onRealDelete, null)
    const moved = fs.readFileSync(dayFile(vaultA), 'utf8')

    expect(checkForRename(generateContentHash(moved), 'journal/moved.md')).toMatchObject({ id })
    expect(onRealDelete).not.toHaveBeenCalled()
  })

  it('bounds the final snapshot push of a vault switch behind a stalled store (S1)', async () => {
    await getCrdtProvider().init(
      undefined,
      vi.fn(async () => {})
    )
    const id = await openTypedDay()
    const storing = holdNextStoreUpdate()
    type(id, ' More.')
    await storing.reached

    const push = { done: false }
    void pushFinalSnapshots().then(() => (push.done = true))
    for (let step = 0; step < 200 && !push.done; step++) await tick()

    expect(push.done).toBe(true)
    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: 'Pre-shutdown CRDT snapshot push cut short; remaining snapshots deferred',
        context: expect.objectContaining({ unpushedNoteIds: [id] })
      })
    )
  })
})
