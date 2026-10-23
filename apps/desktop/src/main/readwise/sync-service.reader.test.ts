/**
 * Readwise Reader documents (#1420), multi-run scenarios through the real run
 * engine, the real writers, a real temp vault and real databases. Only the
 * network is stubbed: readwise.io v2 and v3, and the image download. The join
 * (a v2 book and a Reader document are one note) and idempotence only fail
 * across runs, so each test runs the engine more than once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSection } from '@memry/importers/readwise'
import { book, highlight } from '@memry/importers/readwise/fixtures'
import type { ReadwiseBook } from '@memry/importers/readwise'
import { readdirSync } from 'node:fs'
import { imageFileStem } from './images'
import { join } from 'node:path'
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
import type * as ReaderModule from '../readwise/reader'
import type * as SyncServiceModule from '../readwise/sync-service'
import type * as NotesModule from '../vault/notes'
import type * as AttachmentsModule from '../vault/attachments'
import type * as BookCommandsModule from './book-commands'
import type * as SyncStateModule from '../readwise/sync-state'
import type * as LinksRepositoryModule from '../readwise/links-repository'
import type * as SecretsModule from '../readwise/secrets'
import type * as SettingsModule from '../readwise/settings'
import type { BookEvent } from '../readwise/sync-service'
import type { ImportPreview } from '../import/types'

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
// The 20 requests a minute budget is the client's own (#1419, tested there);
// a test run makes more than that, so it gets a budget that never waits.
vi.mock('../readwise/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof ReaderModule>()
  return {
    ...actual,
    listDocuments: (options: Parameters<typeof actual.listDocuments>[0]) =>
      actual.listDocuments({ ...options, limiter: new actual.RequestLimiter(1_000_000, 1) })
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

function hl(id: number, location: number, updatedDay: number, text = `Highlight ${id}`) {
  return highlight(id, {
    text,
    location,
    created_at: t(updatedDay),
    updated_at: t(updatedDay)
  })
}

type StubDocument = Record<string, unknown> & { id: string; location: string }

/** `GET /api/v3/list/`: location filter, `updatedAfter`, pages, and `html_content` only on request. */
class ReaderStub {
  documents: StubDocument[] = []
  requests: URL[] = []

  handle = async (input: string): Promise<Response> => {
    const url = new URL(input)
    this.requests.push(url)
    const after = url.searchParams.get('updatedAfter')
    const withHtml = url.searchParams.get('withHtmlContent') === 'true'
    const wanted = url.searchParams.get('id')
    const selected = this.documents
      .filter((d) => (wanted ? d.id === wanted : d.location === url.searchParams.get('location')))
      .filter((d) => !after || Date.parse(String(d.updated_at)) > Date.parse(after))
      .map((d) => (withHtml ? d : { ...d, html_content: undefined }))
    const index = Number(url.searchParams.get('pageCursor') ?? '0')
    const size = 2
    return new Response(
      JSON.stringify({
        count: selected.length,
        nextPageCursor: (index + 1) * size < selected.length ? String(index + 1) : null,
        results: selected.slice(index * size, (index + 1) * size)
      }),
      { status: 200 }
    )
  }
}

const COVER = 'https://cdn.example.com/cover.jpg'

function doc(id: string, over: Record<string, unknown> = {}): StubDocument {
  return {
    id,
    url: `https://read.readwise.io/read/${id}`,
    title: `Doc ${id}`,
    author: 'Jane Writer',
    source: 'Reader add from import URL',
    category: 'article',
    location: 'new',
    tags: {},
    site_name: 'Example Site',
    word_count: 1200,
    created_at: t(1),
    updated_at: t(1),
    published_date: '2026-09-30',
    summary: '',
    image_url: null,
    source_url: `https://example.com/${id}`,
    notes: '',
    parent_id: null,
    reading_progress: 0.4,
    html_content: '<p>Full article text.</p>',
    ...over
  } as StubDocument
}

describe('Readwise Reader documents', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let engine: typeof SyncServiceModule
  let domain: typeof DomainModule
  let notes: typeof NotesModule
  let attachments: typeof AttachmentsModule
  let state: typeof SyncStateModule
  let links: typeof LinksRepositoryModule
  let secrets: typeof SecretsModule
  let settings: typeof SettingsModule
  let imported: typeof ImportedNoteModule
  let readwise: ReadwiseStub
  let reader: ReaderStub

  const db = () => asClientDb(dataDb.db)
  const writes = () =>
    vi.mocked(domain.updateNoteCommand).mock.calls.length +
    vi.mocked(imported.createImportedNote).mock.calls.length
  const resetWrites = () => {
    vi.mocked(domain.updateNoteCommand).mockClear()
    vi.mocked(imported.createImportedNote).mockClear()
  }

  beforeEach(async () => {
    vault = createTestVault('readwise-reader')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    mocks.secrets.clear()
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
    reader = new ReaderStub()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) =>
        new URL(input).pathname.startsWith('/api/v3/')
          ? reader.handle(input)
          : readwise.handle(input)
      )
    )

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
      journalDateFormat: 'yyyy-MM-dd'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db as never)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    engine = await import('../readwise/sync-service')
    domain = await import('../notes/domain')
    notes = await import('../vault/notes')
    attachments = await import('../vault/attachments')
    state = await import('../readwise/sync-state')
    links = await import('../readwise/links-repository')
    secrets = await import('../readwise/secrets')
    settings = await import('../readwise/settings')
    imported = await import('../import/_shared/imported-note')
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

  async function sync() {
    const events: BookEvent[] = []
    const result = await engine.getReadwiseSyncService().run(TOKEN, {
      signal: new AbortController().signal,
      book: (event) => events.push(event)
    })
    return { result, events }
  }

  const readerOn = (fullText = false) =>
    settings.writeReadwiseOptions(db(), { readerDocuments: true, readerFullText: fullText })
  const listRequests = () => reader.requests.length

  /** Every markdown file in the vault outside `.memry`, as vault-relative paths. */
  function markdownFiles(dir = vault.path, prefix = ''): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith('.')) return []
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) return markdownFiles(join(dir, entry.name), rel)
      return entry.name.endsWith('.md') ? [rel] : []
    })
  }
  const noteOf = async (documentId: string) =>
    (await notes.getNoteById(links.getLinkByReaderDocumentId(db(), documentId)!.noteId))!

  it('with both switches off, a run makes no list request and writes no Reader note', async () => {
    reader.documents = [doc('d1')]
    readwise.books = [stubBook(1, { highlights: [hl(11, 10, 1)] })]

    await sync()
    await sync()

    expect(listRequests()).toBe(0)
    expect(markdownFiles().filter((file) => file.includes('/Reader/'))).toEqual([])
  })

  it('saved documents become notes in Reader/, feed never, children never, frontmatter at creation only', async () => {
    readerOn()
    reader.documents = [
      doc('d-new', { location: 'new', title: 'Fresh read', tags: { ai: { name: 'ai' } } }),
      doc('d-later', { location: 'later' }),
      doc('d-short', { location: 'shortlist' }),
      doc('d-arch', { location: 'archive' }),
      doc('d-feed', { location: 'feed' }),
      doc('d-child', { location: 'new', parent_id: 'd-new' })
    ]

    const { result, events } = await sync()

    expect(result).toMatchObject({ documents: 4, failed: 0, added: 0 })
    expect(events.filter((e) => e.result === 'created')).toHaveLength(4)
    expect(
      reader.requests.map((u) => u.searchParams.get('location')).filter((l) => l === 'feed')
    ).toEqual([])
    const files = markdownFiles().filter((file) => file.includes('Readwise/Reader/'))
    expect(files).toHaveLength(4)
    const note = await noteOf('d-new')
    expect(note.title).toBe('Fresh read')
    expect(note.path).toMatch(/^Readwise\/Reader\//)
    expect(note.frontmatter).toMatchObject({
      author: 'Jane Writer',
      site_name: 'Example Site',
      word_count: 1200,
      published_date: '2026-09-30',
      source_url: 'https://example.com/d-new',
      readwise_url: 'https://read.readwise.io/read/d-new'
    })
    expect(note.frontmatter).not.toHaveProperty('location')
    expect(note.frontmatter).not.toHaveProperty('reading_progress')
    expect(note.tags).toContain('ai')
    expect(readSection(note.content)).toMatchObject({ found: true, untouched: true })
    expect(note.content).not.toContain('Full article text')
    expect(links.getLinkByReaderDocumentId(db(), 'd-feed')).toBeUndefined()
  })

  it('a second run is a no-op: no writes, no new notes, same files', async () => {
    readerOn()
    reader.documents = [
      doc('d1'),
      doc('d2', { location: 'archive' }),
      doc('d3', { location: 'later' })
    ]
    await sync()
    const files = markdownFiles()
    resetWrites()

    const { result } = await sync()

    expect(result).toMatchObject({ documents: 0, failed: 0 })
    expect(writes()).toBe(0)
    expect(markdownFiles()).toEqual(files)
    expect(state.getReaderCursor(db())).not.toBeNull()
  })

  it('a document that also has a v2 book is one note, in the v2 folder, with its highlights', async () => {
    readerOn()
    reader.documents = [doc('d-hl', { title: 'Highlighted' }), doc('d-plain', { title: 'Plain' })]
    readwise.books = [
      stubBook(7, {
        title: 'Highlighted',
        readable_title: 'Highlighted',
        category: 'articles',
        source: 'reader',
        external_id: 'd-hl',
        highlights: [hl(71, 10, 1, 'A line worth keeping')]
      })
    ]

    const { result } = await sync()

    expect(result).toMatchObject({ added: 1, documents: 1 })
    const files = markdownFiles().filter((file) => file.startsWith('Readwise/'))
    expect(files.filter((file) => file.includes('Highlighted'))).toHaveLength(1)
    expect(files.filter((file) => file.includes('Plain'))).toHaveLength(1)
    const bookNote = (await notes.getNoteById(links.getLinkByBookId(db(), 7)!.noteId))!
    expect(bookNote.path).toMatch(/^Readwise\/Articles\//)
    expect(bookNote.content).toContain('A line worth keeping')
    expect(links.getLinkByReaderDocumentId(db(), 'd-hl')?.noteId).toBe(bookNote.id)
    expect(links.getLinkByReaderDocumentId(db(), 'd-plain')?.readwiseBookId).toBeNull()

    resetWrites()
    await sync()
    expect(writes()).toBe(0)
  })

  it('a document saved first and highlighted later keeps its Reader note and gets the highlights there', async () => {
    readerOn()
    reader.documents = [doc('d-late', { title: 'Late' })]
    await sync()
    const before = await noteOf('d-late')
    expect(before.path).toMatch(/^Readwise\/Reader\//)

    // The user highlights it in Reader: v2 now has the book, with the document id.
    reader.documents[0].updated_at = t(5)
    state.setCursor(db(), '2026-10-02T00:00:00.000Z')
    readwise.books = [
      stubBook(9, {
        title: 'Late',
        readable_title: 'Late',
        category: 'articles',
        source: 'reader',
        external_id: 'd-late',
        highlights: [hl(91, 10, 5, 'Now highlighted')]
      })
    ]
    const { result } = await sync()

    const files = markdownFiles().filter((file) => file.includes('Late'))
    expect(files).toHaveLength(1)
    const after = (await notes.getNoteById(before.id))!
    expect(after.path).toBe(before.path)
    expect(after.content).toContain('Now highlighted')
    expect(result).toMatchObject({ failed: 0 })
    expect(links.getLinkByBookId(db(), 9)).toMatchObject({
      noteId: before.id,
      readerDocumentId: 'd-late'
    })
  })

  it('a book note an older build wrote, with no document id on its link, is not duplicated', async () => {
    readwise.books = [
      stubBook(3, {
        title: 'Older',
        readable_title: 'Older',
        category: 'articles',
        source: 'reader',
        external_id: 'd-old',
        highlights: [hl(31, 10, 1)]
      })
    ]
    await sync()
    // The older build never stored the document id.
    dataDb.sqlite.prepare('UPDATE readwise_links SET reader_document_id = NULL').run()
    reader.documents = [doc('d-old', { title: 'Older', updated_at: t(9) })]
    readerOn()

    await sync()

    expect(markdownFiles().filter((file) => file.includes('Older'))).toHaveLength(1)
    expect(links.getLinkByReaderDocumentId(db(), 'd-old')?.readwiseBookId).toBe(3)
  })

  it('a book of a category switched off still tells its document is covered, so a later update makes no Reader note', async () => {
    readwise.books = [
      stubBook(4, {
        title: 'Muted',
        category: 'articles',
        source: 'reader',
        external_id: 'd-muted',
        highlights: [hl(41, 10, 1)]
      })
    ]
    settings.writeReadwiseOptions(db(), { categories: { articles: false } })
    await sync()
    // The book was skipped, but its link-less state must not let the document through later.
    readerOn()
    reader.documents = [doc('d-muted', { updated_at: t(9) })]
    await sync()
    state.setReaderCursor(db(), '2026-10-02T00:00:00.000Z')
    state.setCursor(db(), '2026-10-02T00:00:00.000Z')
    state.setFullPassPending(db(), false)
    state.setLastFullRead(db(), new Date().toISOString())
    await sync()

    expect(markdownFiles().filter((file) => file.includes('Muted'))).toEqual([])
  })

  it('full text is written once below the section and never touched again; images are saved', async () => {
    readerOn(true)
    reader.documents = [
      doc('d-ft', {
        title: 'Long read',
        image_url: COVER,
        html_content: '<p>Original paragraph.</p>'
      }),
      doc('d-podcast', { title: 'Podcast', category: 'rss', image_url: COVER, location: 'later' })
    ]
    await sync()

    const created = await noteOf('d-ft')
    const section = readSection(created.content)
    expect(section.found).toBe(true)
    expect(created.content.indexOf('Original paragraph.')).toBeGreaterThan(
      created.content.indexOf('readwise:end')
    )
    // An article's image is the cover; no remote URL reaches the body.
    expect(String(created.frontmatter.cover)).toMatch(/attachments\/.+\/rw-[0-9a-f]{16}\.png$/)
    expect(created.content).not.toContain(COVER)
    const small = await noteOf('d-podcast')
    expect(small.content).toMatch(/!\[\]\(.*attachments\/.+\/rw-/)
    expect(small.frontmatter).not.toHaveProperty('cover')

    // Reader changes the text and the user edits the note: neither is written again.
    reader.documents[0].html_content = '<p>Rewritten upstream.</p>'
    reader.documents[0].updated_at = t(8)
    await notes.updateNote({ id: created.id, content: `${created.content}\n\nMy own line.` })
    resetWrites()
    await sync()
    const later = await noteOf('d-ft')
    expect(later.content).toContain('Original paragraph.')
    expect(later.content).toContain('My own line.')
    expect(later.content).not.toContain('Rewritten upstream.')
    expect(writes()).toBe(0)
  })

  describe('inline images and captions (D14)', () => {
    const SHOT = 'https://cdn.example.com/shots/notes.webp'
    const BARE = 'https://cdn.example.com/shots/bare.jpg'
    const LAZY = 'https://cdn.example.com/shots/lazy.png'
    const SET = 'https://cdn.example.com/shots/set-1100.webp'
    const BROKEN = 'https://cdn.example.com/shots/broken.png'
    const HTML = [
      '<p>Intro.</p>',
      `<figure><img alt="Notes in app" src="${SHOT}"><figcaption>Notes in <em>MemryNote</em> &amp; more</figcaption></figure>`,
      `<p>Between.</p><img alt="A bare image" src="${BARE}">`,
      `<img src="data:image/gif;base64,R0lGOD" data-src="${LAZY}" alt="lazy">`,
      `<picture><source srcset="${SET} 1100w, https://cdn.example.com/shots/set-400.webp 400w"><img alt="picture"></picture>`,
      `<figure><img alt="gone" src="${BROKEN}"><figcaption>Lost caption</figcaption></figure>`,
      '<p>Outro.</p>'
    ].join('\n')

    const stem = (url: string) => imageFileStem(url)
    const attachmentNames = async (noteId: string) =>
      (await attachments.listNoteAttachments(noteId)).map((file) => file.filename).sort()

    async function importArticle() {
      mocks.imageFetch.mockImplementation(async (url: string) => {
        if (url === BROKEN) throw new Error('offline')
        return {
          ok: true,
          status: 200,
          headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
          arrayBuffer: async () => PNG
        }
      })
      readerOn(true)
      reader.documents = [doc('d-img', { title: 'Pictures', image_url: COVER, html_content: HTML })]
      await sync()
      return noteOf('d-img')
    }

    it('saves every article image into the vault and writes it where the editor reads it', async () => {
      const note = await importArticle()

      const names = await attachmentNames(note.id)
      expect(names).toEqual([COVER, SHOT, BARE, LAZY, SET].map((url) => `${stem(url)}.png`).sort())
      const ref = (url: string) => `../../attachments/${note.id}/${stem(url)}.png`
      expect(note.content).toContain(
        `<figure><img src="${ref(SHOT)}"><figcaption>Notes in MemryNote &amp; more</figcaption></figure>`
      )
      expect(note.content).toContain(`![A bare image](${ref(BARE)})`)
      expect(note.content).toContain(`![lazy](${ref(LAZY)})`)
      expect(note.content).toContain(`![picture](${ref(SET)})`)
      expect(note.content).toContain('Intro.')
      expect(note.content).toContain('Outro.')
    })

    it('leaves a failed image out with its caption, and no remote URL in the note', async () => {
      const note = await importArticle()

      expect(note.content).not.toContain('cdn.example.com')
      expect(note.content).not.toContain('Lost caption')
      expect(note.content).not.toContain('data:image')
      expect(String(note.frontmatter.cover)).toContain(stem(COVER))
    })

    it('is a no-op on the next run and downloads nothing again', async () => {
      await importArticle()
      reader.documents[0].updated_at = t(8)
      resetWrites()
      mocks.imageFetch.mockClear()

      await sync()

      expect(writes()).toBe(0)
      expect(mocks.imageFetch).not.toHaveBeenCalled()
    })

    it('survives the editor round trip byte for byte', async () => {
      const note = await importArticle()
      const converter = await import('../sync/blocknote-converter')
      const { CRDT_FRAGMENT_NAME } = await import('@memry/contracts/ipc-crdt')
      const { writeMarkdownSourceToYDoc } = await import('@memry/shared/markdown-source')
      const Y = await import('yjs')

      let current = note.content
      for (let pass = 0; pass < 2; pass++) {
        const ydoc = new Y.Doc()
        expect(
          await converter.markdownToYFragment(current, ydoc.getXmlFragment(CRDT_FRAGMENT_NAME))
        ).toBe(true)
        writeMarkdownSourceToYDoc(ydoc, null)
        current = (await converter.yDocToMarkdown(ydoc)) as string
      }

      expect(current.trim()).toBe(note.content.trim())
    })
  })

  describe('restoring a Reader-only note (D16)', () => {
    let commands: typeof BookCommandsModule
    const fetchImage = (url: string) => mocks.imageFetch(url)

    async function deleteImportedNote(fullText: boolean) {
      readerOn(fullText)
      reader.documents = [
        doc('d-rs', {
          title: 'Restorable',
          html_content: `<p>Body text.</p><figure><img src="${COVER}" alt="x"><figcaption>Shown caption</figcaption></figure>`
        })
      ]
      await sync()
      const first = await noteOf('d-rs')
      await notes.deleteNote(first.id)
      state.clearRunState(db())
      await sync()
      expect(links.getLinkByReaderDocumentId(db(), 'd-rs')?.state).toBe('note-deleted')
      commands = await import('./book-commands')
      return first
    }

    it('lists the note in Deleted books and restores it with section, text and images', async () => {
      const first = await deleteImportedNote(true)

      expect(await commands.listDeletedBooks()).toEqual([
        expect.objectContaining({
          readwiseBookId: null,
          readerDocumentId: 'd-rs',
          title: 'Restorable'
        })
      ])
      await commands.restoreReaderDocument('d-rs', { fetch: fetchImage })

      const link = links.getLinkByReaderDocumentId(db(), 'd-rs')!
      expect(link.state).toBe('linked')
      const restored = (await notes.getNoteById(link.noteId))!
      expect(readSection(restored.content).found).toBe(true)
      expect(restored.content).toContain('Body text.')
      expect(restored.content).toContain('<figcaption>Shown caption</figcaption>')
      expect(restored.content).toMatch(
        new RegExp(`attachments/${link.noteId}/rw-[0-9a-f]{16}\\.png`)
      )
      expect(restored.content).not.toContain(COVER)
      expect(restored.properties.readwise_url).toBe(first.properties.readwise_url)
      expect(await commands.listDeletedBooks()).toEqual([])
      await expect(commands.restoreReaderDocument('d-rs')).rejects.toThrow(
        'This book is not in the deleted list.'
      )

      // The next run leaves the restored note as it is.
      reader.documents[0].updated_at = t(9)
      resetWrites()
      await sync()
      expect(writes()).toBe(0)
    })

    it('still lists the other rows when one document cannot be read', async () => {
      await deleteImportedNote(false)
      const handle = reader.handle
      reader.handle = async (input: string) =>
        new URL(input).searchParams.has('id') ? new Response('', { status: 500 }) : handle(input)

      expect(await commands.listDeletedBooks()).toEqual([])
      reader.handle = handle
    })

    it('restores only the section when full article text is off', async () => {
      await deleteImportedNote(false)

      await commands.restoreReaderDocument('d-rs', { fetch: fetchImage })

      const restored = await noteOf('d-rs')
      expect(readSection(restored.content).found).toBe(true)
      expect(restored.content).not.toContain('Body text.')
    })
  })

  it('asks for the article HTML only when the full-text switch is on', async () => {
    readerOn(false)
    reader.documents = [doc('d1')]
    await sync()
    expect(reader.requests.every((u) => !u.searchParams.has('withHtmlContent'))).toBe(true)
    expect((await noteOf('d1')).content).not.toContain('Full article text')
  })

  it('turning the switch off stops new notes and deletes none; turning it on again picks up what came meanwhile', async () => {
    readerOn()
    reader.documents = [doc('d1')]
    await sync()
    settings.writeReadwiseOptions(db(), { readerDocuments: false })
    reader.documents.push(doc('d2', { updated_at: t(3) }))
    const asked = listRequests()

    await sync()
    expect(listRequests()).toBe(asked)
    expect(links.getLinkByReaderDocumentId(db(), 'd2')).toBeUndefined()
    expect(links.getLinkByReaderDocumentId(db(), 'd1')).toBeDefined()

    settings.writeReadwiseOptions(db(), { readerDocuments: true })
    await sync()
    expect(links.getLinkByReaderDocumentId(db(), 'd2')).toBeDefined()
    expect(markdownFiles().filter((file) => file.includes('Readwise/Reader/'))).toHaveLength(2)
  })

  it('a document deleted in Reader keeps its note, and a note the user deleted is not made again', async () => {
    readerOn()
    reader.documents = [doc('gone'), doc('kept')]
    await sync()
    const kept = await noteOf('kept')
    const goneNote = await noteOf('gone')
    reader.documents = reader.documents.filter((d) => d.id !== 'gone')
    await notes.deleteNote(kept.id)
    // A full list again, as after a takeover would, so both are seen.
    state.clearRunState(db())

    await sync()
    await sync()

    expect(await notes.getNoteById(goneNote.id)).not.toBeNull()
    expect(markdownFiles().filter((file) => file.includes('Readwise/Reader/'))).toHaveLength(1)
    expect(links.getLinkByReaderDocumentId(db(), 'kept')?.state).toBe('note-deleted')
  })

  it('a failing list leaves the Reader cursor and the v2 work alone, and the next run catches up', async () => {
    readerOn()
    reader.documents = [doc('d1')]
    readwise.books = [stubBook(1, { highlights: [hl(11, 10, 1)] })]
    const original = reader.handle
    reader.handle = async () => new Response('', { status: 500 })

    const { result, events } = await sync()

    expect(result.added).toBe(1)
    expect(events.some((e) => e.result === 'failed')).toBe(true)
    expect(state.getReaderCursor(db())).toBeNull()
    expect(state.getCursor(db())).not.toBeNull()

    reader.handle = original
    await sync()
    expect(links.getLinkByReaderDocumentId(db(), 'd1')).toBeDefined()
  })

  it('the import preview counts the documents without a book, and only with the switch on', async () => {
    reader.documents = [doc('d-has'), doc('d-a'), doc('d-b', { location: 'archive' })]
    readwise.books = [
      stubBook(1, {
        category: 'articles',
        source: 'reader',
        external_id: 'd-has',
        highlights: [hl(11, 10, 1)]
      })
    ]
    const { readwiseImporter } = await import('../import/readwise/readwise-importer')
    const preview = () =>
      readwiseImporter.preview?.(
        { importId: 'p', importerId: 'readwise', sourcePaths: [] } as never,
        new AbortController().signal
      ) as Promise<ImportPreview>

    const off = await preview()
    expect(off.groups.find((g) => g.label === 'reader')).toBeUndefined()
    expect(listRequests()).toBe(0)

    readerOn()
    const on = await preview()
    expect(on.groups.find((g) => g.label === 'reader')?.counts[0].value).toBe(2)
    expect(markdownFiles()).toEqual([])
  })
})
