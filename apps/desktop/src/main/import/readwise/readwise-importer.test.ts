/**
 * The Readwise first import through the real importer entry (`previewImport` /
 * `runImport`, as `import:start` calls them), the real engine, the real note
 * writer, a real temp vault and real databases. Only the network is stubbed:
 * readwise.io (global `fetch`) and the image download (`net.fetch`). A test
 * that handed books straight to the writer would prove nothing about the
 * seams that can lose data (cursor, categories, retry list, cancel).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { ImportChannels } from '@memry/contracts/import-channels'
import {
  markPullCompleted,
  markSyncEligible,
  markSyncIneligible,
  resetSyncDecision
} from '@memry/sync-client/sync-eligibility'
import { readSection, type ReadwiseBook } from '@memry/importers/readwise'
import { book, highlight, COVER_URL } from '@memry/importers/readwise/fixtures'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../../projections'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'

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
vi.mock('../../secrets/secret-storage', () => ({
  setSecret: async (service: string, account: string, value: string) => {
    mocks.secrets.set(`${service}/${account}`, value)
  },
  getSecret: async (service: string, account: string) =>
    mocks.secrets.get(`${service}/${account}`) ?? null,
  deleteSecret: async (service: string, account: string) => {
    mocks.secrets.delete(`${service}/${account}`)
  }
}))
vi.mock('../../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../../notes/runtime-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../notes/runtime-effects')>()),
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn(),
  emitNoteAttachmentSaved: vi.fn()
}))
vi.mock('../../sync/crdt-external-feed', () => ({
  feedExternalEditToCrdt: vi.fn(async () => true)
}))
vi.mock('../../notes/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../notes/domain')>()
  return { ...actual, updateNoteCommand: vi.fn(actual.updateNoteCommand) }
})
vi.mock('../_shared/imported-note', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_shared/imported-note')>()
  return { ...actual, createImportedNote: vi.fn(actual.createImportedNote) }
})
vi.mock('../../vault/activity-log', () => ({ recordActivity: mocks.recordActivity }))
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../../telemetry/diagnostics', () => ({ trackMainLog: vi.fn(), trackMainError: vi.fn() }))

const TOKEN = 'rw-test-token'
const PNG = new Uint8Array([137, 80, 78, 71]).buffer

/** Highlights with Readwise's server times, so the cursor has something to anchor on. */
function highlights(bookId: number, count: number, updatedAt = '2026-10-20T10:00:00Z') {
  return Array.from({ length: count }, (_, i) =>
    highlight(bookId * 100 + i, {
      location: (i + 1) * 10,
      created_at: `2026-10-0${(i % 9) + 1}T10:00:00Z`,
      updated_at: updatedAt
    })
  )
}

/** `book()` names every book "Book n"; these tests read titles. */
function named(id: number, title: string, over: Partial<ReadwiseBook> = {}): ReadwiseBook {
  return book(id, { title, readable_title: title, ...over })
}

/** A library across every category, split over three export pages. */
function library(): ReadwiseBook[][] {
  return [
    [
      named(1, 'Deep Work', {
        cover_image_url: COVER_URL,
        highlights: highlights(1, 3, '2026-10-21T08:00:00Z')
      }),
      named(2, 'Atomic Habits', { highlights: highlights(2, 2) }),
      named(3, 'A long read', {
        category: 'articles',
        source: 'reader',
        cover_image_url: COVER_URL,
        highlights: highlights(3, 1, '2026-10-22T12:30:45Z')
      })
    ],
    [
      named(4, 'A tweet', { category: 'tweets', highlights: highlights(4, 1) }),
      named(5, 'A podcast', { category: 'podcasts', highlights: highlights(5, 2) }),
      named(6, 'Getting started', { category: 'supplementals', highlights: [] })
    ],
    [
      named(7, 'Something new', { category: 'newspapers', highlights: highlights(7, 1) }),
      named(8, 'Cleaned up', {
        is_deleted: true,
        highlights: [highlight(801, { is_deleted: true })]
      })
    ]
  ]
}

describe('Readwise first import', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let importer: typeof import('./readwise-importer')
  let runner: typeof import('../runner')
  let registry: typeof import('../registry')
  let domain: typeof import('../../notes/domain')
  let notes: typeof import('../../vault/notes')
  let state: typeof import('../../readwise/sync-state')
  let links: typeof import('../../readwise/links-repository')
  let secrets: typeof import('../../readwise/secrets')
  let settings: typeof import('../../readwise/settings')
  let imported: typeof import('../_shared/imported-note')
  let pages: ReadwiseBook[][]
  let requests: URL[]
  let importCount = 0

  const db = () => asClientDb(dataDb.db)
  const writes = () => vi.mocked(domain.updateNoteCommand).mock.calls.length

  beforeEach(async () => {
    vault = createTestVault('readwise-importer')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    mocks.secrets.clear()
    // Sync off: no claim, this device pulls (D8). The gate has its own tests in readwise/.
    markSyncIneligible()
    mocks.recordActivity.mockClear()
    mocks.imageFetch.mockReset()
    mocks.imageFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG
    }))
    pages = library()
    requests = []

    // The export pages through `pageCursor`; page n answers with cursor n + 1.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input)
        requests.push(url)
        if (url.searchParams.get('pageCursor') === 'bad') return new Response('', { status: 401 })
        const index = Number(url.searchParams.get('pageCursor') ?? '0')
        return new Response(
          JSON.stringify({
            nextPageCursor: index + 1 < pages.length ? String(index + 1) : null,
            results: pages[index] ?? []
          }),
          { status: 200 }
        )
      })
    )

    const vaultIndex = await import('../../vault/index')
    const database = await import('../../database')
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
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db as never)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    importer = await import('./readwise-importer')
    runner = await import('../runner')
    registry = await import('../registry')
    domain = await import('../../notes/domain')
    notes = await import('../../vault/notes')
    state = await import('../../readwise/sync-state')
    links = await import('../../readwise/links-repository')
    secrets = await import('../../readwise/secrets')
    settings = await import('../../readwise/settings')
    imported = await import('../_shared/imported-note')
    registry.__resetRegistry()
    registry.registerImporter(importer.readwiseImporter)
    vi.mocked(domain.updateNoteCommand).mockClear()
    vi.mocked(imported.createImportedNote).mockClear()
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

  const preview = () =>
    runner.previewImport({
      importId: `p-${++importCount}`,
      importerId: 'readwise',
      sourcePaths: []
    })
  const run = (importId = `r-${++importCount}`) =>
    runner.runImport({ importId, importerId: 'readwise', sourcePaths: [] })
  const vaultFiles = (dir: string): string[] => {
    const full = path.join(vault.path, dir)
    return fs.existsSync(full) ? fs.readdirSync(full).sort() : []
  }
  const noteFor = async (bookId: number) =>
    (await notes.getNoteById(links.getLinkByBookId(db(), bookId)!.noteId))!

  describe('preview', () => {
    it('counts books and highlights per category and writes nothing', async () => {
      const result = await preview()

      const counts = Object.fromEntries(
        result.groups.map((g) => [g.label, g.counts.map((c) => c.value)])
      )
      expect(counts).toEqual({
        books: [2, 5],
        articles: [1, 1],
        tweets: [1, 1],
        podcasts: [1, 2],
        supplementals: [1, 0],
        other: [1, 1]
      })
      expect(result.groups.find((g) => g.label === 'books')?.sampleTitles).toEqual([
        'Deep Work',
        'Atomic Habits'
      ])
      expect(vaultFiles('Readwise')).toEqual([])
      expect(state.getCursor(db())).toBeNull()
      expect(imported.createImportedNote).not.toHaveBeenCalled()
      expect(requests.every((url) => !url.searchParams.has('updatedAfter'))).toBe(true)
    })

    it('shows zeros for an empty account', async () => {
      pages = [[]]
      const result = await preview()
      expect(result.groups.map((g) => g.counts.map((c) => c.value))).toEqual(Array(5).fill([0, 0]))
    })

    it('warns when there is no token, or Readwise rejects it', async () => {
      await secrets.deleteReadwiseToken(vault.path)
      expect((await preview()).groups[0].error).toMatchObject({ code: 'readwise.tokenMissing' })

      await secrets.setReadwiseToken(vault.path, TOKEN)
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }))
      expect((await preview()).groups[0].error).toMatchObject({ code: 'readwise.tokenInvalid' })

      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('offline'))
      expect((await preview()).groups[0].error).toMatchObject({ code: 'readwise.unreachable' })
    })
  })

  describe('run', () => {
    it('backfills every enabled category into its folder and advances the cursor once', async () => {
      const summary = await run()

      expect(summary.failed).toEqual([])
      expect(summary.imported).toBe(6)
      expect(vaultFiles('Readwise/Books')).toEqual(['Atomic Habits.md', 'Deep Work.md'])
      expect(vaultFiles('Readwise/Articles')).toEqual(['A long read.md'])
      expect(vaultFiles('Readwise/Tweets')).toEqual(['A tweet.md'])
      expect(vaultFiles('Readwise/Podcasts')).toEqual(['A podcast.md'])
      expect(vaultFiles('Readwise/Other')).toEqual(['Something new.md'])
      // Supplementals are off (D3), a book deleted in Readwise has no note.
      expect(vaultFiles('Readwise/Supplementals')).toEqual([])
      expect(links.getLinkByBookId(db(), 8)).toBeUndefined()
      expect(
        summary.skippedReasons?.map((g) => (g.reason as { code: string }).code).sort()
      ).toEqual(['readwise.categoryOff', 'readwise.sourceDeleted'])

      const deepWork = await noteFor(1)
      expect(readSection(deepWork.content)).toMatchObject({ found: true, untouched: true })
      expect(deepWork.content).toContain('Highlight 100')
      expect(deepWork.content).not.toContain(COVER_URL)

      // Newest highlight `updated_at` (2026-10-22T12:30:45Z) minus one second.
      expect(state.getCursor(db())).toBe('2026-10-22T12:30:44.000Z')
      expect(state.getLastRun(db())).toMatchObject({ needsAttention: false })
      expect(state.getRetryList(db())).toEqual([])
      expect(mocks.recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'import', importer: 'readwise' })
      )
    })

    it('reads the full export without a cursor, with deletions included', async () => {
      await run()
      expect(requests.length).toBe(3)
      for (const url of requests) {
        expect(url.pathname).toBe('/api/v2/export/')
        expect(url.searchParams.has('updatedAfter')).toBe(false)
        expect(url.searchParams.get('includeDeleted')).toBe('true')
      }
    })

    it('imports nothing from a category switched off, and everything from one switched on', async () => {
      settings.writeReadwiseOptions(db(), { categories: { books: false, supplementals: true } })
      await run()
      expect(vaultFiles('Readwise/Books')).toEqual([])
      expect(vaultFiles('Readwise/Supplementals')).toEqual(['Getting started.md'])
      expect(vaultFiles('Readwise/Tweets')).toEqual(['A tweet.md'])
    })

    it('honours the flat layout and the chosen root folder', async () => {
      settings.writeReadwiseOptions(db(), { rootFolder: 'Reading/Notes', folderLayout: 'flat' })
      await run()
      expect(vaultFiles('Reading/Notes')).toContain('Deep Work.md')
      expect(vaultFiles('Readwise')).toEqual([])
    })

    it('a second import writes nothing and keeps the text the user added', async () => {
      await run()
      const deepWork = await noteFor(1)
      await notes.updateNote({
        id: deepWork.id,
        content: `My own thoughts.\n\n${deepWork.content}`
      })
      vi.mocked(domain.updateNoteCommand).mockClear()
      vi.mocked(imported.createImportedNote).mockClear()
      const before = fs.readFileSync(path.join(vault.path, deepWork.path), 'utf8')

      const second = await run()

      expect(second.imported).toBe(0)
      expect(second.failed).toEqual([])
      expect(writes()).toBe(0)
      expect(imported.createImportedNote).not.toHaveBeenCalled()
      expect(fs.readFileSync(path.join(vault.path, deepWork.path), 'utf8')).toBe(before)
      expect((await noteFor(1)).content).toContain('My own thoughts.')
      expect(second.skippedReasons?.map((g) => (g.reason as { code: string }).code)).toContain(
        'readwise.unchanged'
      )
    })

    it('appends a new highlight to a note the user edited and keeps the edit', async () => {
      await run()
      const deepWork = await noteFor(1)
      await notes.updateNote({
        id: deepWork.id,
        content: deepWork.content.replace('Highlight 100', 'Highlight 100 (my words)')
      })
      pages[0][0] = named(1, 'Deep Work', {
        cover_image_url: COVER_URL,
        highlights: [
          ...highlights(1, 3, '2026-10-21T08:00:00Z'),
          highlight(190, {
            created_at: '2026-10-25T10:00:00Z',
            updated_at: '2026-10-25T10:00:00Z',
            location: 900
          })
        ]
      })

      await run()

      const body = (await noteFor(1)).content
      expect(body).toContain('Highlight 100 (my words)')
      expect(body).toContain('Highlight 190')
      expect(body.match(/Highlight 101/g)).toHaveLength(1)
    })

    it('marks a book deleted in Readwise and leaves its note as it is', async () => {
      await run()
      const before = (await noteFor(2)).content
      pages[0][1] = book(2, { is_deleted: true, highlights: [] })
      vi.mocked(domain.updateNoteCommand).mockClear()

      const second = await run()

      expect(links.getLinkByBookId(db(), 2)?.state).toBe('source-deleted')
      expect((await noteFor(2)).content).toBe(before)
      expect(writes()).toBe(0)
      expect(second.failed).toEqual([])
    })

    it('reports a failing book, puts it on the retry list, and finishes the rest', async () => {
      const actual = await vi.importActual<typeof import('../_shared/imported-note')>(
        '../_shared/imported-note'
      )
      vi.mocked(imported.createImportedNote).mockImplementation(async (input) => {
        if (input.title === 'Atomic Habits') throw new Error('disk is read-only')
        return actual.createImportedNote(input)
      })

      const first = await run()

      expect(first.failed).toEqual([{ item: 'Atomic Habits', error: 'disk is read-only' }])
      expect(first.imported).toBe(5)
      expect(state.getRetryList(db())).toEqual([
        { readwiseBookId: 2, reason: 'disk is read-only', attempts: 1 }
      ])
      // The run completed, so the cursor still moved.
      expect(state.getCursor(db())).not.toBeNull()

      vi.mocked(imported.createImportedNote).mockImplementation(actual.createImportedNote)
      const second = await run()
      expect(second.failed).toEqual([])
      expect(second.imported).toBe(1)
      expect(state.getRetryList(db())).toEqual([])
      expect(vaultFiles('Readwise/Books')).toContain('Atomic Habits.md')
    })

    it('cancel stops within one book and leaves the cursor alone', async () => {
      // The first book's cover download is where the user presses Cancel.
      mocks.imageFetch.mockImplementationOnce(async () => {
        runner.cancelImport('cancel-me')
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => PNG
        }
      })

      const summary = await run('cancel-me')

      expect(summary.imported).toBe(1)
      expect(vaultFiles('Readwise/Books')).toEqual(['Deep Work.md'])
      expect(vaultFiles('Readwise/Tweets')).toEqual([])
      expect(state.getCursor(db())).toBeNull()
      expect(state.getLastRun(db())).toBeNull()
    })

    it('cancel while reading the export writes nothing', async () => {
      vi.mocked(fetch).mockImplementationOnce(async () => {
        runner.cancelImport('early')
        throw new DOMException('aborted', 'AbortError')
      })
      const summary = await run('early')
      expect(summary.imported).toBe(0)
      expect(vaultFiles('Readwise')).toEqual([])
      expect(state.getCursor(db())).toBeNull()
    })

    it('reports progress that only moves forward, to the number of books', async () => {
      const progress: { completed: number; total: number }[] = []
      const spy = vi.spyOn(await import('../../lib/window-broadcast'), 'broadcastToAllWindows')
      spy.mockImplementation((channel, payload) => {
        if (channel !== ImportChannels.events.PROGRESS) return
        const event = payload as { completed: number; total: number }
        progress.push({ completed: event.completed, total: event.total })
      })

      await run()

      const completed = progress.map((p) => p.completed)
      expect(completed).toEqual([...completed].sort((a, b) => a - b))
      expect(progress.at(-1)).toMatchObject({ completed: 8, total: 8 })
    })

    it('never moves the cursor back', async () => {
      state.setCursor(db(), '2030-01-01T00:00:00.000Z')
      await run()
      expect(state.getCursor(db())).toBe('2030-01-01T00:00:00.000Z')
    })

    it('empty account: the run completes and the cursor still advances', async () => {
      pages = [[]]
      const summary = await run()
      expect(summary).toMatchObject({ imported: 0, failed: [] })
      expect(state.getCursor(db())).not.toBeNull()
      expect(state.getLastRun(db())).toMatchObject({ needsAttention: false })
      expect(vaultFiles('Readwise')).toEqual([])
    })

    it('a revoked token fails the run with a readable message and flags attention', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response('', { status: 401 }))
      await expect(run()).rejects.toThrow(/did not accept this token/)
      expect(state.getLastRun(db())).toMatchObject({ needsAttention: true })
      expect(state.getCursor(db())).toBeNull()
    })

    it('refuses to run without a token', async () => {
      await secrets.deleteReadwiseToken(vault.path)
      await expect(run()).rejects.toThrow(/not connected/)
    })

    it('with sync on, waits for memry sync to complete a pull since launch before it reads Readwise (D8)', async () => {
      markSyncEligible()
      const deviceId = 'dev-import'
      dataDb.db
        .insert(syncDevices)
        .values({
          id: deviceId,
          name: 'This Mac',
          platform: 'macos',
          appVersion: '1.0.0',
          linkedAt: new Date(),
          isCurrentDevice: true,
          signingPublicKey: 'key'
        })
        .run()
      const { writeClaim } = await import('../../readwise/claim')
      writeClaim(asClientDb(dataDb.db), { deviceId, deviceName: 'This Mac' })
      setTimeout(markPullCompleted, 700)

      const started = Date.now()
      await run()

      expect(Date.now() - started).toBeGreaterThanOrEqual(500)
      expect(vaultFiles('Readwise/Books')).toHaveLength(2)
    })

    it('a run another device took over stops with a sentence that names that device', async () => {
      markSyncEligible()
      markPullCompleted()
      dataDb.db
        .insert(syncDevices)
        .values({
          id: 'dev-import',
          name: 'This Mac',
          platform: 'macos',
          appVersion: '1.0.0',
          linkedAt: new Date(),
          isCurrentDevice: true,
          signingPublicKey: 'key'
        })
        .run()
      const { writeClaim } = await import('../../readwise/claim')
      writeClaim(asClientDb(dataDb.db), { deviceId: 'dev-other', deviceName: 'Desk Mac' })

      await expect(run()).rejects.toThrow(/Readwise syncs on Desk Mac/)
      expect(vaultFiles('Readwise/Books')).toHaveLength(0)
    })

    it('does not start a second run while one is going', async () => {
      const first = run('one')
      await expect(run('two')).rejects.toThrow(/already in progress/)
      await first
    })
  })
})
