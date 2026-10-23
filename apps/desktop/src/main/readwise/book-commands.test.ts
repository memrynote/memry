/**
 * The book commands (#1408 D16) through the real writer, the real note owner
 * and a real temp vault and databases. Only the Readwise server (a stateful
 * stub behind `fetch`), the token store, the CRDT feed and the editor-open
 * probe are stand-ins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  markSyncEligible,
  markSyncIneligible,
  resetSyncDecision
} from '@memry/sync-client/sync-eligibility'
import { insertThisDevice } from '@tests/utils/sync-device'
import * as Y from 'yjs'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { planNote, readSection, type NotePlan } from '@memry/importers/readwise'
import { book, highlight, COVER_URL } from '@memry/importers/readwise/fixtures'
import { ReadwiseStub } from '@tests/utils/readwise-stub'
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
import type * as BookCommandsModule from './book-commands'
import type * as NoteWriterModule from './note-writer'
import type * as NotesModule from '../vault/notes'
import type * as LinksRepositoryModule from './links-repository'
import type * as SettingsModule from '../database/queries/settings'
import type * as CrdtProviderModule from '../sync/crdt-provider'

vi.mock('electron', () => {
  const send = vi.fn()
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send } }])
    },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() },
    net: { fetch: vi.fn() }
  }
})
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: vi.fn(() => Promise.resolve()) }))
vi.mock('../notes/runtime-effects', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEffectsModule>()),
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn(),
  emitNoteAttachmentSaved: vi.fn()
}))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => true) }))
vi.mock('../notes/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>()
  return { ...actual, updateNoteCommand: vi.fn(actual.updateNoteCommand) }
})

const secrets = new Map<string, string>()
vi.mock('../secrets/secret-storage', () => ({
  setSecret: vi.fn(async (s: string, a: string, v: string) => void secrets.set(`${s}/${a}`, v)),
  getSecret: vi.fn(async (s: string, a: string) => secrets.get(`${s}/${a}`) ?? null),
  deleteSecret: vi.fn(async (s: string, a: string) => void secrets.delete(`${s}/${a}`))
}))

const PNG = new Uint8Array([137, 80, 78, 71]).buffer
const imageFetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
  arrayBuffer: async () => PNG
})

describe('Readwise book commands (D16)', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let commands: typeof BookCommandsModule
  let writer: typeof NoteWriterModule
  let notes: typeof NotesModule
  let links: typeof LinksRepositoryModule
  let settings: typeof SettingsModule
  let crdtProvider: typeof CrdtProviderModule
  let readwise: ReadwiseStub

  beforeEach(async () => {
    markSyncIneligible()
    vault = createTestVault('readwise-commands')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    secrets.clear()
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
      journalDateFormat: 'yyyy-MM-dd'
    } satisfies VaultConfig)
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db as never)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])

    commands = await import('./book-commands')
    writer = await import('./note-writer')
    notes = await import('../vault/notes')
    links = await import('./links-repository')
    settings = await import('../database/queries/settings')
    crdtProvider = await import('../sync/crdt-provider')
    const { setReadwiseToken } = await import('./secrets')
    await setReadwiseToken(vault.path, 'tok-test')
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

  const db = () => asClientDb(dataDb.db)
  const OPTIONS = {
    root: 'Readwise',
    folderLayout: 'by-category' as const,
    categories: {},
    timeZone: 'UTC'
  }

  /** A sync run's write of a new book, so the note exists the way sync made it. */
  async function synced(source: ReturnType<typeof book>): Promise<string> {
    readwise.books = [source as never]
    const outcome = await writer.upsertReadwiseNote(source, planNote(source, OPTIONS) as NotePlan, {
      planOptions: OPTIONS,
      fetch: imageFetch
    })
    if (outcome.status !== 'created') throw new Error(`expected created, got ${outcome.status}`)
    return outcome.noteId
  }

  const note = async (id: string) => (await notes.getNoteById(id))!

  async function userEdits(noteId: string, edit: (content: string) => string): Promise<void> {
    await notes.updateNote({ id: noteId, content: edit((await note(noteId)).content) })
  }

  const three = () => [highlight(1), highlight(2), highlight(3)]

  describe('re-import', () => {
    it('rewrites a touched section, keeps the text outside it and the properties, and the next sync sees an untouched section', async () => {
      const noteId = await synced(book(1, { highlights: three() }))
      await userEdits(
        noteId,
        (c) => `Mine above.\n\n${c.replace('Highlight 1', 'Highlight 1 my thought')}\n\nMine below.`
      )
      await notes.updateNote({ id: noteId, propertyPatch: { author: 'Me' } } as never)

      readwise.books = [book(1, { highlights: [highlight(1), highlight(4)] }) as never]
      await commands.reimportBook(noteId, { fetch: imageFetch })

      const after = await note(noteId)
      expect(after.content).not.toContain('my thought')
      expect(after.content).toContain('Highlight 4')
      expect(after.content.startsWith('Mine above.')).toBe(true)
      expect(after.content.trimEnd().endsWith('Mine below.')).toBe(true)
      expect(after.properties.author).toBe('Me')
      expect(readSection(after.content)).toMatchObject({ found: true, untouched: true })

      // The next sync rewrites the section instead of appending to it.
      const later = book(1, { highlights: [highlight(4), highlight(5)] })
      const plan = planNote(later, OPTIONS) as NotePlan
      const outcome = await writer.upsertReadwiseNote(later, plan, { planOptions: OPTIONS })
      expect(outcome.status).toBe('updated')
      expect((await note(noteId)).content).not.toContain('Highlight 1')
    })

    it('writes into a note that is open in an editor', async () => {
      const noteId = await synced(book(1, { highlights: [highlight(1)] }))
      vi.spyOn(crdtProvider.getCrdtProvider(), 'getDoc').mockReturnValue(new Y.Doc())

      readwise.books = [book(1, { highlights: three() }) as never]
      await commands.reimportBook(noteId, { fetch: imageFetch })

      expect((await note(noteId)).content).toContain('Highlight 3')
    })

    it('re-imports a book whose category is switched off for sync', async () => {
      const noteId = await synced(book(1, { highlights: [highlight(1)] }))
      settings.setSetting(db(), 'readwise', JSON.stringify({ categories: { books: false } }))

      readwise.books = [book(1, { highlights: three() }) as never]
      await commands.reimportBook(noteId, { fetch: imageFetch })

      expect((await note(noteId)).content).toContain('Highlight 3')
    })

    it('says so when the book is gone from Readwise, and leaves the note alone', async () => {
      const noteId = await synced(book(1, { highlights: three() }))
      const before = (await note(noteId)).content
      readwise.books = []

      await expect(commands.reimportBook(noteId)).rejects.toThrow(
        'This book is no longer in your Readwise library.'
      )
      expect((await note(noteId)).content).toBe(before)
    })
  })

  describe('refresh book info', () => {
    it('writes the Readwise fields, adds a new tag, keeps the title, the path and the user tags', async () => {
      const noteId = await synced(
        book(1, { author: 'Old Author', book_tags: [{ name: 'focus' }], highlights: three() })
      )
      await notes.updateNote({ id: noteId, headerTags: { add: ['mine'] } })
      const before = await note(noteId)

      readwise.books = [
        book(1, {
          title: 'Renamed In Readwise',
          readable_title: 'Renamed In Readwise',
          author: 'New Author',
          source: 'instapaper',
          source_url: 'https://example.com/a',
          book_tags: [{ name: 'focus' }, { name: 'deep' }],
          highlights: three()
        }) as never
      ]
      await commands.refreshBookInfo(noteId, { fetch: imageFetch })

      const after = await note(noteId)
      expect(after.properties).toMatchObject({
        author: 'New Author',
        source: 'instapaper',
        source_url: 'https://example.com/a',
        readwise_url: 'https://readwise.io/bookreview/1'
      })
      expect(after.headerTags).toEqual(expect.arrayContaining(['focus', 'mine', 'deep']))
      expect(after.title).toBe(before.title)
      expect(after.path).toBe(before.path)
      expect(after.content).toBe(before.content)
    })

    it('removes no tag when Readwise dropped it, and keeps a field Readwise has no value for', async () => {
      const noteId = await synced(book(1, { book_tags: [{ name: 'focus' }], highlights: three() }))
      readwise.books = [book(1, { author: '', book_tags: [], highlights: three() }) as never]

      await commands.refreshBookInfo(noteId, { fetch: imageFetch })

      const after = await note(noteId)
      expect(after.headerTags).toContain('focus')
      expect(after.properties.author).toBe('Cal Newport')
    })

    it("saves an article's cover into the vault and sets the note's cover", async () => {
      const noteId = await synced(book(1, { category: 'articles', highlights: three() }))
      expect((await note(noteId)).frontmatter.cover).toBeUndefined()

      readwise.books = [
        book(1, { category: 'articles', cover_image_url: COVER_URL, highlights: three() }) as never
      ]
      await commands.refreshBookInfo(noteId, { fetch: imageFetch })

      expect((await note(noteId)).frontmatter.cover).toMatch(/attachments\/.+rw-/)
    })
  })

  describe('restore (D16)', () => {
    it('lists a deleted book with its title and live highlight count, and restores the note once', async () => {
      const source = book(1, { highlights: [...three(), highlight(9, { is_deleted: true })] })
      const noteId = await synced(source)
      await notes.deleteNote(noteId)
      await writer.upsertReadwiseNote(source, planNote(source, OPTIONS) as NotePlan, {
        planOptions: OPTIONS
      })
      expect(links.getLinkByBookId(db(), 1)?.state).toBe('note-deleted')

      expect(await commands.listDeletedBooks()).toEqual([
        expect.objectContaining({ readwiseBookId: 1, title: 'Book 1', highlightCount: 3 })
      ])

      await commands.restoreBook(1, { fetch: imageFetch })
      const link = links.getLinkByBookId(db(), 1)!
      expect(link.state).toBe('linked')
      const restored = await note(link.noteId)
      expect(restored.path).toBe('Readwise/Books/Book 1.md')
      expect(restored.content).toContain('Highlight 3')
      expect(restored.properties.readwise_url).toBe('https://readwise.io/bookreview/1')

      await expect(commands.restoreBook(1)).rejects.toThrow('This book is not in the deleted list.')
      expect(await commands.listDeletedBooks()).toEqual([])
      const copies = indexDb.db
        .select()
        .from(noteCache)
        .all()
        .filter((row) => row.path.startsWith('Readwise/'))
      expect(copies).toHaveLength(1)
    })

    it('adopts a note that already names the book instead of creating a second one', async () => {
      const source = book(1, { highlights: three() })
      const noteId = await synced(source)
      links.markLinkState(db(), { readwiseBookId: 1 }, 'note-deleted')

      await commands.restoreBook(1, { fetch: imageFetch })

      expect(links.getLinkByBookId(db(), 1)).toMatchObject({ noteId, state: 'linked' })
    })
  })

  describe('a device that does not pull', () => {
    it('refuses every command in main', async () => {
      const source = book(1, { highlights: three() })
      const noteId = await synced(source)
      links.markLinkState(db(), { readwiseBookId: 1 }, 'note-deleted')
      settings.setSetting(db(), 'readwise', JSON.stringify({ syncDeviceId: 'other-device' }))
      insertThisDevice(db())
      markSyncEligible()
      const before = readwise.requests.length

      await expect(commands.reimportBook(noteId)).rejects.toThrow(/another device/)
      await expect(commands.refreshBookInfo(noteId)).rejects.toThrow(/another device/)
      await expect(commands.listDeletedBooks()).rejects.toThrow(/another device/)
      await expect(commands.restoreBook(1)).rejects.toThrow(/another device/)
      expect(readwise.requests.length).toBe(before)
    })
  })
})
