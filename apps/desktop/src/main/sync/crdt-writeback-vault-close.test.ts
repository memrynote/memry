/**
 * A vault close flushes the armed write-backs and stores the docs, then drops
 * the write-back state. A keystroke that lands during either step arms one
 * more pass. It belongs to the closing vault; armed past the close, it fired
 * into whichever vault was open by then, and a journal day has the same id in
 * every vault (#5247 OL-M35).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
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
import { closeVault as closeVaultInQueue } from '../vault'
import { parseJournalEntry } from '../vault/journal'
import { registerJournalHandlers } from '../ipc/journal-handlers'
import { resolveJournalEntryId } from '../journal/create-entry'
import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import {
  flushPendingWritebacks as flushWritebacks,
  hasArmedWritebacks,
  resetWritebackState,
  takeWritebackTurn
} from './crdt-writeback'
import { markdownToYFragment } from './blocknote-converter'
import {
  deleteNoteCache,
  getNoteCacheById,
  getNoteSnapshots,
  insertNoteCache,
  UNSTORED_FILE,
  updateNoteCache
} from '../database/queries/notes'
import { generateContentHash } from '../vault/frontmatter'
import { checkForRename, clearAllPendingDeletes, trackPendingDelete } from '../vault/rename-tracker'
import { pushFinalSnapshots } from './final-snapshot-push'
import { deleteCaseTwin } from '../vault/case-twin-file'
import { deleteNoteMetadata, upsertNoteMetadata } from '@memry/storage-data'
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

function fileSystemIgnoresCase(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-case-probe-'))
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '')
    return fs.existsSync(path.join(dir, 'PROBE'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
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
  holds.push(() => release())
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

/** The release of every hold, and every close and flush a test started. */
const holds: Array<() => void> = []
const started: Promise<unknown>[] = []

function closeVault(): Promise<void> {
  const closing = closeVaultInQueue()
  started.push(closing)
  return closing
}

function flushPendingWritebacks(): Promise<void> {
  const flushing = flushWritebacks()
  started.push(flushing)
  return flushing
}

/**
 * Lets the work a failed test left running end before the next test starts.
 * A close left waiting holds the vault lifecycle queue, so every later close
 * would wait on it, and a pass left running reads the databases the hook
 * closes.
 */
async function drainLeftovers(): Promise<void> {
  store.nextFlush = null
  store.nextUpdate = null
  for (const release of holds.splice(0)) release()
  const drained = { done: false }
  void Promise.allSettled([...started.splice(0), flushWritebacks(), ...store.queues]).then(
    () => (drained.done = true)
  )
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  for (let step = 0; step < 400 && !drained.done; step++) await tick()
  if (!drained.done) console.warn('A test left a close, flush or store call that never ended')
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

/** Fails every stored update until `recover`, as a full disk does. */
function failStore(): { recover: () => void } {
  let failing = true
  const fail = async (): Promise<void> => {
    if (failing) store.nextUpdate = fail
    throw new Error('disk full')
  }
  store.nextUpdate = fail
  return {
    recover: () => {
      failing = false
      store.nextUpdate = null
    }
  }
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
  // The create's index row lands through the projection lane, which this
  // suite does not run. Without it a pass's version of the file has no
  // parent row.
  const file = path.join(vaultStatus.getStatus().path ?? '', 'journal', `${date}.md`)
  insertNoteCache(database.getIndexDatabase(), {
    id,
    path: `journal/${date}.md`,
    title: date,
    date,
    createdAt: '2026-05-10T00:00:00.000Z',
    modifiedAt: '2026-05-10T00:00:00.000Z',
    contentHash: generateContentHash(fs.readFileSync(file, 'utf8'))
  })
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
  await waitForRecordedWrite(id, text, file)
  return storing
}

/**
 * Waits until the pass wrote `text` to `file` and recorded that file in the
 * note's row. The file holds the bytes a moment before the write resolves and
 * the pass records them (`recordDocFile`). The write is real I/O: a loaded
 * runner needs more event-loop turns than a fixed count, so this waits on real
 * time and steps the fake clock.
 */
async function waitForRecordedWrite(id: string, text: string, file: string): Promise<void> {
  await vi.waitFor(
    async () => {
      await tick()
      const raw = fs.readFileSync(file, 'utf8')
      expect(raw).toContain(text.trim())
      expect(getNoteCacheById(database.getIndexDatabase(), id)?.contentHash).toBe(
        generateContentHash(raw)
      )
    },
    { timeout: 10_000, interval: 10 }
  )
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

  afterEach(async () => {
    await drainLeftovers()
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

  afterEach(async () => {
    await drainLeftovers()
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
    await settle(write.reached)

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
    await settle(closeVault())

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
    await settle(flushPendingWritebacks())
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

    await settle(pushFinalSnapshots())

    expect(warnings).toContainEqual(
      expect.objectContaining({
        message: 'Pre-shutdown CRDT snapshot push cut short; remaining snapshots deferred',
        context: expect.objectContaining({ unpushedNoteIds: [id] })
      })
    )
  })

  /**
   * The store fails a keystroke, whose pass writes it to the file (marked
   * unstored), then recovers: the next keystroke stores the whole doc, which
   * holds the file's bytes and more. Resolves the day.
   */
  async function storeFailsThenRecovers(): Promise<string> {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    indexDay(vaultA, id)

    const disk = await typeIntoFailedStore(id, dayFile(vaultA))
    disk.recover()

    type(id, ' Two.')
    await Promise.all(store.queues)
    await new Promise((resolve) => setImmediate(resolve))
    expect.soft(storedBody(id)).toBe('From A. Typed. More. Two.')
    return id
  }

  /**
   * The day, written and indexed, then closed and reopened once, so this
   * session's first-open check of its file is spent. Resolves the day.
   */
  async function checkedDay(): Promise<string> {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    indexDay(vaultA, id)
    await settle(getCrdtProvider().close(id))
    await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
    return id
  }

  /** The store fails a keystroke, whose pass writes it to the file, marked unstored. */
  async function typeIntoFailedStore(id: string, file: string, text = ' More.') {
    const disk = failStore()
    type(id, text)
    await waitForRecordedWrite(id, text, file)
    expect(getNoteCacheById(vaultA.indexDb.db, id)?.pendingWriteHash).toMatch(/^unstored-file/)
    await Promise.all(store.queues)
    return disk
  }

  /** What the store holds of the note once its queue is empty. */
  async function settledStoredBody(id: string): Promise<string> {
    await Promise.all(store.queues)
    return storedBody(id)
  }

  const CASE_TWIN_LOWER = '# Lower.\n'

  /**
   * Two case twins on one file, the survivor's doc open with a keystroke its
   * store failed. The other twin's delete writes the survivor's doc to the
   * file (`planLeave`), then the process ends. Resolves the survivor.
   */
  async function survivorOfTwinDelete(): Promise<{ id: string; file: string }> {
    const lower = 'twin-lower'
    const upper = 'twin-upper'
    const dir = path.join(vaultA.vault.path, 'Supernotes')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'a.md')
    fs.writeFileSync(file, '# Upper.\n')
    for (const [id, relativePath] of [
      [lower, 'Supernotes/a.md'],
      [upper, 'SUPERNOTES/a.md']
    ] as const) {
      const fields = {
        id,
        path: relativePath,
        title: 'a',
        fileType: 'markdown' as const,
        createdAt: '2026-05-10T00:00:00.000Z',
        modifiedAt: '2026-05-10T00:00:00.000Z',
        syncedAt: '2026-05-10T00:00:00.000Z'
      }
      upsertNoteMetadata(asClientDb(vaultA.dataDb.db), fields)
      const body = id === lower ? CASE_TWIN_LOWER : '# Upper.\n'
      insertNoteCache(vaultA.indexDb.db, { ...fields, contentHash: generateContentHash(body) })
    }
    const seeded = new Y.Doc()
    await markdownToYFragment(CASE_TWIN_LOWER, seeded.getXmlFragment(CRDT_FRAGMENT_NAME))
    store.updates.set(lower, [Y.encodeStateAsUpdate(seeded)])
    await getCrdtProvider().open(lower, EDITOR_WINDOW)
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const disk = failStore()
    type(lower, ' More.')
    await Promise.all(store.queues)
    await settle(
      deleteCaseTwin(
        vaultA.vault.path,
        'SUPERNOTES/a.md',
        upper,
        async (inStep) => inStep(() => {}),
        () => {
          deleteNoteMetadata(asClientDb(vaultA.dataDb.db), upper)
          deleteNoteCache(vaultA.indexDb.db, upper)
        }
      )
    )
    expect.soft(fs.readFileSync(file, 'utf8')).toContain('Lower. More.')
    disk.recover()
    await restart()
    return { id: lower, file }
  }

  // Each trigger but the case twin loses an edit with crdt-provider.ts,
  // writeback-baseline.ts and crdt-writeback-ingest.ts at 02ec439e41; the
  // vault close and the same-session reopen at 0469b6b468 too. The case twin
  // loses it when vault/case-twin-file.ts records the survivor's doc-built
  // file as stored (`recordBaseline` in place of `recordDocFile`).
  for (const [trigger, endSession] of [
    [
      'a vault close whose write fails behind a store that keeps failing',
      async () => {
        const id = await openTypedDay()
        await flushPendingWritebacks()
        indexDay(vaultA, id)
        const disk = await typeIntoFailedStore(id, dayFile(vaultA))
        // The close's pass of a later keystroke fails to write: the file keeps
        // " More.", which the store never held.
        type(id, ' Two.')
        const writes = failWrites(dayFile(vaultA))
        await settle(closeVault())
        writes.stop()
        disk.recover()
        resetCrdtProvider()
        store.queues = []
        await getCrdtProvider().initPersistence()
        return { id, file: dayFile(vaultA), kept: 'From A. Typed. More.' }
      }
    ],
    [
      'a quit cut short after its flush',
      async () => {
        const id = await checkedDay()
        const disk = await typeIntoFailedStore(id, dayFile(vaultA))
        disk.recover()
        getCrdtProvider().beginClose()
        await settle(flushPendingWritebacks())
        // A keystroke the store takes after the quit's flush step, before its budget ends.
        type(id, ' Two.')
        await Promise.all(store.queues)
        await restart()
        return { id, file: dayFile(vaultA), kept: 'From A. Typed. More. Two.' }
      }
    ],
    [
      'a forced exit inside the debounce (P2)',
      async () => {
        const id = await storeFailsThenRecovers()
        await restart()
        return { id, file: dayFile(vaultA), kept: 'From A. Typed. More. Two.' }
      }
    ],
    [
      'a case twin leaving the survivor its doc-built file',
      async () => {
        const { id, file } = await survivorOfTwinDelete()
        return { id, file, kept: 'Lower. More.' }
      }
    ],
    [
      'a close and a reopen in the same session (R3)',
      async () => {
        const id = await checkedDay()
        const disk = await typeIntoFailedStore(id, dayFile(vaultA))
        await settle(getCrdtProvider().close(id))
        disk.recover()
        return { id, file: dayFile(vaultA), kept: 'From A. Typed. More.' }
      }
    ]
  ] as const) {
    // A case twin needs a file system that folds case; ubuntu CI skips it.
    const runs = !trigger.startsWith('a case twin') || fileSystemIgnoresCase()
    it.runIf(runs)(`an edit the store missed survives ${trigger}`, async () => {
      const { id, file, kept } = await endSession()

      const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
      type(id, ' Again.')
      await settle(flushPendingWritebacks())

      expect.soft(bodyText(doc)).toBe(`${kept} Again.`)
      expect.soft(await settledStoredBody(id)).toBe(`${kept} Again.`)
      expect(fs.readFileSync(file, 'utf8')).toContain(`${kept} Again.`)
    })
  }

  // VERIFY-5703R3 (1): the store recovers between a close and the reopen.
  it('a reopen in the same session takes in the file its closed doc never stored', async () => {
    const id = await checkedDay()
    const disk = await typeIntoFailedStore(id, dayFile(vaultA))
    await settle(getCrdtProvider().close(id))
    disk.recover()

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
    type(id, ' Two.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Two.')
    expect.soft(await settledStoredBody(id)).toBe('From A. Typed. More. Two.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Two.')
  })

  // VERIFY-5703R4 PROBE a: a reopen while the closing doc's pass writes its file.
  it('a reopen while the closed doc writes its file takes that file in', async () => {
    const id = await checkedDay()
    const disk = failStore()
    const write = holdNextWrite(dayFile(vaultA))
    type(id, ' More.')
    await settle(write.reached)

    const closed = getCrdtProvider().close(id)
    disk.recover()
    const opened = getCrdtProvider().open(id, EDITOR_WINDOW)
    write.release()
    // The close ends on real I/O alone. Stepping the fake clock meanwhile
    // runs out the open's wait for it on a loaded runner.
    await closed
    const doc = await settle(opened)
    type(id, ' Two.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Two.')
    expect.soft(await settledStoredBody(id)).toBe('From A. Typed. More. Two.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Two.')
  })

  // VERIFY-5703R4 PROBE b: a close inside the debounce of a keystroke the store missed.
  it('a close inside the debounce writes the keystroke the store missed for the reopen', async () => {
    const id = await checkedDay()
    const disk = failStore()
    type(id, ' More.')
    await settle(getCrdtProvider().close(id))
    disk.recover()

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
    await settle(flushPendingWritebacks())
    type(id, ' Two.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Two.')
    expect.soft(await settledStoredBody(id)).toBe('From A. Typed. More. Two.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Two.')
  })

  // VERIFY-5703R4 (1i), VERIFY-5703R5 (2): the mark is written ahead of the
  // file, and a stored edit made after the write stays live.
  it('a crash between the file write and its record keeps every stored edit live', async () => {
    const id = await checkedDay()
    const disk = failStore()
    const realWrite = fileOps.atomicWrite
    let written = false
    vi.spyOn(fileOps, 'atomicWrite').mockImplementation(async (target, content) => {
      await realWrite(target, content)
      if (written || target !== dayFile(vaultA)) return
      written = true
      // The process ends before the pass records the file.
      throw new Error('crash after the file write')
    })
    type(id, ' More.')
    await vi.waitFor(
      async () => {
        await tick()
        expect(written).toBe(true)
      },
      { timeout: 10_000, interval: 10 }
    )
    disk.recover()
    type(id, ' Two.')
    await Promise.all(store.queues)
    await restart()

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
    type(id, ' Again.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Two. Again.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Two. Again.')
  })

  it("an open inside the note's write-back turn never waits for a close waiting on that turn", async () => {
    const id = await checkedDay()
    const gate = hold()
    const writer = takeWritebackTurn(id, async () => {
      await gate.wait()
      return getCrdtProvider().open(id, undefined, { skipSeed: true })
    })
    await gate.reached
    const closed = getCrdtProvider().close(id)
    gate.release()

    await settle(Promise.all([writer, closed]))

    expect.soft(bodyText(await writer)).toBe('From A. Typed.')
    expect(warnings.map(({ message }) => message)).not.toContain(
      'An open stopped waiting for a close stalled on its store'
    )
  })

  // VERIFY-5703R4 (2): a store of a later doc says nothing about a closed one.
  it("a closed doc's stored waiter stays unanswered after the reopened doc's store lands", async () => {
    const id = await checkedDay()
    const disk = failStore()
    type(id, ' More.')
    await Promise.all(store.queues)
    const closedDoc = getCrdtProvider().getDoc(id) as Y.Doc
    await settle(getCrdtProvider().close(id))
    disk.recover()
    await settle(getCrdtProvider().open(id, EDITOR_WINDOW))

    let answered = false
    void getCrdtProvider()
      .whenStored(id, closedDoc)
      .then(() => (answered = true))
    type(id, ' Two.')
    await settle(flushPendingWritebacks())
    await Promise.all(store.queues)
    await new Promise((resolve) => setImmediate(resolve))

    expect(answered).toBe(false)
  })

  it("a close whose whole-doc store lands answers the doc's own stored waiters", async () => {
    const id = await checkedDay()
    const disk = await typeIntoFailedStore(id, dayFile(vaultA))
    disk.recover()

    await settle(getCrdtProvider().close(id))

    expect.soft(storedBody(id)).toBe('From A. Typed. More.')
    expect(getNoteCacheById(vaultA.indexDb.db, id)?.pendingWriteHash).toBeNull()
  })

  it('clears the unstored mark once the store holds the file again', async () => {
    const id = await storeFailsThenRecovers()

    expect(getNoteCacheById(vaultA.indexDb.db, id)).toMatchObject({
      contentHash: generateContentHash(fs.readFileSync(dayFile(vaultA), 'utf8')),
      pendingWriteHash: null
    })
  })

  it('keeps every stored edit live when the unstored mark outlived a recovery', async () => {
    const id = await openTypedDay()
    await flushPendingWritebacks()
    indexDay(vaultA, id)
    const disk = await typeIntoFailedStore(id, dayFile(vaultA))
    const mark = getNoteCacheById(vaultA.indexDb.db, id)?.pendingWriteHash
    disk.recover()
    type(id, ' Two.')
    await Promise.all(store.queues)
    await new Promise((resolve) => setImmediate(resolve))
    expect.soft(getNoteCacheById(vaultA.indexDb.db, id)?.pendingWriteHash).toBeNull()
    // The session ended before the mark was cleared.
    updateNoteCache(vaultA.indexDb.db, id, { pendingWriteHash: mark })
    const versionsBefore = getNoteSnapshots(vaultA.indexDb.db, id)

    await restart()
    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Two.')
    // Nothing was taken in, so the open kept no version of the doc.
    expect.soft(getNoteSnapshots(vaultA.indexDb.db, id)).toEqual(versionsBefore)
    expect(getNoteCacheById(vaultA.indexDb.db, id)?.pendingWriteHash).toBeNull()
  })

  it('takes in a file written under a mark this build cannot read, keeping the doc as a version', async () => {
    const id = await storeFailsThenRecovers()
    updateNoteCache(vaultA.indexDb.db, id, { pendingWriteHash: UNSTORED_FILE })

    await restart()
    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))

    expect.soft(bodyText(doc)).toBe('From A. Typed. More.')
    expect(
      getNoteSnapshots(vaultA.indexDb.db, id).map((version) => version.fileContent)
    ).toContainEqual(expect.stringContaining('From A. Typed. More. Two.'))
  })

  /** Fails the next write of `file` before it writes; resolves once it failed. */
  function failNextWrite(file: string): Promise<void> {
    const realWrite = fileOps.atomicWrite
    let failed!: () => void
    const reached = new Promise<void>((resolve) => (failed = resolve))
    let failNext = true
    vi.spyOn(fileOps, 'atomicWrite').mockImplementation(async (target, content) => {
      if (failNext && target === file) {
        failNext = false
        failed()
        throw new Error('disk full')
      }
      return realWrite(target, content)
    })
    return reached
  }

  /**
   * Types " More." while the store holds the keystroke in flight and the
   * day's write fails before it writes, then lets the store land it.
   */
  async function failWriteBehindStoreInFlight(id: string): Promise<void> {
    const storing = holdNextStoreUpdate()
    const failed = failNextWrite(dayFile(vaultA))
    type(id, ' More.')
    await storing.reached
    await settle(failed)
    storing.release()
    await Promise.all(store.queues)
    expect.soft(storedBody(id)).toBe('From A. Typed. More.')
  }

  // VERIFY-5703R5 PROBE-C1: the write never reached the file, and the store holds the edit.
  it('a write that failed behind a store in flight keeps the stored edit through a restart (PROBE-C1)', async () => {
    const id = await checkedDay()
    await failWriteBehindStoreInFlight(id)
    await restart()

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
    type(id, ' Again.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Again.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Again.')
  })

  // VERIFY-5703R5 PROBE-C1b: the same, through a close and a reopen in one session.
  it('a write that failed behind a store in flight keeps the stored edit through a reopen (PROBE-C1b)', async () => {
    const id = await checkedDay()
    await failWriteBehindStoreInFlight(id)
    await settle(getCrdtProvider().close(id))

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
    type(id, ' Again.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Again.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Again.')
  })

  /**
   * Ends the process inside the next write of the day, before (C1) or after
   * (C2) it writes: `start` sets the pass off, and `meanwhile` runs while the
   * process is still up. The next session finds the file and the row as they
   * were at that step.
   */
  async function crashAtWrite(
    id: string,
    afterWrite: boolean,
    start: () => void,
    meanwhile: () => Promise<void> = async () => {}
  ): Promise<void> {
    const file = dayFile(vaultA)
    const write = hold()
    const realWrite = fileOps.atomicWrite
    let crashNext = true
    vi.spyOn(fileOps, 'atomicWrite').mockImplementation(async (target, content) => {
      if (!crashNext || target !== file) return realWrite(target, content)
      crashNext = false
      if (afterWrite) await realWrite(target, content)
      await write.wait()
      throw new Error('the process ended')
    })
    start()
    await settle(write.reached)
    const row = getNoteCacheById(vaultA.indexDb.db, id)!
    const raw = fs.readFileSync(file, 'utf8')
    await meanwhile()
    // Nothing after the step runs in a crash: the pass's own handling of the
    // throw is undone before the next session.
    write.release()
    for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve))
    updateNoteCache(vaultA.indexDb.db, id, {
      contentHash: row.contentHash,
      pendingWriteHash: row.pendingWriteHash
    })
    fs.writeFileSync(file, raw)
    await restart()
  }

  // VERIFY-5703R5 (1, 2): a crash at each step of a pass the store missed.
  for (const step of ['C0', 'C1', 'C2'] as const) {
    it(`a crash at ${step} of a pass the store missed keeps every edit`, async () => {
      const id = await checkedDay()
      const disk = failStore()
      const recoverAndType = async (): Promise<void> => {
        disk.recover()
        type(id, ' Two.')
        await Promise.all(store.queues)
      }
      if (step === 'C0') {
        // The process ends before the pass marks the row.
        type(id, ' More.')
        await recoverAndType()
        await restart()
      } else {
        await crashAtWrite(id, step === 'C2', () => type(id, ' More.'), recoverAndType)
      }

      const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
      type(id, ' Again.')
      await settle(flushPendingWritebacks())

      expect.soft(bodyText(doc)).toBe('From A. Typed. More. Two. Again.')
      expect.soft(await settledStoredBody(id)).toBe('From A. Typed. More. Two. Again.')
      expect(dayBody(vaultA)).toContain('From A. Typed. More. Two. Again.')
    })
  }

  /** An edit from another device, as the store took it after the session ended. */
  function storeRemoteEdit(id: string, text: string): void {
    const remote = new Y.Doc()
    for (const update of store.updates.get(id) ?? []) Y.applyUpdate(remote, update)
    const before = Y.encodeStateVector(remote)
    const node = firstText(remote.getXmlFragment(CRDT_FRAGMENT_NAME))
    node.insert(node.length, text)
    store.updates.set(id, [...(store.updates.get(id) ?? []), Y.encodeStateAsUpdate(remote, before)])
  }

  it('a write that never landed leaves a stored edit of another device live', async () => {
    const id = await checkedDay()
    const disk = failStore()
    await crashAtWrite(
      id,
      false,
      () => type(id, ' More.'),
      async () => disk.recover()
    )
    storeRemoteEdit(id, ' Remote.')

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))

    expect.soft(bodyText(doc)).toBe('From A. Typed. Remote.')
    expect(getNoteCacheById(vaultA.indexDb.db, id)?.pendingWriteHash).toBeNull()
  })

  it('a write that never landed over a marked file takes that file in', async () => {
    const id = await checkedDay()
    const disk = await typeIntoFailedStore(id, dayFile(vaultA))
    await crashAtWrite(
      id,
      false,
      () => type(id, ' Two.'),
      async () => disk.recover()
    )

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))

    expect(bodyText(doc)).toBe('From A. Typed. More.')
  })

  // VERIFY-5703R6 (1): the file under `content_hash` was itself written unstored,
  // and the store holds that write and an edit made after it.
  it('a write that never landed over a marked file the store covers keeps the later stored edit', async () => {
    const id = await checkedDay()
    const disk = await typeIntoFailedStore(id, dayFile(vaultA))
    disk.recover()
    const storing = holdNextStoreUpdate()
    type(id, ' Two.')
    await settle(storing.reached)
    let stillFailing!: { recover: () => void }
    await crashAtWrite(
      id,
      false,
      () => {
        stillFailing = failStore()
        type(id, ' Three.')
      },
      async () => {
        storing.release()
        await Promise.all(store.queues)
        stillFailing.recover()
        expect.soft(storedBody(id)).toBe('From A. Typed. More. Two.')
      }
    )

    const doc = await settle(getCrdtProvider().open(id, EDITOR_WINDOW))
    type(id, ' Again.')
    await settle(flushPendingWritebacks())

    expect.soft(bodyText(doc)).toBe('From A. Typed. More. Two. Again.')
    expect(dayBody(vaultA)).toContain('From A. Typed. More. Two. Again.')
  })

  // VERIFY-5703R5 (5): a close stalled on its store holds an open only so long.
  it('an open stops waiting for a close stalled on its store, and says which note', async () => {
    const id = await checkedDay()
    type(id, ' More.')
    const storing = holdNextStoreFlush()
    const closed = getCrdtProvider().close(id)
    await settle(storing.reached)

    const opened = getCrdtProvider().open(id, EDITOR_WINDOW)
    await vi.waitFor(
      async () => {
        await tick()
        expect(warnings).toContainEqual(
          expect.objectContaining({
            message: 'An open stopped waiting for a close stalled on its store',
            context: { noteId: id }
          })
        )
      },
      { timeout: 10_000, interval: 10 }
    )
    storing.release()
    await settle(closed)

    expect(bodyText(await settle(opened))).toBe('From A. Typed. More.')
  })
})
