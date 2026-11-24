/**
 * Crash points of Memry's own body writers, with a real restart (REVIEW-5308,
 * D-DOC-FIRST). Each writer feeds the doc, waits for the store, then writes the
 * file through `writeWithBaseline`. The process stops at one point, restarts
 * with only the index, the CRDT store and the disk, and a remote edit arrives.
 * Whatever the point, the remote edit survives in the doc and the file, the
 * body is not duplicated, and the writer's edit is in both or in neither.
 *
 * - beforeFeed: nothing has landed, so the writer's edit is gone in both.
 *   (At dfe3d4ae7b, which wrote the file first, this is the after-sync point.)
 * - afterFeed: the doc holds the edit, the file does not; the write-back
 *   writes it.
 * - beforeWrite: the pending hash is set, the file write never lands.
 * - afterWrite: the file holds the edit, the pending hash names it.
 * - none: no crash.
 */
import * as Y from 'yjs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type * as PathsModule from '../lib/paths'
import type * as FeedModule from './crdt-external-feed'
import { createTestIndexDb } from '@tests/utils/test-db'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** The next file write lands and then the process stops before it returns. */
  crashAfterWrite: false,
  /** Every file write fails as a busy file does. */
  failWrite: false,
  /** Every store write fails. */
  storeFail: false,
  /** Store writes wait here; closing the store rejects them, as shutdown does. */
  storeGate: null as null | { reject: (e: Error) => void; promise: Promise<void> },
  /** Store reads wait at the gate too: y-leveldb runs every call through one queue. */
  storeGateHoldsReads: false,
  lockedNoteIds: new Set<string>(),
  lockedFolders: new Set<string>(),
  writeAttempts: 0,
  /** The next file write never lands. */
  crashBeforeWrite: false,
  /** The process stops at the next feed, before or after the doc takes it. */
  hangAtFeed: null as 'before' | 'after' | null,
  /** The next file write waits here, after its writer read the file and built its bytes. */
  holdWrite: null as null | { reached: () => void; release: Promise<void> },
  indexDb: null as unknown,
  ipc: new Map<string, (...args: unknown[]) => unknown>(),
  store: new Map<string, Uint8Array[]>(),
  contentHash: (_raw: string): string => ''
}))

// A real, empty folder: the outside-vault check resolves every read against it.
const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-writeback-vault-'))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, run: (...args: unknown[]) => unknown) => h.ipc.set(channel, run)
  },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

vi.mock('./crdt-persistence', async () => {
  const Yjs = await import('yjs')
  return {
    openCrdtPersistence: async () => ({
      getYDoc: async (noteId: string) => {
        if (h.storeGateHoldsReads && h.storeGate) await h.storeGate.promise
        const doc = new Yjs.Doc()
        for (const update of h.store.get(noteId) ?? []) Yjs.applyUpdate(doc, update)
        return doc
      },
      storeUpdate: async (noteId: string, update: Uint8Array) => {
        if (h.storeFail) throw new Error('store write failed')
        if (h.storeGate) await h.storeGate.promise
        h.store.set(noteId, [...(h.store.get(noteId) ?? []), update])
      },
      flushDocument: async () => {},
      clearDocument: async (noteId: string) => {
        h.store.delete(noteId)
      },
      destroy: () => {
        h.storeGate?.reject(new Error('Database is not open'))
      },
      getMeta: async () => undefined,
      setMeta: async () => {}
    })
  }
})
vi.mock('./crdt-store-epoch', () => ({ reconcileCrdtStoreEpoch: async () => {} }))
vi.mock('./crdt-store-path', () => ({
  prepareVaultCrdtStore: async () => ({ storagePath: '/tmp/crdt', vaultUuid: 'vault-1' })
}))
vi.mock('../store', () => ({ recordCrdtPersistenceOutcome: () => 0 }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'vault-1' }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database/client', () => ({
  getDatabase: () => ({}),
  getIndexDatabase: () => h.indexDb,
  isDatabaseInitialized: () => true
}))
vi.mock('../database', () => ({ getDatabase: () => ({}), getIndexDatabase: () => h.indexDb }))
vi.mock('@memry/storage-data', () => ({ getNoteMetadataById: () => undefined }))

vi.mock('../vault/note-snapshots', async () => await import('../vault/notes'))
vi.mock('../vault/notes-versions', async () => await import('../vault/notes'))
vi.mock('../vault/notes-crud', async () => await import('../vault/notes'))
vi.mock('../vault/notes-io', async () => await import('../vault/notes'))
vi.mock('../vault/notes', () => ({
  getVaultRoot: () => VAULT_ROOT,
  toAbsolutePath: (relative: string) => `/vault/${relative}`,
  maybeCreateSignificantSnapshot: () => null,
  emitNoteEvent: vi.fn(),
  createSnapshot: () => ({ id: 'snap' })
}))
vi.mock('../lib/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof PathsModule>()),
  readVaultFile: async (_vault: string, relative: string) =>
    h.files.get(`/vault/${relative}`) ?? null
}))
vi.mock('../vault/file-ops', () => ({
  safeRead: async (absolute: string) => h.files.get(absolute) ?? null,
  atomicWrite: async (absolute: string, content: string) => {
    h.writeAttempts++
    const hold = h.holdWrite
    if (hold) {
      h.holdWrite = null
      hold.reached()
      await hold.release
    }
    // The vault lock's file guard (vault-locks/files).
    const registry = await import('../vault-locks/registry')
    const relative = absolute.replace('/vault/', '')
    if (registry.lockedFolderCovering(relative) !== null && !registry.isLockedWriteAllowed()) {
      throw registry.folderLockedError()
    }
    if (h.failWrite) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    if (h.crashBeforeWrite) {
      h.crashBeforeWrite = false
      throw new Error('crashed before the write')
    }
    h.files.set(absolute, content)
    if (h.crashAfterWrite) {
      h.crashAfterWrite = false
      throw new Error('crashed after the write landed')
    }
  },
  ensureDirectory: vi.fn(),
  deleteFile: vi.fn()
}))
vi.mock('../vault/journal', async () => {
  const fileOps = await import('../vault/file-ops')
  const { parseNote, serializeNote, serializeParsedNote } = await import('../vault/frontmatter')
  const at = (date: string): string => `/vault/Journal/${date}.md`
  const entryOf = (date: string, raw: string) => {
    const { content, frontmatter } = parseNote(raw)
    const { date: _date, tags, ...properties } = frontmatter
    return {
      id: `j${date}`,
      date,
      content,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      aliases: [],
      properties,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    }
  }
  // Tags and properties go into frontmatter only when there are any, so a
  // body-only save writes the body as it did before #5472.
  const compose = async (
    date: string,
    content: string,
    tags: string[] = [],
    _existing?: unknown,
    properties: Record<string, unknown> = {}
  ) => {
    const frontmatter = { ...(tags.length > 0 ? { tags } : {}), ...properties }
    const previousFile = h.files.get(at(date)) ?? null
    const previous = previousFile === null ? null : parseNote(previousFile)
    // Like `editJournalFile`: an unchanged body keeps its bytes.
    const fileContent =
      previous && previous.content.trim() === content.trim()
        ? serializeParsedNote({ ...previous, frontmatter }, previous.content, {
            frontmatterEdited: true
          })
        : Object.keys(frontmatter).length > 0
          ? serializeNote(frontmatter, content)
          : content
    return {
      entry: entryOf(date, fileContent),
      fileContent,
      frontmatter: { date, ...frontmatter },
      previousFile,
      write: () => fileOps.atomicWrite(at(date), fileContent)
    }
  }
  return {
    getJournalPath: at,
    getJournalRelativePath: (date: string) => `Journal/${date}.md`,
    readJournalEntry: async (date: string) => {
      const raw = h.files.get(at(date))
      return raw === undefined ? null : entryOf(date, raw)
    },
    readJournalFile: async (date: string) => (h.files.has(at(date)) ? { frontmatter: {} } : null),
    composeJournalEntryWrite: compose,
    // The save before D-DOC-FIRST, so this file runs against dfe3d4ae7b too.
    writeJournalEntryWithContent: async (...args: Parameters<typeof compose>) => {
      const { write, ...result } = await compose(...args)
      await write()
      return result
    },
    writeJournalEntry: async (date: string, content: string) => {
      const { write, entry } = await compose(date, content)
      await write()
      return entry
    },
    serializeJournalEntry: () => ''
  }
})
vi.mock('@memry/domain-notes', () => ({ getCanonicalJournalByDate: () => undefined }))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../vault/note-sync', async () => {
  const q = await import('@main/database/queries/notes')
  return {
    syncNoteToCache: (
      db: never,
      input: { id: string; fileContent: string; contentHash?: string }
    ) => {
      if (q.getNoteCacheById(db, input.id)) {
        q.updateNoteCache(db, input.id, {
          contentHash: input.contentHash ?? h.contentHash(input.fileContent)
        })
      }
      return { wordCount: 0, tags: [], headerTags: [] }
    },
    deleteNoteFromCache: vi.fn(),
    refusesCaseTwinFile: () => false
  }
})
vi.mock('./crdt-external-feed', async (importOriginal) => {
  const actual = await importOriginal<typeof FeedModule>()
  return {
    ...actual,
    feedExternalEditToCrdt: async (...args: Parameters<typeof actual.feedExternalEditToCrdt>) => {
      const at = h.hangAtFeed
      if (at === 'before') return stop()
      const fed = await actual.feedExternalEditToCrdt(...args)
      if (at === 'after') return stop()
      return fed
    }
  }
})
/** The process dies here: the writer never continues. */
function stop(): Promise<never> {
  h.hangAtFeed = null
  return new Promise<never>(() => {})
}
vi.mock('../vault-locks/store', () => ({
  listLockedRows: () => [
    ...[...h.lockedNoteIds].map((target) => ({ targetKind: 'note', target })),
    ...[...h.lockedFolders].map((target) => ({ targetKind: 'folder', target }))
  ]
}))
vi.mock('../vault/attachment-rename-reconcile', () => ({ reconcileRenamedAttachments: vi.fn() }))
vi.mock('../projections', () => ({ flushProjectionEvents: async () => {} }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
vi.mock('@memry/app-core/reminders', () => ({ createRemindersService: vi.fn() }))
vi.mock('../settings/editor-settings', () => ({
  getEditorSettings: () => ({ convertAgentChecklistsToTasks: false })
}))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import { getCrdtProvider, resetCrdtProvider } from './crdt-provider'
import {
  flushPendingWritebacks,
  hasPendingWriteback,
  resetWritebackState,
  writebackNow
} from './crdt-writeback'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'
import { generateContentHash } from '../vault/frontmatter'
import { appendBlocksToNote } from '../vault/append-blocks'
import { feedExternalEditToCrdt } from './crdt-external-feed'
import { landBodyEdit } from './writeback-baseline'
import { atomicWrite } from '../vault/file-ops'
import { landSourceRewrite } from '../vault/rename-link-rewrite'
import { updateJournalEntry } from '../journal/update-entry'
import { createJournalHandles } from '../agent/mcp/tools/journal-handles'
import { registerJournalHandlers } from '../ipc/journal-handlers'
import { registerPropertiesHandlers } from '../ipc/properties-handlers'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import { PropertiesChannels } from '@memry/contracts/properties-api'
import type { UpdateEntryInput } from '@memry/contracts/journal-api'
import { installVaultLockSource, invalidateVaultLocks } from '../vault-locks/registry'
import {
  deleteNoteCache,
  getNoteCacheById,
  insertNoteCache,
  updateNoteCache
} from '@main/database/queries/notes'
import type { NewNoteCache, NoteCache } from '@memry/db-schema/schema/notes-cache'

beforeAll(() => {
  h.indexDb = createTestIndexDb().db
  h.contentHash = generateContentHash
  installVaultLockSource({
    dataDb: () => ({}) as never,
    notePathOf: (id: string) => getNoteCacheById(h.indexDb as never, id)?.path ?? null,
    noteIdAtPath: () => null
  })
})

type Step = 'beforeFeed' | 'afterFeed' | 'beforeWrite' | 'afterWrite' | 'none'
const STEPS: Step[] = ['beforeFeed', 'afterFeed', 'beforeWrite', 'afterWrite', 'none']

function arm(step: Step): void {
  h.hangAtFeed = step === 'beforeFeed' ? 'before' : step === 'afterFeed' ? 'after' : null
  h.crashBeforeWrite = step === 'beforeWrite'
  h.crashAfterWrite = step === 'afterWrite'
}
function disarm(): void {
  h.failWrite = false
  h.storeFail = false
  h.storeGate = null
  h.storeGateHoldsReads = false
  h.lockedNoteIds.clear()
  h.lockedFolders.clear()
  h.writeAttempts = 0
  invalidateVaultLocks()
  h.hangAtFeed = null
  h.crashBeforeWrite = false
  h.crashAfterWrite = false
}
/** Runs a writer until it returns, throws, or stops at a crash point. */
async function runUntilCrash(writer: () => Promise<unknown>): Promise<void> {
  await Promise.race([writer().catch(() => {}), new Promise((r) => setTimeout(r, 300))])
}
/**
 * The armed crash point was reached, so the run stopped where its name says.
 * A crash before the feed has changed nothing on disk: the file never holds
 * an edit the doc lacks.
 */
function expectCrashReached(step: Step, file: string, edit: string): void {
  expect([h.hangAtFeed, h.crashBeforeWrite, h.crashAfterWrite]).toEqual([null, false, false])
  const onDisk = h.files.get(file) ?? ''
  expect({ step, editOnDisk: onDisk.includes(edit) }).not.toEqual({
    step: 'beforeFeed',
    editOnDisk: true
  })
}
/** The writer's edit is in the doc and the file, or, crashed before the feed, in neither. */
function expectLanded(step: Step, md: string, onDisk: string, edit: string): void {
  const landed = step !== 'beforeFeed'
  expect.soft({ inDoc: md.includes(edit), onDisk: onDisk.includes(edit) }).toEqual({
    inDoc: landed,
    onDisk: landed
  })
}

function findText(fragment: Y.XmlFragment, needle: string): Y.XmlText {
  const stack: Array<Y.XmlElement | Y.XmlFragment | Y.XmlText> = [fragment]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node instanceof Y.XmlText) {
      if (node.toString().includes(needle)) return node
      continue
    }
    stack.push(...(node.toArray() as Array<Y.XmlElement | Y.XmlText>))
  }
  throw new Error(`no text holding ${needle}`)
}
function editOf(doc: Y.Doc, find: string, insert: string): Uint8Array {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  const seen = Y.encodeStateVector(copy)
  const text = findText(copy.getXmlFragment(CRDT_FRAGMENT_NAME), find)
  text.insert(text.length, insert)
  return Y.encodeStateAsUpdate(copy, seen)
}
function rowFor(id: string, notePath: string, indexedRaw: string): NewNoteCache {
  return {
    id,
    path: notePath,
    title: path.basename(notePath, '.md'),
    fileType: 'markdown',
    localOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    contentHash: generateContentHash(indexedRaw),
    pendingWriteHash: null
  }
}
async function settle(noteId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  await vi.waitFor(() => expect(hasPendingWriteback(noteId)).toBe(false), { timeout: 5000 })
}
/** The process dies: no in-memory doc, no write-back timers. Index, store and disk survive. */
async function restart(id: string): Promise<Y.Doc> {
  await new Promise((resolve) => setTimeout(resolve, 20))
  disarm()
  resetWritebackState()
  resetCrdtProvider()
  const provider = getCrdtProvider()
  await provider.initPersistence()
  return provider.open(id, 1)
}
async function seedNote(id: string, notePath: string, body: string): Promise<string> {
  const author = new Y.Doc()
  await markdownToYFragment(body, author.getXmlFragment(CRDT_FRAGMENT_NAME), notePath)
  const indexed = (await yDocToMarkdown(author, CRDT_FRAGMENT_NAME, { notePath }))!
  h.store.set(id, [Y.encodeStateAsUpdate(author)])
  insertNoteCache(h.indexDb as never, rowFor(id, notePath, indexed))
  h.files.set(`/vault/${notePath}`, indexed)
  const provider = getCrdtProvider()
  await provider.initPersistence()
  await provider.open(id, 1)
  return indexed
}
const count = (s: string, needle: string): number => s.split(needle).length - 1

describe("Memry's own body writers stopped at each crash point, then restarted (D-DOC-FIRST)", () => {
  for (const step of STEPS) {
    it(`append-blocks: crash ${step}, restart, remote edit`, async () => {
      const id = `append-${step}`
      const notePath = `Append/${step}.md`
      await seedNote(id, notePath, '# Inbox\n\nFirst line.')
      insertNoteCache(h.indexDb as never, rowFor(`src-${step}`, `Append/src-${step}.md`, ''))
      arm(step)
      await runUntilCrash(() =>
        appendBlocksToNote({ sourceNoteId: `src-${step}`, targetNoteId: id, markdown: 'Moved.' })
      )
      expectCrashReached(step, `/vault/${notePath}`, 'Moved.')
      const doc = await restart(id)
      getCrdtProvider().applyRemoteUpdate(id, editOf(doc, 'First line.', ' Remote.'))
      await settle(id)
      await settle(id)
      const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
      const onDisk = h.files.get(`/vault/${notePath}`)!
      expect.soft(md).toContain('Remote.')
      expect.soft(onDisk).toContain('Remote.')
      expect.soft(count(md, 'First line')).toBe(1)
      expectLanded(step, md, onDisk, 'Moved.')
    })
  }

  for (const step of STEPS) {
    it(`landSourceRewrite: crash ${step}, restart, remote edit`, async () => {
      const id = `link-${step}`
      const notePath = `Links/${step}.md`
      await seedNote(id, notePath, '# Source\n\nSee [[Old Title]] here.')
      const cached = getNoteCacheById(h.indexDb as never, id) as NoteCache
      arm(step)
      await runUntilCrash(() =>
        landSourceRewrite(h.indexDb as never, cached, {
          path: notePath,
          title: cached.title,
          rewrite: (raw) => raw.replace('[[Old Title]]', '[[New Title]]')
        })
      )
      expectCrashReached(step, `/vault/${notePath}`, 'New Title')
      const doc = await restart(id)
      getCrdtProvider().applyRemoteUpdate(id, editOf(doc, 'here.', ' Remote.'))
      await settle(id)
      await settle(id)
      const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
      const onDisk = h.files.get(`/vault/${notePath}`)!
      expect.soft(md).toContain('Remote.')
      expect.soft(onDisk).toContain('Remote.')
      expect.soft(count(md, 'See ')).toBe(1)
      expectLanded(step, md, onDisk, 'New Title')
    })
  }

  STEPS.forEach((step, day) => {
    it(`journal save: crash ${step}, restart, remote edit`, async () => {
      const date = `2026-01-1${day}`
      const id = `j${date}`
      const notePath = `Journal/${date}.md`
      await seedNote(id, notePath, 'Morning.')
      arm(step)
      await runUntilCrash(() => updateJournalEntry({ date, content: 'Morning. Saved.' }))
      expectCrashReached(step, `/vault/${notePath}`, 'Saved.')
      const doc = await restart(id)
      getCrdtProvider().applyRemoteUpdate(id, editOf(doc, 'Morning.', ' Remote.'))
      await settle(id)
      await settle(id)
      const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
      const onDisk = h.files.get(`/vault/${notePath}`)!
      expect.soft(md).toContain('Remote.')
      expect.soft(onDisk).toContain('Remote.')
      expect.soft(count(md, 'Morning')).toBe(1)
      expectLanded(step, md, onDisk, 'Saved.')
    })
  })

  // REVIEW-5308 Medium 2: the journal write-back takes the note write-back's
  // outside-edit branch. (An outside edit racing a remote edit of the same doc
  // is not covered: the outside-edit feed replaces the whole fragment,
  // crdt-feed.ts, the documented lossy case.)
  it('feeds an outside journal edit to the doc instead of writing over it', async () => {
    const date = '2026-02-01'
    const id = `j${date}`
    const notePath = `Journal/${date}.md`
    const file = `/vault/${notePath}`
    const indexed = await seedNote(id, notePath, 'Morning.')
    const doc = await restart(id)
    h.files.set(file, indexed.replace('Morning.', 'Morning. Outside.'))
    await writebackNow(id, doc)
    const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
    expect(h.files.get(file)).toContain('Outside.')
    expect(md).toContain('Outside.')
  })

  // REVIEW-5465 finding 1: the agent's journal update lands while a write-back
  // that already read the file waits on its write. Written beside the doc, the
  // write-back put the older body back and the watcher ignored its own write.
  it('an agent journal update between a write-back read and write lands in the doc and the file', async () => {
    const date = '2026-02-02'
    const id = `j${date}`
    const notePath = `Journal/${date}.md`
    const file = `/vault/${notePath}`
    await seedNote(id, notePath, 'Morning.')
    const doc = await restart(id)
    Y.applyUpdate(doc, editOf(doc, 'Morning.', ' Typed.'))
    let release = (): void => {}
    const reached = new Promise<void>((resolve) => {
      h.holdWrite = {
        reached: resolve,
        release: new Promise<void>((r) => {
          release = r
        })
      }
    })
    const writeback = writebackNow(id, doc)
    await reached
    const update = createJournalHandles(h.indexDb as never).update({
      date,
      content_markdown: 'Agent body.'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await Promise.all([writeback, update])
    await settle(id)
    await settle(id)
    const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
    expect.soft(md).toContain('Agent body.')
    expect.soft(h.files.get(file)).toContain('Agent body.')
  })
})

describe('a body writer whose lock check, file write or store fails (D-DOC-FIRST-AMEND)', () => {
  beforeEach(disarm)
  const hashOf = (id: string): string | null | undefined =>
    getNoteCacheById(h.indexDb as never, id)?.contentHash
  const lock = (id: string): void => {
    h.lockedNoteIds.add(id)
    invalidateVaultLocks()
  }
  const outcome = (run: Promise<unknown>): Promise<string> =>
    run.then(
      () => 'resolved',
      () => 'rejected'
    )

  it('append-blocks into a locked note: refused before the doc takes the block', async () => {
    const id = 'locked-append'
    const notePath = 'Locked/append.md'
    const indexed = await seedNote(id, notePath, '# Inbox\n\nFirst line.')
    insertNoteCache(h.indexDb as never, rowFor('src-locked', 'Locked/src.md', ''))
    lock(id)
    const res = await outcome(
      appendBlocksToNote({ sourceNoteId: 'src-locked', targetNoteId: id, markdown: 'Moved.' })
    )
    const doc = getCrdtProvider().getDoc(id)!
    // The renderer keeps the block in the source on a reject.
    expect(res).toBe('rejected')
    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath })).not.toContain('Moved.')
    expect(h.files.get(`/vault/${notePath}`)).toBe(indexed)
  })

  it('journal save of a locked day: refused before the doc takes the edit', async () => {
    const date = '2026-03-05'
    const id = `j${date}`
    const notePath = `Journal/${date}.md`
    await seedNote(id, notePath, 'Morning.')
    lock(id)
    const res = await outcome(updateJournalEntry({ date, content: 'Morning. Saved.' }))
    const doc = getCrdtProvider().getDoc(id)!
    expect(res).toBe('rejected')
    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath })).not.toContain('Saved.')
  })

  // R2-2: the lock check takes the writer's path, not the index row's.
  it('journal save of a day in a locked folder with no index row: refused before the feed', async () => {
    const date = '2026-04-07'
    const id = `j${date}`
    const notePath = `Journal/${date}.md`
    await seedNote(id, notePath, 'Morning.')
    deleteNoteCache(h.indexDb as never, id)
    h.lockedFolders.add('Journal')
    invalidateVaultLocks()
    const res = await outcome(updateJournalEntry({ date, content: 'Morning. Saved.' }))
    const doc = getCrdtProvider().getDoc(id)!
    expect(res).toBe('rejected')
    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath })).not.toContain('Saved.')
    expect(h.files.get(`/vault/${notePath}`)).not.toContain('Saved.')
  })

  // R2-10: updateNote's shape. The feed carries the body only; the file also
  // carries new frontmatter, which a write-back from the doc would drop.
  it('a full-body writer whose file write fails after the feed rejects, with the file untouched', async () => {
    const id = 'full-body'
    const notePath = 'Full/note.md'
    const indexed = await seedNote(id, notePath, 'Body one.')
    const next = `---\ntags:\n  - urgent\nstatus: done\n---\n${indexed.replace('Body one.', 'Body two.')}`
    h.failWrite = true
    const res = await outcome(
      landBodyEdit(h.indexDb as never, id, next, {
        notePath,
        feed: () => feedExternalEditToCrdt(id, 'Body two.'),
        write: () => atomicWrite(`/vault/${notePath}`, next)
      })
    )
    h.failWrite = false
    expect(res).toBe('rejected')
    expect(h.files.get(`/vault/${notePath}`)).toBe(indexed)
    expect(hashOf(id)).toBe(generateContentHash(indexed))
    // The write-back brings the file up to the doc's body after the visible
    // error; only the caller's retry lands the frontmatter (accepted, R3-2).
    await settle(id)
    expect(h.files.get(`/vault/${notePath}`)).toContain('Body two.')
    expect(h.files.get(`/vault/${notePath}`)).not.toContain('urgent')
  })

  // R3-1: a caller that swallows the error (rename link rewrite, task-line
  // removal) still gets a file that converges on the doc.
  it('a link rewrite on a closed doc whose file write fails once rejects, and the write-back fixes the file', async () => {
    const id = 'closed-rewrite'
    const notePath = 'Src/a.md'
    await seedNote(id, notePath, '# Inbox\n\nFirst line.')
    await getCrdtProvider().close(id, 1)
    const cached = getNoteCacheById(h.indexDb as never, id) as NoteCache
    h.failWrite = true
    const res = await outcome(
      landSourceRewrite(h.indexDb as never, cached, {
        path: notePath,
        title: cached.title,
        rewrite: (raw) => raw.replace('First line.', 'First line fixed.')
      })
    )
    h.failWrite = false
    expect(res).toBe('rejected')
    await vi.waitFor(() => expect(h.files.get(`/vault/${notePath}`)).toContain('fixed'), {
      timeout: 5000
    })
    expect(count(h.files.get(`/vault/${notePath}`)!, 'First line')).toBe(1)
    expect(h.writeAttempts).toBe(2)
  })

  it('append-blocks whose file write fails after the feed resolves, and the write-back writes the file', async () => {
    const id = 'ebusy'
    const notePath = 'Busy/ebusy.md'
    const indexed = await seedNote(id, notePath, '# Inbox\n\nFirst line.')
    insertNoteCache(h.indexDb as never, rowFor('src-busy', 'Busy/src.md', ''))
    h.failWrite = true
    const res = await outcome(
      appendBlocksToNote({ sourceNoteId: 'src-busy', targetNoteId: id, markdown: 'Moved.' })
    )
    h.failWrite = false
    const doc = getCrdtProvider().getDoc(id)!
    // Resolved, so the source drops the block: the doc holds the only copy.
    expect(res).toBe('resolved')
    expect(h.files.get(`/vault/${notePath}`)).toBe(indexed)
    expect(hashOf(id)).toBe(generateContentHash(indexed))
    await settle(id)
    const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
    expect(count(md, 'Moved.')).toBe(1)
    expect(count(h.files.get(`/vault/${notePath}`)!, 'Moved.')).toBe(1)
  })

  it('a store failure fails the writer with no file written; the doc state reaches the store with the next update', async () => {
    const id = 'store-fail'
    const notePath = 'Store/fail.md'
    const indexed = await seedNote(id, notePath, '# Inbox\n\nFirst line.')
    insertNoteCache(h.indexDb as never, rowFor('src-sf', 'Store/src.md', ''))
    h.storeFail = true
    const res = await outcome(
      appendBlocksToNote({ sourceNoteId: 'src-sf', targetNoteId: id, markdown: 'Moved.' })
    )
    h.storeFail = false
    // Rejected, so the source keeps the block; a second copy beats a loss.
    expect(res).toBe('rejected')
    expect(h.files.get(`/vault/${notePath}`)).toBe(indexed)
    expect(hashOf(id)).toBe(generateContentHash(indexed))
    const live = getCrdtProvider().getDoc(id)!
    getCrdtProvider().applyRemoteUpdate(id, editOf(live, 'First line.', ' Remote.'))
    await settle(id)
    const doc = await restart(id)
    const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
    const onDisk = h.files.get(`/vault/${notePath}`)!
    expect.soft(md).toContain('Remote.')
    expect.soft(onDisk).toContain('Remote.')
    expect.soft(count(md, 'Moved.')).toBe(1)
    expect.soft(count(onDisk, 'Moved.')).toBe(1)
  })

  it('after a store failure, whenPersisted resolves only once the store holds the whole doc', async () => {
    const id = 'store-owed'
    const notePath = 'Store/owed.md'
    await seedNote(id, notePath, '# Inbox\n\nFirst line.')
    h.storeFail = true
    await expect(feedExternalEditToCrdt(id, '# Inbox\n\nFirst line.\n\nMoved.')).rejects.toThrow(
      'store write failed'
    )
    await expect(getCrdtProvider().whenPersisted(id)).rejects.toThrow('store write failed')
    h.storeFail = false
    // An outside-edit ingest moves the baseline once this resolves.
    await getCrdtProvider().whenPersisted(id)
    const doc = await restart(id)
    expect(await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath })).toContain('Moved.')
  })

  it('shutdown during a feed: the writer settles, and a restart keeps the remote edit once', async () => {
    const id = 'shutdown'
    const notePath = 'Store/shutdown.md'
    const indexed = await seedNote(id, notePath, '# Inbox\n\nFirst line.')
    insertNoteCache(h.indexDb as never, rowFor('src-sd', 'Store/src-sd.md', ''))
    let reject!: (e: Error) => void
    const promise = new Promise<void>((_, r) => (reject = r))
    promise.catch(() => {})
    h.storeGate = { reject, promise }
    const run = outcome(
      appendBlocksToNote({ sourceNoteId: 'src-sd', targetNoteId: id, markdown: 'Moved.' })
    )
    // The doc took the block; its store write waits at the gate.
    const live = getCrdtProvider().getDoc(id)!
    await vi.waitFor(async () =>
      expect(await yDocToMarkdown(live, CRDT_FRAGMENT_NAME, { notePath })).toContain('Moved.')
    )
    await getCrdtProvider().destroy()
    expect(await run).toBe('rejected')
    expect(h.files.get(`/vault/${notePath}`)).toBe(indexed)
    const doc = await restart(id)
    getCrdtProvider().applyRemoteUpdate(id, editOf(doc, 'First line.', ' Remote.'))
    await settle(id)
    const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
    const onDisk = h.files.get(`/vault/${notePath}`)!
    expect.soft(md).toContain('Remote.')
    expect.soft(onDisk).toContain('Remote.')
    expect.soft(count(md, 'First line')).toBe(1)
    expect.soft(md).not.toContain('Moved.')
  })
})

// A tags or properties update writes only frontmatter and never moves the doc,
// so the write-back's re-arm cannot see it. It waits for the running pass
// instead of landing between its read and its write (#5472).
describe('a tags or properties update between a journal write-back read and write (#5472)', () => {
  beforeAll(() => {
    registerJournalHandlers()
    registerPropertiesHandlers()
  })
  beforeEach(disarm)
  const viaIpc = (input: UpdateEntryInput): unknown =>
    h.ipc.get(JournalChannels.invoke.UPDATE_ENTRY)!({}, input)
  // The journal page's properties panel saves through properties:set and properties:merge.
  const setProperties = async (date: string, properties: Record<string, unknown>): Promise<void> =>
    expect(
      await h.ipc.get(PropertiesChannels.invoke.SET)!({}, { entityId: `j${date}`, properties })
    ).toMatchObject({ success: true })
  const mergeProperties = async (date: string, values: Record<string, unknown>): Promise<void> =>
    expect(
      await h.ipc.get(PropertiesChannels.invoke.MERGE)!({}, { entityId: `j${date}`, values })
    ).toMatchObject({ success: true })
  const agent = (): ReturnType<typeof createJournalHandles> =>
    createJournalHandles(h.indexDb as never)
  // The last case has no day file: the pass writes it (as a pulled record's
  // `materialize` does), and the save creates the entry only after that pass.
  const cases: Array<[string, (date: string) => unknown, string[], boolean?]> = [
    ['IPC journal tags save', (date) => viaIpc({ date, tags: ['focus'] }), ['focus']],
    [
      'IPC properties:set on the entry',
      (date) => setProperties(date, { mood: 'calm' }),
      ['mood: calm']
    ],
    // Each merge reads the file in the entry's turn, so the second keeps the
    // first's key instead of the record both read before the pass wrote.
    [
      'two IPC properties:merge calls',
      (date) =>
        Promise.all([
          mergeProperties(date, { mood: 'calm' }),
          mergeProperties(date, { energy: 'high' })
        ]),
      ['mood: calm', 'energy: high']
    ],
    ['agent journal.update tags', (date) => agent().update({ date, tags: ['focus'] }), ['focus']],
    [
      'agent journal.update properties',
      (date) => agent().update({ date, properties: { mood: 'calm' } }),
      ['mood: calm']
    ],
    [
      'IPC journal tags save of a day with no file',
      (date) => viaIpc({ date, tags: ['focus'] }),
      ['focus'],
      true
    ]
  ]
  cases.forEach(([name, apply, kept, noFile], i) => {
    it(`${name}: the file keeps it and the typed body`, async () => {
      const date = `2026-05-1${i}`
      const id = `j${date}`
      const notePath = `Journal/${date}.md`
      await seedNote(id, notePath, 'Morning.')
      updateNoteCache(h.indexDb as never, id, { date })
      const doc = await restart(id)
      if (noFile) h.files.delete(`/vault/${notePath}`)
      Y.applyUpdate(doc, editOf(doc, 'Morning.', ' Typed.'))
      let release = (): void => {}
      const reached = new Promise<void>((resolve) => {
        h.holdWrite = {
          reached: resolve,
          release: new Promise<void>((r) => {
            release = r
          })
        }
      })
      const writeback = writebackNow(id, doc)
      await reached
      const update = Promise.resolve(apply(date))
      await new Promise((resolve) => setTimeout(resolve, 50))
      release()
      await Promise.all([writeback, update])
      await settle(id)
      const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
      expect.soft(md).toContain('Morning. Typed.')
      for (const line of kept) expect.soft(h.files.get(`/vault/${notePath}`)).toContain(line)
      expect.soft(h.files.get(`/vault/${notePath}`)).toContain('Morning. Typed.')
    })
  })

  // A tags save that creates the day seeds its doc, which reads the CRDT
  // store. A quit flush awaits every turn, so that wait comes after the
  // turn, as a body update's feed does (#5475).
  it('IPC journal tags save that creates the day: a quit flush settles while the store is stuck', async () => {
    const date = '2026-05-20'
    const notePath = `Journal/${date}.md`
    resetWritebackState()
    resetCrdtProvider()
    await getCrdtProvider().initPersistence()
    let reject!: (e: Error) => void
    const promise = new Promise<void>((_, r) => (reject = r))
    promise.catch(() => {})
    h.storeGate = { reject, promise }
    h.storeGateHoldsReads = true
    const update = Promise.resolve(viaIpc({ date, tags: ['focus'] })).then(
      () => 'resolved',
      () => 'rejected'
    )
    await vi.waitFor(() => expect(h.files.get(`/vault/${notePath}`)).toContain('focus'))
    await flushPendingWritebacks()
    await getCrdtProvider().destroy()
    expect(await update).toBe('resolved')
  })
})

// A body update that also sets tags writes its frontmatter beside the body.
// The re-arm after a pass restores the body, not the frontmatter the pass put
// back, so the update writes its frontmatter again in the entry's turn (#5479).
describe('a body update with tags beside a journal write-back (#5479)', () => {
  beforeAll(registerJournalHandlers)
  beforeEach(disarm)
  const viaIpc = (input: UpdateEntryInput): unknown =>
    h.ipc.get(JournalChannels.invoke.UPDATE_ENTRY)!({}, input)
  const agent = (): ReturnType<typeof createJournalHandles> =>
    createJournalHandles(h.indexDb as never)
  const writers: Array<[string, (date: string) => unknown]> = [
    [
      'IPC journal:updateEntry content+tags',
      (date) => viaIpc({ date, content: 'Morning. Typed. Agent.', tags: ['focus'] })
    ],
    [
      'agent journal.update content+tags',
      (date) =>
        agent().update({ date, content_markdown: 'Morning. Typed. Agent.', tags: ['focus'] })
    ]
  ]
  const orders = ['pass held at its write', 'update held at its write'] as const
  writers.forEach(([name, apply], i) => {
    orders.forEach((order, j) => {
      it(`${name}, ${order}: the file keeps the tag and the body`, async () => {
        const date = `2026-06-${i}${j + 1}`
        const id = `j${date}`
        const notePath = `Journal/${date}.md`
        await seedNote(id, notePath, 'Morning.')
        const doc = await restart(id)
        Y.applyUpdate(doc, editOf(doc, 'Morning.', ' Typed.'))
        let release = (): void => {}
        const reached = new Promise<void>((resolve) => {
          h.holdWrite = {
            reached: resolve,
            release: new Promise<void>((r) => {
              release = r
            })
          }
        })
        const first = order === orders[0] ? writebackNow(id, doc) : Promise.resolve(apply(date))
        await reached
        const second = order === orders[0] ? Promise.resolve(apply(date)) : writebackNow(id, doc)
        await new Promise((resolve) => setTimeout(resolve, 50))
        release()
        await Promise.all([first, second])
        await settle(id)
        const md = (await yDocToMarkdown(doc, CRDT_FRAGMENT_NAME, { notePath }))!
        expect.soft(md).toContain('Morning. Typed. Agent.')
        expect.soft(h.files.get(`/vault/${notePath}`)).toContain('focus')
        expect.soft(h.files.get(`/vault/${notePath}`)).toContain('Morning. Typed. Agent.')
      })
    })
  })

  // The body update's frontmatter turn writes the tags it added, not its whole
  // list, so a tags save queued ahead of it is kept (REVIEW-5482).
  it('agent content+tags racing an IPC tags save keeps both tags', async () => {
    const date = '2026-06-29'
    const id = `j${date}`
    const notePath = `Journal/${date}.md`
    await seedNote(id, notePath, 'Morning.')
    const doc = await restart(id)
    Y.applyUpdate(doc, editOf(doc, 'Morning.', ' Typed.'))
    let release = (): void => {}
    const reached = new Promise<void>((resolve) => {
      h.holdWrite = {
        reached: resolve,
        release: new Promise<void>((r) => {
          release = r
        })
      }
    })
    const writeback = writebackNow(id, doc)
    await reached
    const body = agent().update({
      date,
      content_markdown: 'Morning. Typed. Agent.',
      tags: ['focus']
    })
    const tags = viaIpc({ date, tags: ['other'] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    await Promise.all([writeback, body, tags])
    await settle(id)
    expect.soft(h.files.get(`/vault/${notePath}`)).toContain('other')
    expect.soft(h.files.get(`/vault/${notePath}`)).toContain('focus')
    expect.soft(h.files.get(`/vault/${notePath}`)).toContain('Morning. Typed. Agent.')
  })

  // The update's frontmatter turn waits behind the held pass and holds no
  // store wait itself, so a quit flush started meanwhile settles.
  it('a quit flush started while the turn waits behind a pass settles', async () => {
    const date = '2026-06-30'
    const id = `j${date}`
    const notePath = `Journal/${date}.md`
    await seedNote(id, notePath, 'Morning.')
    const doc = await restart(id)
    Y.applyUpdate(doc, editOf(doc, 'Morning.', ' Typed.'))
    let release = (): void => {}
    const reached = new Promise<void>((resolve) => {
      h.holdWrite = {
        reached: resolve,
        release: new Promise<void>((r) => {
          release = r
        })
      }
    })
    const writeback = writebackNow(id, doc)
    await reached
    const update = viaIpc({ date, content: 'Morning. Typed. Agent.', tags: ['focus'] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const flush = flushPendingWritebacks()
    release()
    await Promise.all([writeback, update, flush])
    await settle(id)
    expect.soft(h.files.get(`/vault/${notePath}`)).toContain('focus')
    expect.soft(h.files.get(`/vault/${notePath}`)).toContain('Morning. Typed. Agent.')
  })
})
