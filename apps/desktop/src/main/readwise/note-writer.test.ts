/**
 * The Readwise note writer against a real temp vault, real databases, the real
 * note owner (`createNote` / `updateNoteCommand`) and the real attachment
 * store. Only the network (image `fetch`), the CRDT feed, and the editor-open
 * probe are stand-ins. A test that bypassed `updateNoteCommand` would prove
 * nothing about the CRDT trap this writer exists to avoid (D6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import {
  planNote,
  readSection,
  type NotePlan,
  type PlanNoteOptions,
  type ReadwiseBook
} from '@memry/importers/readwise'
import { readwiseLinks } from '@memry/db-schema/schema/readwise-links'
import { book, highlight, COVER_URL } from '@memry/importers/readwise/fixtures'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig, VaultStatus } from '@memry/contracts/vault-api'
import {
  startProjectionRuntime,
  stopProjectionRuntime,
  flushProjectionEvents
} from '../projections'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'

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
  ...(await importOriginal<typeof import('../notes/runtime-effects')>()),
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn(),
  emitNoteAttachmentSaved: vi.fn()
}))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn(async () => true) }))
vi.mock('../notes/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../notes/domain')>()
  return { ...actual, updateNoteCommand: vi.fn(actual.updateNoteCommand) }
})

const PLAN_OPTIONS: PlanNoteOptions = {
  root: 'Readwise',
  folderLayout: 'by-category',
  categories: {},
  timeZone: 'UTC'
}

const PNG = new Uint8Array([137, 80, 78, 71]).buffer

describe('upsertReadwiseNote', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let writer: typeof import('./note-writer')
  let domain: typeof import('../notes/domain')
  let notes: typeof import('../vault/notes')
  let links: typeof import('./links-repository')
  let state: typeof import('./sync-state')
  let crdtProvider: typeof import('../sync/crdt-provider')
  let converter: typeof import('../sync/blocknote-converter')
  let fetchCalls: string[]
  let failingUrls: Set<string>

  const fetchImage = async (url: string) => {
    fetchCalls.push(url)
    if (failingUrls.has(url)) throw new Error('offline')
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG
    }
  }

  beforeEach(async () => {
    vault = createTestVault('readwise-writer')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    fetchCalls = []
    failingUrls = new Set()

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

    writer = await import('./note-writer')
    domain = await import('../notes/domain')
    notes = await import('../vault/notes')
    links = await import('./links-repository')
    state = await import('./sync-state')
    crdtProvider = await import('../sync/crdt-provider')
    converter = await import('../sync/blocknote-converter')
    vi.mocked(domain.updateNoteCommand).mockClear()
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  const sync = (source: ReadwiseBook, over: { reset?: boolean; userInitiated?: boolean } = {}) => {
    const plan = planNote(source, PLAN_OPTIONS) as NotePlan
    return writer.upsertReadwiseNote(source, plan, {
      ...over,
      planOptions: PLAN_OPTIONS,
      fetch: fetchImage
    })
  }

  const db = () => asClientDb(dataDb.db)

  const writes = () => vi.mocked(domain.updateNoteCommand).mock.calls.length

  async function created(source: ReadwiseBook): Promise<string> {
    const outcome = await sync(source)
    if (outcome.status !== 'created') throw new Error(`expected created, got ${outcome.status}`)
    return outcome.noteId
  }

  async function body(noteId: string): Promise<string> {
    return (await notes.getNoteById(noteId))!.content
  }

  /** The user types in the editor: the owner writes the file, not the Readwise writer. */
  async function userEdits(noteId: string, edit: (content: string) => string): Promise<void> {
    await notes.updateNote({ id: noteId, content: edit(await body(noteId)) })
    vi.mocked(domain.updateNoteCommand).mockClear()
  }

  const threeHighlights = () => [highlight(1), highlight(2), highlight(3)]

  it('creates the note in its category folder with frontmatter and the sealed section', async () => {
    const source = book(1, {
      author: 'Cal Newport',
      book_tags: [{ name: 'focus' }],
      highlights: threeHighlights()
    })
    const noteId = await created(source)
    const note = (await notes.getNoteById(noteId))!

    expect(note.path).toBe('Readwise/Books/Book 1.md')
    expect(note.properties).toMatchObject({
      author: 'Cal Newport',
      readwise_url: 'https://readwise.io/bookreview/1'
    })
    expect(note.tags).toContain('focus')
    expect(readSection(note.content)).toMatchObject({ found: true, untouched: true })
    expect(links.getLinkByBookId(db(), 1)).toMatchObject({ noteId, state: 'linked' })
  })

  it("keeps the user's text above and below an untouched section through three syncs", async () => {
    const noteId = await created(book(1, { highlights: [highlight(1)] }))
    await userEdits(noteId, (content) => `Above.\n\n${content}\n\nBelow.`)

    for (const n of [2, 3, 4]) {
      const outcome = await sync(
        book(1, { highlights: threeHighlights().concat(highlight(n + 5)) })
      )
      expect(outcome.status).toBe('updated')
    }
    const content = await body(noteId)
    expect(content.startsWith('Above.\n\n<!-- readwise:start -->')).toBe(true)
    expect(content.trimEnd().endsWith('\n\nBelow.')).toBe(true)
    expect(readSection(content)).toMatchObject({ found: true, untouched: true })
  })

  it('rewrites an untouched section: a deleted highlight leaves and a new one lands in location order', async () => {
    const noteId = await created(book(1, { highlights: threeHighlights() }))
    const next = book(1, {
      highlights: [
        highlight(1),
        highlight(2, { is_deleted: true }),
        highlight(3),
        highlight(4, { location: 15 })
      ]
    })

    expect((await sync(next)).status).toBe('updated')
    const content = await body(noteId)
    expect(content).not.toContain('Highlight 2')
    expect(content.indexOf('Highlight 1')).toBeLessThan(content.indexOf('Highlight 4'))
    expect(content.indexOf('Highlight 4')).toBeLessThan(content.indexOf('Highlight 3'))
  })

  it('only appends once the user edited inside the section, and keeps that text through three syncs', async () => {
    const noteId = await created(book(1, { highlights: threeHighlights() }))
    await userEdits(noteId, (content) =>
      content.replace('Highlight 1', 'Highlight 1 and my own thought')
    )

    const synced = [
      book(1, {
        highlights: [...threeHighlights(), highlight(4, { created_at: '2030-01-01T08:00:00Z' })]
      }),
      book(1, {
        highlights: [
          ...threeHighlights(),
          highlight(4, { created_at: '2030-01-01T08:00:00Z' }),
          highlight(5, { created_at: '2030-01-02T08:00:00Z' })
        ]
      }),
      book(1, {
        highlights: [
          ...threeHighlights(),
          highlight(4, { created_at: '2030-01-01T08:00:00Z' }),
          highlight(5, { created_at: '2030-01-02T08:00:00Z' })
        ]
      })
    ]
    const statuses: string[] = []
    for (const source of synced) statuses.push((await sync(source)).status)

    expect(statuses).toEqual(['appended', 'appended', 'unchanged'])
    const content = await body(noteId)
    expect(content).toContain('Highlight 1 and my own thought')
    expect(content.match(/readwise\.io\/open\/4\)/g)).toHaveLength(1)
    expect(content.match(/readwise\.io\/open\/5\)/g)).toHaveLength(1)
    expect(content.match(/<!-- readwise:start -->/g)).toHaveLength(1)
    expect(content.match(/<!-- readwise:end /g)).toHaveLength(1)
    expect(readSection(content)).toMatchObject({ found: true, untouched: false })
  })

  it('leaves edited and deleted highlights alone in a touched section, and never re-adds one the user removed', async () => {
    const early = '2026-10-20T08:00:00Z'
    const noteId = await created(
      book(1, {
        highlights: [
          highlight(1, { created_at: early }),
          highlight(2, { created_at: early }),
          highlight(3)
        ]
      })
    )
    await userEdits(noteId, (content) =>
      content
        .split('\n')
        .filter((line) => !line.includes('Highlight 2'))
        .join('\n')
    )

    const outcome = await sync(
      book(1, {
        highlights: [
          highlight(1, { text: 'Highlight 1 edited in Readwise', created_at: early }),
          highlight(2, { created_at: early }),
          highlight(3, { is_deleted: true }),
          highlight(4, { created_at: '2030-01-01T08:00:00Z' })
        ]
      })
    )

    expect(outcome.status).toBe('appended')
    const content = await body(noteId)
    expect(content).toContain('Highlight 4')
    expect(content).toContain('Highlight 1 ')
    expect(content).not.toContain('edited in Readwise')
    expect(content).toContain('Highlight 3')
    expect(content).not.toContain('Highlight 2')
  })

  it('appends once and writes a new end marker when the user deleted the end marker', async () => {
    const noteId = await created(book(1, { highlights: threeHighlights() }))
    await userEdits(noteId, (content) => content.replace(/<!-- readwise:end[^>]*-->/, ''))
    const next = book(1, {
      highlights: [...threeHighlights(), highlight(4, { created_at: '2030-01-01T08:00:00Z' })]
    })

    expect((await sync(next)).status).toBe('appended')
    const content = await body(noteId)
    expect(content.match(/<!-- readwise:start -->/g)).toHaveLength(1)
    expect(content.match(/<!-- readwise:end /g)).toHaveLength(1)
    expect(content.match(/readwise\.io\/open\/4\)/g)).toHaveLength(1)
    expect(content.match(/readwise\.io\/open\/1\)/g)).toHaveLength(1)
    expect(content.trimEnd().endsWith('-->')).toBe(true)
    expect(readSection(content)).toMatchObject({ found: true, untouched: false })

    expect((await sync(next)).status).toBe('unchanged')
  })

  it('appends without a second copy when both markers are gone', async () => {
    const noteId = await created(book(1, { highlights: threeHighlights() }))
    await userEdits(noteId, (content) => content.replace(/<!-- readwise:[^>]*-->/g, ''))
    const next = book(1, {
      highlights: [...threeHighlights(), highlight(4, { created_at: '2030-01-01T08:00:00Z' })]
    })

    expect((await sync(next)).status).toBe('appended')
    expect((await sync(next)).status).toBe('unchanged')
    const content = await body(noteId)
    expect(content.match(/readwise\.io\/open\/1\)/g)).toHaveLength(1)
    expect(content.match(/readwise\.io\/open\/4\)/g)).toHaveLength(1)
  })

  it('appends to a note whose start marker is gone, before the end marker', async () => {
    const noteId = await created(book(1, { highlights: threeHighlights() }))
    await userEdits(noteId, (content) => content.replace('<!-- readwise:start -->', ''))
    const next = book(1, {
      highlights: [...threeHighlights(), highlight(4, { created_at: '2030-01-01T08:00:00Z' })]
    })

    expect((await sync(next)).status).toBe('appended')
    const content = await body(noteId)
    expect(content.indexOf('open/4)')).toBeLessThan(content.indexOf('<!-- readwise:end'))
    expect(content.match(/readwise\.io\/open\/1\)/g)).toHaveLength(1)
  })

  describe('a highlight the user removed stays removed (D5)', () => {
    const at = (day: number) => `2030-01-0${day}T08:00:00.123456Z`
    const dated = () => [
      highlight(1, { created_at: at(1) }),
      highlight(2, { created_at: at(2) }),
      highlight(3, { created_at: at(3) })
    ]
    const dropHighlight = (n: number) => (content: string) =>
      content
        .split('\n')
        .filter((line) => !line.includes(`Highlight ${n} `))
        .join('\n')

    it('does not bring back the newest highlight after the user deleted it', async () => {
      const noteId = await created(book(1, { highlights: dated() }))
      await userEdits(noteId, dropHighlight(3))

      expect((await sync(book(1, { highlights: dated() }))).status).toBe('unchanged')
      expect((await sync(book(1, { highlights: dated() }))).status).toBe('unchanged')
      expect(await body(noteId)).not.toContain('open/3)')
      expect(writes()).toBe(0)
    })

    it('keeps the newest one gone after an append moved last, and still appends a later highlight once', async () => {
      const noteId = await created(book(1, { highlights: dated() }))
      await userEdits(noteId, dropHighlight(3))
      const later = [...dated(), highlight(4, { created_at: at(4) })]

      expect((await sync(book(1, { highlights: later }))).status).toBe('appended')
      expect((await sync(book(1, { highlights: later }))).status).toBe('unchanged')
      await userEdits(noteId, dropHighlight(4))
      expect((await sync(book(1, { highlights: later }))).status).toBe('unchanged')
      const content = await body(noteId)
      expect(content).not.toContain('open/3)')
      expect(content).not.toContain('open/4)')
      expect(content.match(/open\/2\)/g)).toHaveLength(1)
    })

    it('appends two new highlights with the same created_at together, and neither returns once removed', async () => {
      const noteId = await created(book(1, { highlights: dated() }))
      await userEdits(noteId, (content) => content.replace('Highlight 1 ', 'Highlight 1 mine '))
      const both = [
        ...dated(),
        highlight(4, { created_at: at(5) }),
        highlight(5, { created_at: at(5) })
      ]

      expect((await sync(book(1, { highlights: both }))).status).toBe('appended')
      const content = await body(noteId)
      expect(content.match(/open\/4\)/g)).toHaveLength(1)
      expect(content.match(/open\/5\)/g)).toHaveLength(1)
      await userEdits(noteId, dropHighlight(5))
      expect((await sync(book(1, { highlights: both }))).status).toBe('unchanged')
      expect(await body(noteId)).not.toContain('open/5)')
    })

    it('without a usable last, never appends a highlight older than the newest one the note links', async () => {
      const noteId = await created(book(1, { highlights: dated() }))
      await userEdits(noteId, (content) =>
        dropHighlight(2)(content.replace(/<!-- readwise:end v1/, '<!-- readwise:end v2'))
      )
      const later = [...dated(), highlight(4, { created_at: at(4) })]

      expect((await sync(book(1, { highlights: later }))).status).toBe('appended')
      const content = await body(noteId)
      expect(content).not.toContain('open/2)')
      expect(content.match(/open\/4\)/g)).toHaveLength(1)
      expect(content).toContain('<!-- readwise:end v2')
    })

    it('reads a section the old rule wrote (last equals the newest created_at) and appends a later highlight once', async () => {
      const noteId = await created(book(1, { highlights: dated() }))
      await userEdits(noteId, (content) =>
        content
          .replace(/last=\S+/, 'last=2030-01-03T08:00:00.123Z')
          .replace('Highlight 1 ', 'Highlight 1 mine ')
      )
      const later = [...dated(), highlight(4, { created_at: at(4) })]

      expect((await sync(book(1, { highlights: later }))).status).toBe('appended')
      expect((await sync(book(1, { highlights: later }))).status).toBe('unchanged')
      const content = await body(noteId)
      expect(content.match(/open\/4\)/g)).toHaveLength(1)
      expect(content.match(/open\/3\)/g)).toHaveLength(1)
      expect(content).toContain('last=2030-01-04T08:00:00.124Z')
    })
  })

  it('makes zero writes for unchanged input', async () => {
    const source = book(1, { highlights: threeHighlights() })
    await created(source)
    vi.mocked(domain.updateNoteCommand).mockClear()

    expect((await sync(source)).status).toBe('unchanged')
    expect((await sync(source)).status).toBe('unchanged')
    expect(writes()).toBe(0)
  })

  it('does not recreate a note the user deleted', async () => {
    const source = book(1, { highlights: threeHighlights() })
    const noteId = await created(source)
    await notes.deleteNote(noteId)

    expect(await sync(source)).toEqual({ status: 'skipped', reason: 'note-deleted' })
    expect(links.getLinkByBookId(db(), 1)?.state).toBe('note-deleted')
    expect(await sync(source)).toEqual({ status: 'skipped', reason: 'note-deleted' })
    expect(fs.existsSync(path.join(vault.path, 'Readwise/Books/Book 1.md'))).toBe(false)
  })

  it('does nothing for a book whose link is source-deleted', async () => {
    const source = book(1, { highlights: threeHighlights() })
    const noteId = await created(source)
    links.markLinkState(db(), { noteId }, 'source-deleted')

    expect(await sync(book(1, { highlights: [highlight(9)] }))).toEqual({
      status: 'skipped',
      reason: 'source-deleted'
    })
    expect(writes()).toBe(0)
  })

  it('skips a note that is open in an editor, lists it for retry, and writes it once it closes', async () => {
    const noteId = await created(book(1, { highlights: [highlight(1)] }))
    const next = book(1, { highlights: threeHighlights() })
    const getDoc = vi.spyOn(crdtProvider.getCrdtProvider(), 'getDoc').mockReturnValue(new Y.Doc())

    expect(await sync(next)).toEqual({ status: 'skipped', reason: 'busy', noteId })
    expect(writes()).toBe(0)
    expect(state.getRetryList(db()).map((e) => e.readwiseBookId)).toEqual([1])

    getDoc.mockReturnValue(undefined)
    expect((await sync(next)).status).toBe('updated')
    expect(state.getRetryList(db())).toEqual([])
  })

  it('writes into an open note when the user started the command', async () => {
    await created(book(1, { highlights: [highlight(1)] }))
    vi.spyOn(crdtProvider.getCrdtProvider(), 'getDoc').mockReturnValue(new Y.Doc())

    const outcome = await sync(book(1, { highlights: threeHighlights() }), { userInitiated: true })
    expect(outcome.status).toBe('updated')
  })

  it('never writes frontmatter after creation, so a key the user edited survives', async () => {
    const noteId = await created(book(1, { author: 'Cal Newport', highlights: [highlight(1)] }))
    await domain.updateNoteCommand({ id: noteId, propertyPatch: { author: 'Someone Else' } })
    vi.mocked(domain.updateNoteCommand).mockClear()

    await sync(book(1, { author: 'Changed In Readwise', highlights: threeHighlights() }))
    await sync(
      book(1, { author: 'Changed Again', highlights: [...threeHighlights(), highlight(4)] })
    )

    expect((await notes.getNoteById(noteId))!.properties.author).toBe('Someone Else')
    for (const [input] of vi.mocked(domain.updateNoteCommand).mock.calls) {
      expect(Object.keys(input).sort()).toEqual(['content', 'id', 'ignoreInlineTags'])
    }
  })

  it('feeds the new body to the note CRDT on a write, and nothing on a no-op', async () => {
    const { feedExternalEditToCrdt } = await import('../sync/crdt-external-feed')
    const feed = vi.mocked(feedExternalEditToCrdt)
    const source = book(1, { highlights: [highlight(1)] })
    const noteId = await created(source)
    feed.mockClear()

    expect((await sync(book(1, { highlights: threeHighlights() }))).status).toBe('updated')
    expect(feed).toHaveBeenCalledTimes(1)
    expect(feed).toHaveBeenCalledWith(noteId, await body(noteId))

    feed.mockClear()
    await sync(book(1, { highlights: threeHighlights() }))
    expect(feed).not.toHaveBeenCalled()
  })

  it('skips a note that took a network update moments ago', async () => {
    const noteId = await created(book(1, { highlights: [highlight(1)] }))
    const { recordNetworkUpdate } = await import('../sync/crdt-writeback')
    recordNetworkUpdate(noteId)

    expect(await sync(book(1, { highlights: threeHighlights() }))).toEqual({
      status: 'skipped',
      reason: 'busy',
      noteId
    })
    expect(writes()).toBe(0)
  })

  it('reports an unchanged book as unchanged even while its note is open', async () => {
    const source = book(1, { highlights: threeHighlights() })
    await created(source)
    vi.spyOn(crdtProvider.getCrdtProvider(), 'getDoc').mockReturnValue(new Y.Doc())

    expect((await sync(source)).status).toBe('unchanged')
    expect(state.getRetryList(db())).toEqual([])
  })

  it('does not write over text the user typed while images were downloading', async () => {
    const noteId = await created(book(1, { category: 'books', highlights: [highlight(1)] }))
    const slowFetch = async (url: string) => {
      await userEdits(noteId, (content) => `${content}\n\nTyped during the download.`)
      return fetchImage(url)
    }
    const next = book(1, {
      category: 'books',
      cover_image_url: COVER_URL,
      highlights: [highlight(1)]
    })
    const outcome = await writer.upsertReadwiseNote(
      next,
      planNote(next, PLAN_OPTIONS) as NotePlan,
      {
        planOptions: PLAN_OPTIONS,
        fetch: slowFetch
      }
    )

    expect(outcome).toEqual({ status: 'skipped', reason: 'busy', noteId })
    expect(await body(noteId)).toContain('Typed during the download.')
    expect(state.getRetryList(db()).map((entry) => entry.readwiseBookId)).toEqual([1])
  })

  it("keeps highlight tags out of the frontmatter tags, and a removed one never strips the user's", async () => {
    const noteId = await created(book(1, { highlights: [highlight(1)] }))
    await domain.updateNoteCommand({ id: noteId, headerTags: { add: ['focus'] } })

    await sync(book(1, { highlights: [highlight(1, { tags: [{ name: 'other' }] })] }))
    expect((await notes.getNoteById(noteId))!.headerTags).toEqual(['focus'])
    await sync(book(1, { highlights: [highlight(1)] }))
    expect((await notes.getNoteById(noteId))!.headerTags).toEqual(['focus'])
  })

  it('appends once to a note with a duplicated start marker, and then settles', async () => {
    const noteId = await created(book(1, { highlights: threeHighlights() }))
    await userEdits(noteId, (content) => `<!-- readwise:start -->\n\n${content}`)
    const next = book(1, {
      highlights: [...threeHighlights(), highlight(4, { created_at: '2030-01-01T08:00:00Z' })]
    })

    expect((await sync(next)).status).toBe('appended')
    expect((await sync(next)).status).toBe('unchanged')
    expect((await body(noteId)).match(/readwise\.io\/open\/4\)/g)).toHaveLength(1)
  })

  it('creates one note when two runs write the same new book at once', async () => {
    const source = book(1, { highlights: threeHighlights() })
    const outcomes = await Promise.all([sync(source), sync(source)])

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['created', 'unchanged'])
    expect(fs.readdirSync(path.join(vault.path, 'Readwise', 'Books'))).toHaveLength(1)
  })

  it('does not mark a note deleted while the vault is still indexing', async () => {
    const noteId = await created(book(1, { highlights: [highlight(1)] }))
    const vaultIndex = await import('../vault/index')
    vi.mocked(vaultIndex.getStatus).mockReturnValue({
      isOpen: true,
      path: vault.path,
      isIndexing: true,
      indexProgress: 10,
      error: null
    })
    vi.spyOn(notes, 'getNoteById').mockResolvedValue(null)

    const outcome = await sync(book(1, { highlights: threeHighlights() }))

    expect(outcome.status).toBe('failed')
    expect(links.getLinkByBookId(db(), 1)).toMatchObject({ noteId, state: 'linked' })
  })

  describe('images (D14)', () => {
    const withCover = (over: Partial<ReadwiseBook> = {}) =>
      book(1, {
        category: 'articles',
        cover_image_url: COVER_URL,
        highlights: [highlight(1)],
        ...over
      })

    it('saves the cover as rw-<hash>.<ext>, sets an article cover, and references it in no remote form', async () => {
      const noteId = await created(withCover())
      const note = (await notes.getNoteById(noteId))!

      expect(fetchCalls).toEqual([COVER_URL])
      expect(String(note.frontmatter.cover)).toMatch(/attachments\/.+\/rw-[0-9a-f]{16}\.png$/)
      expect(note.content).not.toContain('https://m.media-amazon.com')
      expect(
        fs
          .readdirSync(path.join(vault.path, 'attachments', noteId))
          .filter((f) => f.startsWith('rw-'))
      ).toHaveLength(1)
    })

    it('puts a non-article cover at the top of the section', async () => {
      const noteId = await created(withCover({ category: 'books' }))
      expect(await body(noteId)).toMatch(
        /<!-- readwise:start -->\n\n!\[\]\(.+rw-[0-9a-f]{16}\.png\)/
      )
    })

    it('makes zero writes and zero downloads for an unchanged book with a cover', async () => {
      await created(withCover())
      fetchCalls.length = 0
      vi.mocked(domain.updateNoteCommand).mockClear()

      expect((await sync(withCover())).status).toBe('unchanged')
      expect(fetchCalls).toEqual([])
      expect(writes()).toBe(0)
    })

    it('leaves a failed image out, and the next re-render of the untouched section adds it', async () => {
      failingUrls.add(COVER_URL)
      const noteId = await created(withCover({ category: 'books' }))
      expect(await body(noteId)).not.toContain('![](')

      failingUrls.clear()
      expect((await sync(withCover({ category: 'books' }))).status).toBe('updated')
      expect(await body(noteId)).toContain('![](')
    })

    it('reuses the images that synced with the note after a takeover, without downloading again', async () => {
      const noteId = await created(withCover({ category: 'books' }))
      db().delete(readwiseLinks).run()
      await flushProjectionEvents()
      fetchCalls.length = 0
      vi.mocked(domain.updateNoteCommand).mockClear()

      const outcome = await sync(withCover({ category: 'books' }))

      expect(outcome).toEqual({ status: 'unchanged', noteId })
      expect(fetchCalls).toEqual([])
      expect(links.getLinkByBookId(db(), 1)?.noteId).toBe(noteId)
      expect(writes()).toBe(0)
    })

    it('saves an image highlight added to a touched section', async () => {
      const noteId = await created(book(1, { highlights: [highlight(1)] }))
      await userEdits(noteId, (content) => content.replace('Highlight 1', 'Highlight 1 mine'))
      const imageUrl = 'https://cdn.example.com/page.png'

      const outcome = await sync(
        book(1, {
          highlights: [
            highlight(1),
            highlight(2, { text: `![](${imageUrl})`, created_at: '2030-01-01T08:00:00Z' })
          ]
        })
      )

      expect(outcome.status).toBe('appended')
      expect(fetchCalls).toEqual([imageUrl])
      expect(await body(noteId)).toMatch(/!\[\]\(.+rw-[0-9a-f]{16}\.png\)/)
    })
  })

  describe('reset (D16)', () => {
    it('rewrites a touched section, and the next sync treats it as untouched', async () => {
      const noteId = await created(book(1, { highlights: threeHighlights() }))
      await userEdits(
        noteId,
        (content) => `Mine above.\n\n${content.replace('Highlight 1', 'Highlight 1 my thought')}`
      )

      const source = book(1, { highlights: [highlight(1), highlight(4)] })
      expect((await sync(source, { reset: true })).status).toBe('updated')
      const content = await body(noteId)
      expect(content).not.toContain('my thought')
      expect(content.startsWith('Mine above.')).toBe(true)
      expect(readSection(content)).toMatchObject({ found: true, untouched: true })

      const later = book(1, { highlights: [highlight(1), highlight(4), highlight(5)] })
      expect((await sync(later)).status).toBe('updated')
      expect(await body(noteId)).toContain('Highlight 5')
    })

    it('puts a new section at the end when a marker is missing, keeping the rest of the old one', async () => {
      const noteId = await created(book(1, { highlights: threeHighlights() }))
      await userEdits(noteId, (content) => content.replace(/<!-- readwise:end[^>]*-->/, ''))

      await sync(book(1, { highlights: threeHighlights() }), { reset: true })

      const content = await body(noteId)
      expect(content.match(/<!-- readwise:start -->/g)).toHaveLength(1)
      expect(readSection(content)).toMatchObject({ found: true, untouched: true })
      expect(content.match(/readwise\.io\/open\/1\)/g)).toHaveLength(2)
    })
  })

  describe('adopting an existing note', () => {
    it('finds a note by its readwise_url when the link cache is empty', async () => {
      const noteId = await created(book(1, { highlights: [highlight(1)] }))
      db().delete(readwiseLinks).run()
      await flushProjectionEvents()

      const outcome = await sync(book(1, { highlights: threeHighlights() }))

      expect(outcome).toEqual({ status: 'updated', noteId })
      expect(fs.readdirSync(path.join(vault.path, 'Readwise', 'Books'))).toHaveLength(1)
    })
  })

  describe('failures', () => {
    it('fails the book with its reason and lists it for retry when its note is locked', async () => {
      const noteId = await created(book(1, { highlights: [highlight(1)] }))
      const locks = await import('../vault-locks/registry')
      vi.spyOn(locks, 'assertNoteWritable').mockImplementation(() => {
        throw new Error('This note is locked')
      })

      const outcome = await sync(book(1, { highlights: threeHighlights() }))

      expect(outcome).toEqual({ status: 'failed', reason: 'This note is locked' })
      expect(state.getRetryList(db())[0]).toMatchObject({
        readwiseBookId: 1,
        reason: 'This note is locked'
      })
      expect(await body(noteId)).not.toContain('Highlight 3')
    })
  })

  describe('the editor round trip (D5)', () => {
    async function throughConverter(markdown: string): Promise<string> {
      const doc = new Y.Doc()
      expect(
        await converter.markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
      ).toBe(true)
      writeMarkdownSourceToYDoc(doc, null)
      return (await converter.yDocToMarkdown(doc)) as string
    }

    it('keeps the section untouched after an edit outside it goes through the real converter', async () => {
      const source = book(1, {
        cover_image_url: COVER_URL,
        highlights: [highlight(1), highlight(2, { note: 'a note' })]
      })
      const noteId = await created(source)
      await userEdits(noteId, (content) => `Intro.\n\n${content}\n\nOutro.`)
      const edited = await throughConverter(await body(noteId))
      await userEdits(noteId, () => edited.replace('Intro.', 'Intro, edited.'))

      expect(readSection(await body(noteId))).toMatchObject({ found: true, untouched: true })
      const next = book(1, {
        cover_image_url: COVER_URL,
        highlights: [highlight(1), highlight(2, { note: 'a note' }), highlight(3)]
      })
      expect((await sync(next)).status).toBe('updated')
    })
  })
})
