/**
 * Readwise incremental sync (#1415), multi-run scenarios through the real run
 * engine (the one `import:start` and the scheduler share), the real note
 * writer, a real temp vault and real databases. Only the network is stubbed:
 * a stateful readwise.io (`tests/utils/readwise-stub`) and the image download.
 * Each test runs the engine more than once, mutating the stub between runs the
 * way Readwise would, because a cursor or a retry list only fails across runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSection } from '@memry/importers/readwise'
import { book, highlight } from '@memry/importers/readwise/fixtures'
import type { ReadwiseBook } from '@memry/importers/readwise'
import * as Y from 'yjs'
import { markSyncIneligible, resetSyncDecision } from '@memry/sync-client/sync-eligibility'
import { ReadwiseStub, type StubBook } from '@tests/utils/readwise-stub'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import type * as RuntimeEffectsModule from '../notes/runtime-effects'
import type * as DomainModule from '../notes/domain'
import type * as ImportedNoteModule from '../import/_shared/imported-note'
import type * as SyncServiceModule from '../readwise/sync-service'
import type * as NotesModule from '../vault/notes'
import type * as SyncStateModule from '../readwise/sync-state'
import type * as LinksRepositoryModule from '../readwise/links-repository'
import type * as SecretsModule from '../readwise/secrets'
import type * as SettingsModule from '../readwise/settings'
import type * as CrdtProviderModule from '../sync/crdt-provider'
import type * as RunnerModule from '../import/runner'
import type * as RegistryModule from '../import/registry'
import type { BookEvent } from '../readwise/sync-service'

const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : String(input)

const mocks = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  imageFetch: vi.fn(),
  recordActivity: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: mocks.imageFetch }
}))
vi.mock('../secrets/secret-storage', () => ({
  setSecret: async (service: string, account: string, value: string) => {
    mocks.secrets.set(`${service}/${account}`, value)
  },
  getSecret: async (service: string, account: string) =>
    mocks.secrets.get(`${service}/${account}`) ?? null,
  deleteSecret: async (service: string, account: string) => {
    mocks.secrets.delete(`${service}/${account}`)
  }
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../notes/runtime-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEffectsModule>()),
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn(),
  emitNoteAttachmentSaved: vi.fn()
}))
vi.mock('../sync/crdt-external-feed', () => ({
  feedExternalEditToCrdt: vi.fn(async () => true)
}))
vi.mock('../notes/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>()
  return { ...actual, updateNoteCommand: vi.fn(actual.updateNoteCommand) }
})
vi.mock('../import/_shared/imported-note', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportedNoteModule>()
  return { ...actual, createImportedNote: vi.fn(actual.createImportedNote) }
})
vi.mock('../vault/activity-log', () => ({ recordActivity: mocks.recordActivity }))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainLog: vi.fn(), trackMainError: vi.fn() }))

const TOKEN = 'rw-test-token'

const stubBook = (id: number, over: Partial<ReadwiseBook> = {}) =>
  ({ ...book(id, over), highlights: over.highlights ?? [] }) as StubBook
const PNG = new Uint8Array([137, 80, 78, 71]).buffer

/** Readwise server times. `t(1)` is the first of October 2026, 10:00 UTC. */
const t = (day: number, hour = 10) =>
  `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`

function hl(id: number, location: number, updatedDay: number, text = `Highlight ${id}`) {
  return highlight(id, {
    text,
    location,
    created_at: t(updatedDay),
    updated_at: t(updatedDay)
  })
}

describe('Readwise incremental sync', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let engine: typeof SyncServiceModule
  let domain: typeof DomainModule
  let notes: typeof NotesModule
  let state: typeof SyncStateModule
  let links: typeof LinksRepositoryModule
  let secrets: typeof SecretsModule
  let settings: typeof SettingsModule
  let imported: typeof ImportedNoteModule
  let crdtProvider: typeof CrdtProviderModule
  let runner: typeof RunnerModule
  let registry: typeof RegistryModule
  let readwise: ReadwiseStub

  const db = () => asClientDb(dataDb.db)
  const writes = () =>
    vi.mocked(domain.updateNoteCommand).mock.calls.length +
    vi.mocked(imported.createImportedNote).mock.calls.length
  const resetWrites = () => {
    vi.mocked(domain.updateNoteCommand).mockClear()
    vi.mocked(imported.createImportedNote).mockClear()
  }

  beforeEach(async () => {
    vault = createTestVault('readwise-sync')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    mocks.secrets.clear()
    // Sync off: no claim, this device pulls (D8). The gate itself is tested in pull-gate.test.ts.
    markSyncIneligible()
    mocks.recordActivity.mockClear()
    mocks.imageFetch.mockReset()
    mocks.imageFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG
    }))
    readwise = new ReadwiseStub()
    vi.stubGlobal('fetch', vi.fn(readwise.handle))

    const vaultIndex = await import('../vault/status')
    const database = await import('../database')
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
      attachmentsFolder: 'attachments',
      journalDateFormat: 'yyyy-MM-dd'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    engine = await import('../readwise/sync-service')
    domain = await import('../notes/domain')
    notes = await import('../vault/notes')
    state = await import('../readwise/sync-state')
    links = await import('../readwise/links-repository')
    secrets = await import('../readwise/secrets')
    settings = await import('../readwise/settings')
    imported = await import('../import/_shared/imported-note')
    crdtProvider = await import('../sync/crdt-provider')
    runner = await import('../import/runner')
    registry = await import('../import/registry')
    const { readwiseImporter } = await import('../import/readwise/readwise-importer')
    registry.__resetRegistry()
    registry.registerImporter(readwiseImporter)
    resetWrites()
    await secrets.setReadwiseToken(vault.path, TOKEN)
  })

  afterEach(async () => {
    resetSyncDecision()
    await stopProjectionRuntime()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  /** One run of the shared engine, as the dialog and the scheduler start it. */
  async function sync(
    over: { signal?: AbortSignal; service?: InstanceType<typeof engine.ReadwiseSyncService> } = {}
  ) {
    const events: BookEvent[] = []
    const result = await (over.service ?? engine.getReadwiseSyncService()).run(TOKEN, {
      signal: over.signal ?? new AbortController().signal,
      book: (event) => events.push(event)
    })
    return { result, events }
  }

  const noteFor = async (bookId: number) =>
    (await notes.getNoteById(links.getLinkByBookId(db(), bookId)!.noteId))!
  const edit = (bookId: number, change: (b: StubBook) => void) => {
    change(readwise.books.find((b) => b.user_book_id === bookId)!)
  }
  const mark = () => readwise.requests.length
  /**
   * The window is inclusive of the newest highlight (cursor = newest minus one
   * second), so it names that highlight's book again every run. Moving the
   * cursor stands in for a later run, to see a window that holds only the edits.
   */
  const cursorAt = (day: number) =>
    state.setCursor(db(), `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`)
  const userEdit = async (bookId: number, change: (body: string) => string) => {
    const note = await noteFor(bookId)
    await notes.updateNote({ id: note.id, content: change(note.content) })
    resetWrites()
  }

  function twoBooks() {
    readwise.books = [
      stubBook(1, {
        title: 'Deep Work',
        readable_title: 'Deep Work',
        highlights: [hl(11, 10, 1), hl(12, 20, 2), hl(13, 30, 3)]
      }),
      stubBook(2, {
        title: 'Atomic Habits',
        readable_title: 'Atomic Habits',
        highlights: [hl(21, 10, 1), hl(22, 20, 2)]
      })
    ]
  }

  it('the first run, with no cursor, reads the whole export and backfills every book', async () => {
    twoBooks()
    const { result } = await sync()

    expect(readwise.requests.every((u) => !u.searchParams.has('updatedAfter'))).toBe(true)
    expect(readwise.requests.every((u) => !u.searchParams.has('ids'))).toBe(true)
    expect(result).toMatchObject({ added: 2, updated: 0, appended: 0, failed: 0, highlights: 5 })
    expect((await noteFor(1)).content).toContain('Highlight 13')
    expect((await noteFor(2)).content).toContain('Highlight 22')
    // Newest highlight updated_at (day 3) minus one second.
    expect(state.getCursor(db())).toBe('2026-10-03T09:59:59.000Z')
  })

  it('keeps the run counts for the status, and shows progress while it runs', async () => {
    twoBooks()
    const progress = await import('../readwise/run-status')
    const seen: Array<ReturnType<typeof progress.getRunProgress>> = []
    const stop = progress.onReadwiseStatusChanged(() => seen.push(progress.getRunProgress()))

    await sync()
    stop()

    expect(state.getLastRun(db())?.counts).toEqual({
      books: 2,
      added: 2,
      updated: 0,
      appended: 0,
      deferred: 0,
      failed: 0,
      highlights: 5
    })
    expect(seen.map((p) => p?.stage)).toEqual(
      expect.arrayContaining(['waiting-for-sync', 'reading', 'writing'])
    )
    expect(seen.find((p) => p?.stage === 'writing')).toMatchObject({ planned: 2 })
    expect(progress.getRunProgress()).toBeNull()
  })

  it('cancel stops a run that is reading, keeps the cursor and shows no error', async () => {
    const service = new engine.ReadwiseSyncService()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal?.addEventListener('abort', () => {
              // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- rejecting with the abort reason or a non-Error value is what this test simulates
              reject(init.signal?.reason)
            })
          )
      )
    )
    const progress = await import('../readwise/run-status')
    const running = service.run(TOKEN, { signal: new AbortController().signal, book: () => {} })
    await vi.waitFor(() => expect(progress.getRunProgress()?.stage).toBe('reading'))

    service.cancel()
    const result = await running

    expect(result.cancelled).toBe(true)
    expect(state.getCursor(db())).toBeNull()
    expect(progress.getRunProgress()).toBeNull()
    expect(progress.getRunFailure()).toBeNull()
  })

  it('a second run on an unchanged library asks for the window and writes nothing', async () => {
    twoBooks()
    await sync()
    resetWrites()
    const before = mark()
    mocks.recordActivity.mockClear()

    const { result } = await sync()

    const sent = readwise.since(before)
    // The window names the newest highlight's book again (inclusive cursor):
    // its note is read, and found identical.
    expect(sent.windowed).toHaveLength(1)
    expect(sent.windowed[0].searchParams.get('updatedAfter')).toBe('2026-10-03T09:59:59.000Z')
    expect(sent.windowed[0].searchParams.get('includeDeleted')).toBe('true')
    expect(result).toMatchObject({ added: 0, updated: 0, appended: 0 })
    expect(writes()).toBe(0)
    expect(mocks.recordActivity).not.toHaveBeenCalled()
  })

  it('one new highlight in a book of 40 keeps the other 39, though the window holds only the new one', async () => {
    readwise.books = [
      stubBook(1, {
        title: 'Big Book',
        readable_title: 'Big Book',
        highlights: Array.from({ length: 40 }, (_, i) => hl(100 + i, (i + 1) * 10, 1))
      })
    ]
    await sync()
    cursorAt(2)
    readwise.books[0].highlights.push(hl(900, 205, 5, 'The newest thought'))
    const before = mark()

    const { result } = await sync()

    const sent = readwise.since(before)
    expect(sent.windowed).toHaveLength(1)
    // Untouched section: the whole book comes with `ids=`.
    expect(sent.ids).toHaveLength(1)
    expect(sent.ids[0].searchParams.get('ids')).toBe('1')
    expect(result).toMatchObject({ added: 0, updated: 1, highlights: 1 })
    const body = (await noteFor(1)).content
    expect(body.match(/- Highlight \d+/g)).toHaveLength(40)
    expect(body).toContain('The newest thought')
    // Location order: 205 sits between 200 and 210.
    expect(body.indexOf('Highlight 119')).toBeLessThan(body.indexOf('The newest thought'))
    expect(body.indexOf('The newest thought')).toBeLessThan(body.indexOf('Highlight 120'))
    expect(readSection(body)).toMatchObject({ found: true, untouched: true })
  })

  it('in an untouched note an edit lands in place, a new one in location order, a deleted one disappears', async () => {
    twoBooks()
    await sync()
    edit(1, (b) => {
      b.highlights[1] = hl(12, 20, 4, 'Edited in Readwise')
      b.highlights[2] = { ...hl(13, 30, 4), is_deleted: true }
      b.highlights.push(hl(14, 15, 4, 'Squeezed in'))
    })

    await sync()

    const body = (await noteFor(1)).content
    expect(body).toContain('Edited in Readwise')
    expect(body).not.toContain('Highlight 13')
    expect(body.indexOf('Highlight 11')).toBeLessThan(body.indexOf('Squeezed in'))
    expect(body.indexOf('Squeezed in')).toBeLessThan(body.indexOf('Edited in Readwise'))
  })

  it('in a touched note only new highlights are appended, with no full fetch', async () => {
    twoBooks()
    await sync()
    await userEdit(1, (body) => body.replace('Highlight 11', 'Highlight 11 (my words)'))
    cursorAt(4)
    edit(1, (b) => {
      b.highlights[1] = hl(12, 20, 4, 'Readwise edit the note must not get')
      b.highlights.push(hl(14, 40, 5, 'A fresh arrival'))
    })
    const before = mark()

    const { result } = await sync()

    expect(readwise.since(before).ids).toHaveLength(0)
    expect(result).toMatchObject({ appended: 1, updated: 0, highlights: 2 })
    const body = (await noteFor(1)).content
    expect(body).toContain('Highlight 11 (my words)')
    expect(body).toContain('A fresh arrival')
    expect(body).not.toContain('Readwise edit the note must not get')
    expect(body.match(/Highlight 12/g)).toHaveLength(1)
  })

  it('a book deleted in Readwise keeps its note and stops syncing', async () => {
    twoBooks()
    await sync()
    const note = await noteFor(2)
    edit(2, (b) => {
      b.is_deleted = true
      b.highlights = b.highlights.map((h) => ({ ...h, is_deleted: true, updated_at: t(6) }))
    })
    resetWrites()

    await sync()

    expect(links.getLinkByBookId(db(), 2)?.state).toBe('source-deleted')
    expect((await noteFor(2)).content).toBe(note.content)
    expect(writes()).toBe(0)

    // It stays quiet when the book is touched again.
    edit(2, (b) => b.highlights.push(hl(23, 30, 8)))
    await sync()
    expect(writes()).toBe(0)
    expect((await noteFor(2)).content).toBe(note.content)
  })

  it('a note deleted in memry stays deleted, and the book is marked', async () => {
    twoBooks()
    await sync()
    await notes.deleteNote((await noteFor(1)).id)
    edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
    resetWrites()

    const { events } = await sync()

    expect(links.getLinkByBookId(db(), 1)?.state).toBe('note-deleted')
    expect(events).toContainEqual({ title: 'Deep Work', result: 'skipped', reason: 'note-deleted' })
    expect(imported.createImportedNote).not.toHaveBeenCalled()

    edit(1, (b) => b.highlights.push(hl(15, 50, 7)))
    await sync()
    expect(imported.createImportedNote).not.toHaveBeenCalled()
    expect(links.getLinkByBookId(db(), 1)?.state).toBe('note-deleted')
  })

  describe('resumability', () => {
    it('a crash while reading the export changes nothing, and the next run covers the same window', async () => {
      twoBooks()
      await sync()
      edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
      edit(2, (b) => b.highlights.push(hl(23, 30, 6)))
      readwise.pageSize = 1
      readwise.failWhen = (url) => (url.searchParams.get('pageCursor') === '1' ? 500 : null)
      const cursor = state.getCursor(db())
      resetWrites()

      await expect(sync()).rejects.toThrow('Readwise answered 500')
      expect(state.getCursor(db())).toBe(cursor)
      expect(writes()).toBe(0)

      readwise.failWhen = null
      const { result } = await sync()
      expect(result).toMatchObject({ updated: 2 })
      expect((await noteFor(1)).content.match(/Highlight 14/g)).toHaveLength(1)
      expect((await noteFor(2)).content.match(/Highlight 23/g)).toHaveLength(1)
    })

    it('a run stopped after the first book re-runs the window without duplicating or skipping', async () => {
      twoBooks()
      await sync()
      edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
      edit(2, (b) => b.highlights.push(hl(23, 30, 6)))
      const cursor = state.getCursor(db())
      const controller = new AbortController()
      // The first book's write is where the process "dies".
      const actual = vi.mocked(domain.updateNoteCommand).getMockImplementation()!
      vi.mocked(domain.updateNoteCommand).mockImplementationOnce(async (input) => {
        const written = await actual(input)
        controller.abort()
        return written
      })

      const first = await sync({ signal: controller.signal })

      expect(first.result.cancelled).toBe(true)
      expect(state.getCursor(db())).toBe(cursor)
      expect((await noteFor(1)).content).toContain('Highlight 14')
      expect((await noteFor(2)).content).not.toContain('Highlight 23')

      const second = await sync()

      expect(second.result.cancelled).toBe(false)
      expect((await noteFor(1)).content.match(/Highlight 14/g)).toHaveLength(1)
      expect((await noteFor(2)).content.match(/Highlight 23/g)).toHaveLength(1)
      expect(state.getCursor(db())).toBe('2026-10-06T09:59:59.000Z')
    })

    it('a failed full fetch puts the books on the retry list and the run still completes', async () => {
      twoBooks()
      await sync()
      edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
      readwise.failWhen = (url) => (url.searchParams.has('ids') ? 500 : null)

      const { result } = await sync()

      expect(result.failed).toBe(1)
      expect(state.getRetryList(db()).map((e) => e.readwiseBookId)).toEqual([1])
      expect(state.getCursor(db())).toBe('2026-10-05T09:59:59.000Z')

      readwise.failWhen = null
      await sync()
      expect((await noteFor(1)).content).toContain('Highlight 14')
      expect(state.getRetryList(db())).toEqual([])
    })
  })

  it('a book that failed is fetched with ids= on the next run, before the window', async () => {
    twoBooks()
    const actual = await vi.importActual<typeof ImportedNoteModule>(
      '../import/_shared/imported-note'
    )
    vi.mocked(imported.createImportedNote).mockImplementation(async (input) => {
      if (input.title === 'Atomic Habits') throw new Error('disk is read-only')
      return actual.createImportedNote(input)
    })
    const first = await sync()
    expect(first.result.failed).toBe(1)
    expect(state.getRetryList(db())).toMatchObject([{ readwiseBookId: 2, attempts: 1 }])

    vi.mocked(imported.createImportedNote).mockImplementation(actual.createImportedNote)
    const before = mark()
    const second = await sync()

    const sent = readwise.since(before).all
    expect(sent[0].searchParams.get('ids')).toBe('2')
    expect(sent[1].searchParams.has('updatedAfter')).toBe(true)
    expect(second.result).toMatchObject({ added: 1, failed: 0 })
    expect(state.getRetryList(db())).toEqual([])
    expect((await noteFor(2)).content).toContain('Highlight 21')
  })

  describe('the retry list', () => {
    it('drops a book Readwise no longer has, instead of asking for it forever', async () => {
      twoBooks()
      await sync()
      state.addRetry(db(), 99, 'gone')
      const before = mark()

      await sync()

      expect(readwise.since(before).ids[0].searchParams.get('ids')).toBe('99')
      expect(state.getRetryList(db())).toEqual([])
    })

    it('keeps the list and finishes the run when the list cannot be fetched', async () => {
      twoBooks()
      await sync()
      state.addRetry(db(), 2, 'disk is read-only')
      readwise.failWhen = (url) => (url.searchParams.has('ids') ? 500 : null)
      edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
      await userEdit(1, (body) => body.replace('Highlight 11', 'Highlight 11 (mine)'))

      const { result } = await sync()

      expect(result).toMatchObject({ appended: 1 })
      expect(state.getRetryList(db()).map((e) => e.readwiseBookId)).toEqual([2])
    })

    it('a rejected token on the full fetch fails the run and asks for attention', async () => {
      twoBooks()
      await sync()
      edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
      readwise.failWhen = (url) => (url.searchParams.has('ids') ? 401 : null)
      const cursor = state.getCursor(db())

      await expect(sync()).rejects.toMatchObject({ code: 'invalid-token' })

      expect(state.getLastRun(db())).toMatchObject({ needsAttention: true })
      expect(state.getCursor(db())).toBe(cursor)
    })
  })

  it('a book whose note is open waits on the retry list and is written after it closes', async () => {
    twoBooks()
    await sync()
    edit(1, (b) => b.highlights.push(hl(14, 40, 5, 'Written after closing')))
    const getDoc = vi.spyOn(crdtProvider.getCrdtProvider(), 'getDoc').mockReturnValue(new Y.Doc())
    resetWrites()

    const { result, events } = await sync()

    expect(result).toMatchObject({ deferred: 1, updated: 0 })
    expect(events).toContainEqual({ title: 'Deep Work', result: 'skipped', reason: 'busy' })
    expect(writes()).toBe(0)
    expect(state.getRetryList(db()).map((e) => e.readwiseBookId)).toEqual([1])

    getDoc.mockReturnValue(undefined)
    const next = await sync()
    expect(next.result).toMatchObject({ updated: 1, deferred: 0 })
    expect((await noteFor(1)).content).toContain('Written after closing')
    expect(state.getRetryList(db())).toEqual([])
  })

  describe('categories (D3, D7)', () => {
    function withSupplemental() {
      twoBooks()
      readwise.books.push(
        stubBook(3, {
          title: 'Getting started',
          readable_title: 'Getting started',
          category: 'supplementals',
          highlights: [hl(31, 10, 1)]
        })
      )
    }

    it('switching a category on reads the whole export once and brings in its books', async () => {
      withSupplemental()
      await sync()
      expect(links.getLinkByBookId(db(), 3)).toBeUndefined()
      expect(state.getFullPassPending(db())).toBe(false)

      settings.writeReadwiseOptions(db(), { categories: { supplementals: true } })
      expect(state.getFullPassPending(db())).toBe(true)
      const before = mark()
      resetWrites()
      const { result } = await sync()

      expect(readwise.since(before).windowed).toHaveLength(0)
      expect(result).toMatchObject({ added: 1, updated: 0 })
      expect((await noteFor(3)).content).toContain('Highlight 31')
      expect(state.getFullPassPending(db())).toBe(false)
      // The pass wrote nothing for the books already in the vault.
      expect(writes()).toBe(1)
    })

    it('switching it off leaves its notes untouched', async () => {
      twoBooks()
      await sync()
      const note = await noteFor(1)
      settings.writeReadwiseOptions(db(), { categories: { books: false } })
      edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
      resetWrites()

      const { events } = await sync()

      expect(events).toContainEqual({
        title: 'Deep Work',
        result: 'skipped',
        reason: 'category-off'
      })
      expect(writes()).toBe(0)
      expect((await noteFor(1)).content).toBe(note.content)
    })

    it('keeps the flag of a category switched on while the run was reading', async () => {
      withSupplemental()
      await sync()
      settings.writeReadwiseOptions(db(), { categories: { supplementals: true } })
      settings.writeReadwiseOptions(db(), { categories: { tweets: false } })
      readwise.books.push(
        stubBook(4, { title: 'A podcast', readable_title: 'A podcast', category: 'podcasts' })
      )
      // Podcasts get switched off, and back on, while the export is being read.
      settings.writeReadwiseOptions(db(), { categories: { podcasts: false } })
      const firstRequest = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        settings.writeReadwiseOptions(db(), { categories: { podcasts: true } })
        return firstRequest(input, init)
      })

      await sync()

      expect(state.getFullPassPending(db())).toBe(true)
    })
  })

  describe('the daily full read (book-level edits, issue S5)', () => {
    const DAY = 24 * 60 * 60 * 1000

    it('reads the whole export when the clock was set back past the last full read', async () => {
      twoBooks()
      const service = new engine.ReadwiseSyncService({
        now: () => new Date('2026-10-10T08:00:00Z')
      })
      await sync({ service })
      cursorAt(9)
      state.setLastFullRead(db(), '2030-01-01T00:00:00.000Z')
      const before = mark()
      await sync({ service })
      expect(readwise.since(before).windowed).toHaveLength(0)
    })

    it('reads the whole export again after a day, so a new document note arrives', async () => {
      twoBooks()
      let now = new Date('2026-10-10T08:00:00Z')
      const service = new engine.ReadwiseSyncService({ now: () => now })
      await sync({ service })
      cursorAt(9)

      // Nothing about the highlights changed, so a window would not name the book.
      edit(1, (b) => {
        b.document_note = 'A note on the whole book'
      })
      now = new Date(now.getTime() + 60 * 60 * 1000)
      let before = mark()
      await sync({ service })
      expect(readwise.since(before).windowed).toHaveLength(1)
      expect((await noteFor(1)).content).not.toContain('A note on the whole book')

      now = new Date(now.getTime() + DAY)
      before = mark()
      const { result } = await sync({ service })
      expect(readwise.since(before).windowed).toHaveLength(0)
      expect(result).toMatchObject({ updated: 1 })
      expect((await noteFor(1)).content).toContain('A note on the whole book')
    })
  })

  describe('activity log (D19)', () => {
    it('a run that changed something writes one line, and a run that changed nothing none', async () => {
      twoBooks()
      await sync()
      expect(mocks.recordActivity).toHaveBeenCalledTimes(1)
      expect(mocks.recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Readwise: 2 books, 5 highlights' })
      )

      mocks.recordActivity.mockClear()
      await sync()
      expect(mocks.recordActivity).not.toHaveBeenCalled()

      edit(2, (b) => b.highlights.push(hl(23, 30, 5)))
      await sync()
      expect(mocks.recordActivity).toHaveBeenCalledTimes(1)
      expect(mocks.recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Readwise: 1 book, 1 highlight' })
      )
    })

    it('an import started from the dialog leaves the line to the import runner', async () => {
      twoBooks()
      await runner.runImport({ importId: 'dialog', importerId: 'readwise', sourcePaths: [] })
      expect(mocks.recordActivity).toHaveBeenCalledTimes(1)
      expect(mocks.recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'import', importer: 'readwise' })
      )
      expect(mocks.recordActivity.mock.calls[0][0].message).toBeUndefined()
    })
  })

  it('a book the engine itself cannot process goes on the retry list, since the cursor moves on', async () => {
    twoBooks()
    await sync()
    edit(2, (b) => {
      b.is_deleted = true
      b.highlights = b.highlights.map((h) => ({ ...h, is_deleted: true, updated_at: t(6) }))
    })
    vi.spyOn(links, 'markLinkState').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })

    const { result } = await sync()

    expect(result.failed).toBe(1)
    expect(state.getRetryList(db())).toMatchObject([
      { readwiseBookId: 2, reason: 'database is locked' }
    ])
  })

  it('a book missing from the full fetch is put on the retry list', async () => {
    twoBooks()
    await sync()
    edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
    const handle = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      new URL(requestUrl(input)).searchParams.has('ids')
        ? new Response(JSON.stringify({ nextPageCursor: null, results: [] }), { status: 200 })
        : handle(input, init)
    )

    await sync()

    expect(state.getRetryList(db()).map((e) => e.readwiseBookId)).toEqual([1])
  })

  it('a run stopped after writing still leaves its activity line', async () => {
    twoBooks()
    await sync()
    mocks.recordActivity.mockClear()
    edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
    edit(2, (b) => b.highlights.push(hl(23, 30, 6)))
    const controller = new AbortController()
    const actual = vi.mocked(domain.updateNoteCommand).getMockImplementation()!
    vi.mocked(domain.updateNoteCommand).mockImplementationOnce(async (input) => {
      const written = await actual(input)
      controller.abort()
      return written
    })

    const { result } = await sync({ signal: controller.signal })

    expect(result.cancelled).toBe(true)
    expect(mocks.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/^Readwise: 1 book, \d+ highlights?$/)
      })
    )
  })

  describe('cursor (D7)', () => {
    it('stays put when the window is empty, and never moves back', async () => {
      twoBooks()
      await sync()
      const cursor = state.getCursor(db())
      await sync()
      expect(state.getCursor(db())).toBe(cursor)

      edit(1, (b) => b.highlights.push(hl(14, 40, 9)))
      await sync()
      expect(state.getCursor(db())).toBe('2026-10-09T09:59:59.000Z')
    })

    it('ignores the newer edits of the books fetched by ids=', async () => {
      twoBooks()
      await sync()
      edit(1, (b) => b.highlights.push(hl(14, 40, 5)))
      // Book 2 is edited after the window was read and before the full books are.
      const handle = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (new URL(requestUrl(input)).searchParams.has('ids')) {
          edit(1, (b) => b.highlights.push(hl(15, 50, 20)))
        }
        return handle(input, init)
      })

      await sync()

      // Day 5, not day 20: the late edit is still ahead of the cursor for the next run.
      expect(state.getCursor(db())).toBe('2026-10-05T09:59:59.000Z')
      vi.mocked(fetch).mockImplementation(handle)
    })
  })
})
