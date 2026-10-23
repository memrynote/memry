/**
 * The day's highlights in the journal (#3476, D17), through the real run engine,
 * the real note writer, the real journal owner and a real temp vault. Only the
 * network is stubbed: a stateful readwise.io and the image download. Every
 * scenario runs the engine more than once, because "new arrival" and "no
 * backfill" only exist across runs.
 */

import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSetting } from '../database/queries/settings'
import { planJournalDay, readDaySection, type JournalBook } from '@memry/importers/readwise'
import { book, highlight } from '@memry/importers/readwise/fixtures'
import type { ReadwiseBook } from '@memry/importers/readwise'
import * as Y from 'yjs'
import { readwiseHighlights } from '@memry/db-schema/schema/readwise-highlights'
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
import {
  flushProjectionEvents,
  startProjectionRuntime,
  stopProjectionRuntime
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'

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
  ...(await importOriginal<typeof import('../notes/runtime-effects')>()),
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn(),
  emitNoteAttachmentSaved: vi.fn()
}))
vi.mock('../sync/crdt-external-feed', () => ({
  feedExternalEditToCrdt: vi.fn(async () => true)
}))
vi.mock('../notes/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notes/domain')>()
  return { ...actual, updateNoteCommand: vi.fn(actual.updateNoteCommand) }
})
vi.mock('../import/_shared/imported-note', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../import/_shared/imported-note')>()
  return { ...actual, createImportedNote: vi.fn(actual.createImportedNote) }
})
vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalUpdate: vi.fn(),
  enqueueJournalDelete: vi.fn(),
  initializeJournalCrdt: vi.fn(async () => {}),
  feedJournalBodyToCrdt: vi.fn(async () => {})
}))
vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))
vi.mock('../journal/update-entry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../journal/update-entry')>()
  return {
    ...actual,
    updateJournalEntry: vi.fn(actual.updateJournalEntry),
    appendToJournalEntry: vi.fn(actual.appendToJournalEntry)
  }
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

/** A highlight made on `day` (October 2026) at `hour` UTC, that Readwise updated on `updatedDay`. */
function hl(id: number, location: number, day: number, updatedDay = day, hour = 12) {
  return highlight(id, {
    text: `Highlight ${id}`,
    location,
    highlighted_at: t(day, hour),
    created_at: t(day, hour),
    updated_at: t(updatedDay)
  })
}

describe('Readwise journal highlights', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let engine: typeof import('../readwise/sync-service')
  let domain: typeof import('../notes/domain')
  let state: typeof import('../readwise/sync-state')
  let secrets: typeof import('../readwise/secrets')
  let settings: typeof import('../readwise/settings')
  let imported: typeof import('../import/_shared/imported-note')
  let crdtProvider: typeof import('../sync/crdt-provider')
  let registry: typeof import('../import/registry')
  let readwise: ReadwiseStub
  let highlightsIndex: typeof import('../readwise/highlights-index')
  let journalEffects: typeof import('../journal/runtime-effects')
  let journal: typeof import('../vault/journal')
  let journalOwner: typeof import('../journal/update-entry')
  let journalCreate: typeof import('../journal/create-entry')

  const db = () => asClientDb(dataDb.db)
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

    const vaultIndex = await import('../vault/index')
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
      journalDateFormat: 'YYYY-MM-DD'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db as never)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    engine = await import('../readwise/sync-service')
    domain = await import('../notes/domain')
    state = await import('../readwise/sync-state')
    secrets = await import('../readwise/secrets')
    settings = await import('../readwise/settings')
    imported = await import('../import/_shared/imported-note')
    crdtProvider = await import('../sync/crdt-provider')
    registry = await import('../import/registry')
    const { readwiseImporter } = await import('../import/readwise/readwise-importer')
    registry.__resetRegistry()
    registry.registerImporter(readwiseImporter)
    journal = await import('../vault/journal')
    highlightsIndex = await import('../readwise/highlights-index')
    journalEffects = await import('../journal/runtime-effects')
    journalOwner = await import('../journal/update-entry')
    journalCreate = await import('../journal/create-entry')
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
  async function sync(service?: InstanceType<typeof engine.ReadwiseSyncService>) {
    return (service ?? engine.getReadwiseSyncService()).run(TOKEN, {
      signal: new AbortController().signal,
      book: () => {}
    })
  }

  const journalOn = () => settings.writeReadwiseOptions(db(), { journalHighlights: true })
  const entry = async (date: string) => (await journal.readJournalEntry(date))?.content ?? null
  const journalWrites = () =>
    vi.mocked(journalOwner.updateJournalEntry).mock.calls.length +
    vi.mocked(journalOwner.appendToJournalEntry).mock.calls.length
  const resetJournalWrites = () => {
    vi.mocked(journalOwner.updateJournalEntry).mockClear()
    vi.mocked(journalOwner.appendToJournalEntry).mockClear()
  }
  const indexRows = () =>
    asClientDb(dataDb.db)
      .select()
      .from(readwiseHighlights)
      .all()
      .sort((a, b) => a.highlightId - b.highlightId)
  const edit = (bookId: number, change: (b: StubBook) => void) => {
    change(readwise.books.find((b) => b.user_book_id === bookId)!)
  }

  /** The first of the day's highlights is the book's, the order of the section. */
  const day = (...books: JournalBook[]) => planJournalDay(books)
  const at = (hour: number) => `2026-10-05T${String(hour).padStart(2, '0')}:00:00.000Z`

  function library() {
    readwise.books = [
      stubBook(1, {
        title: 'Deep Work',
        readable_title: 'Deep Work',
        highlights: [hl(11, 10, 1), hl(12, 20, 5, 1, 12)]
      }),
      stubBook(2, {
        title: 'Atomic Habits',
        readable_title: 'Atomic Habits',
        highlights: [hl(21, 10, 5, 1, 9)]
      }),
      // Supplementals are off (D3): no note, so no link in the journal.
      stubBook(3, {
        title: 'A Supplemental',
        readable_title: 'A Supplemental',
        category: 'supplementals',
        highlights: [hl(31, 10, 5, 1)]
      })
    ]
  }

  const AH = (count: number): JournalBook => ({ title: 'Atomic Habits', count, first: at(9) })
  const DW = (count: number): JournalBook => ({ title: 'Deep Work', count, first: at(12) })

  it('the first import writes nothing to the journal, and neither does the next run', async () => {
    library()
    journalOn()

    await sync()
    await sync()

    expect(journalWrites()).toBe(0)
    expect(await entry('2026-10-05')).toBeNull()
    expect(await entry('2026-10-01')).toBeNull()
    expect(indexRows().map((row) => row.highlightId)).toEqual([11, 12, 21, 31])
    expect(state.getJournalPending(db())).toEqual({})
  })

  it('a highlight made on an earlier day goes into that day, listing the whole day, and creates the entry', async () => {
    library()
    journalOn()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))

    await sync()

    expect(await entry('2026-10-05')).toBe(day(AH(1), DW(2)))
    expect(await entry('2026-10-01')).toBeNull()
    expect(journalWrites()).toBe(1)
    expect(state.getJournalPending(db())).toEqual({})
  })

  it('re-renders an untouched section, and only appends a line to a touched one', async () => {
    library()
    journalOn()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    await sync()

    edit(1, (b) => b.highlights.push(hl(14, 40, 5, 21, 14)))
    await sync()
    expect(await entry('2026-10-05')).toBe(day(AH(1), DW(3)))

    // The user writes in the section: it is theirs from now on.
    const mine = (await entry('2026-10-05'))!.replace('3 highlights', '3 highlights, my favourite')
    await journalOwner.updateJournalEntry({ date: '2026-10-05', content: mine })
    resetJournalWrites()
    edit(1, (b) => b.highlights.push(hl(15, 50, 5, 22, 15)))
    await sync()

    const body = (await entry('2026-10-05'))!
    expect(body).toContain(
      '- [[Deep Work]]: 3 highlights, my favourite\n- [[Deep Work]]: 1 highlight\n'
    )
    expect(body.match(/Deep Work\]\]/g)).toHaveLength(2)
    expect(readDaySection(body)).toMatchObject({ found: true, untouched: false })
    expect(journalWrites()).toBe(1)
  })

  it('writes nothing when the section would come out the same', async () => {
    library()
    journalOn()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    await sync()
    const before = await entry('2026-10-05')
    resetJournalWrites()

    // A highlight of a book with no note changes no line of the day.
    edit(3, (b) => b.highlights.push(hl(32, 20, 5, 21, 14)))
    await sync()

    expect(journalWrites()).toBe(0)
    expect(await entry('2026-10-05')).toBe(before)
    expect(state.getJournalPending(db())).toEqual({})
  })

  it('an entry open in the editor waits for the next run', async () => {
    library()
    journalOn()
    await sync()
    const id = journalCreate.resolveJournalEntryId('2026-10-05')
    const getDoc = vi
      .spyOn(crdtProvider.getCrdtProvider(), 'getDoc')
      .mockImplementation((docId: string) => (docId === id ? new Y.Doc() : undefined))
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))

    await sync()

    expect(journalWrites()).toBe(0)
    expect(await entry('2026-10-05')).toBeNull()
    expect(state.getJournalPending(db())).toEqual({ '2026-10-05': { '1': 1 } })

    getDoc.mockReturnValue(undefined)
    await sync()

    expect(await entry('2026-10-05')).toBe(day(AH(1), DW(2)))
    expect(state.getJournalPending(db())).toEqual({})
  })

  it('writes nothing with the switch off or the journal feature off, and never backfills afterwards', async () => {
    library()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    await sync()
    expect(journalWrites()).toBe(0)
    expect(indexRows().map((row) => row.highlightId)).toContain(13)

    setSetting(db(), 'features', JSON.stringify({ journal: false }))
    journalOn()
    edit(1, (b) => b.highlights.push(hl(14, 40, 5, 21, 14)))
    await sync()
    expect(journalWrites()).toBe(0)
    expect(state.getJournalPending(db())).toEqual({})

    setSetting(db(), 'features', JSON.stringify({ journal: true }))
    await sync()
    expect(journalWrites()).toBe(0)
    expect(await entry('2026-10-05')).toBeNull()
  })

  it('a category full pass fills the index and writes nothing', async () => {
    library()
    journalOn()
    await sync()
    settings.writeReadwiseOptions(db(), { categories: { supplementals: true } })
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))

    await sync()

    expect(journalWrites()).toBe(0)
    expect(indexRows().map((row) => row.highlightId)).toContain(13)
  })

  it('the first run after the index shipped reads everything and writes nothing', async () => {
    library()
    journalOn()
    await sync()
    // An install from before #3476: a cursor, but no index.
    asClientDb(dataDb.db).delete(readwiseHighlights).run()
    dataDb.db.run(sql`DELETE FROM settings WHERE key = 'readwise.highlightIndex'`)
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    const mark = readwise.requests.length

    await sync()

    expect(readwise.since(mark).windowed).toHaveLength(0)
    expect(journalWrites()).toBe(0)
    expect(indexRows().map((row) => row.highlightId)).toEqual([11, 12, 13, 21, 31])
  })

  it('counts an arrival the daily full read finds, because the index says it is new', async () => {
    library()
    journalOn()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    const later = new engine.ReadwiseSyncService({
      now: () => new Date(Date.now() + engine.FULL_READ_INTERVAL_MS + 60_000)
    })
    const mark = readwise.requests.length

    await sync(later)

    expect(readwise.since(mark).windowed).toHaveLength(0)
    expect(await entry('2026-10-05')).toBe(day(AH(1), DW(2)))
  })

  it('a deleted highlight is no arrival and no count', async () => {
    library()
    journalOn()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    await sync()
    edit(1, (b) => {
      b.highlights.find((h) => h.id === 13)!.is_deleted = true
      b.highlights.find((h) => h.id === 13)!.updated_at = t(21)
    })
    edit(1, (b) => b.highlights.push(hl(14, 40, 5, 22, 14)))

    await sync()

    expect(await entry('2026-10-05')).toBe(day(AH(1), DW(2)))
  })

  it('after a takeover the first run writes nothing, and the next re-render of an untouched day gives the old bytes', async () => {
    library()
    journalOn()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    await sync()
    const written = await entry('2026-10-05')
    const rowsOfA = indexRows()
    await flushProjectionEvents()

    // Device B: its own data DB (no links, cursor or index), the vault memry sync delivered.
    const deviceB = createTestDataDb()
    try {
      const database = await import('../database')
      vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(deviceB.db))
      settings.writeReadwiseOptions(asClientDb(deviceB.db), { journalHighlights: true })
      resetJournalWrites()

      await sync()

      expect(journalWrites()).toBe(0)
      expect(await entry('2026-10-05')).toBe(written)
      expect(
        asClientDb(deviceB.db)
          .select()
          .from(readwiseHighlights)
          .all()
          .sort((a, b) => a.highlightId - b.highlightId)
      ).toEqual(rowsOfA)

      // A highlight of a book without a note re-renders the day from B's index.
      edit(3, (b) => b.highlights.push(hl(32, 20, 5, 21, 14)))
      await sync()
      expect(journalWrites()).toBe(0)
      expect(await entry('2026-10-05')).toBe(written)

      // And a real arrival continues the same section.
      edit(2, (b) => b.highlights.push(hl(22, 20, 5, 22, 15)))
      await sync()
      expect(await entry('2026-10-05')).toBe(day(AH(2), DW(2)))
    } finally {
      deviceB.close()
    }
  })

  it('a failing index write stops the run before the cursor moves, so the arrival is found next run', async () => {
    library()
    journalOn()
    await sync()
    const cursor = state.getCursor(db())
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    vi.spyOn(highlightsIndex, 'upsertHighlights').mockImplementationOnce(() => {
      throw new Error('database is locked')
    })

    await expect(sync()).rejects.toThrow('database is locked')
    expect(state.getCursor(db())).toBe(cursor)
    expect(await entry('2026-10-05')).toBeNull()

    await sync()
    expect(await entry('2026-10-05')).toBe(day(AH(1), DW(2)))
  })

  it('a step that fails after the file was written does not append the same line again', async () => {
    library()
    journalOn()
    await sync()
    edit(1, (b) => b.highlights.push(hl(13, 30, 5, 20, 13)))
    await sync()
    const mine = (await entry('2026-10-05'))!.replace('2 highlights', '2 highlights, mine')
    await journalOwner.updateJournalEntry({ date: '2026-10-05', content: mine })
    vi.mocked(journalEffects.enqueueJournalUpdate).mockImplementationOnce(() => {
      throw new Error('sync queue unavailable')
    })
    edit(1, (b) => b.highlights.push(hl(14, 40, 5, 21, 14)))

    await sync()
    await sync()

    const body = (await entry('2026-10-05'))!
    expect(body.match(/- \[\[Deep Work\]\]: 1 highlight\n/g)).toHaveLength(1)
    expect(state.getJournalPending(db())).toEqual({})
  })
})
