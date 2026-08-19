import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { JournalChannels, NotesChannels } from '@memry/contracts/ipc-channels'
import { noteCache, noteTags, noteLinks } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { createTestVault, createTestNote } from '@tests/utils/test-vault'
import {
  createTestDataDb,
  createTestIndexDb,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'
import { parseNote, serializeNote } from './frontmatter'
import { trackPendingDelete, clearAllPendingDeletes, hasPendingDeletes } from './rename-tracker'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'

const mockWatch = vi.hoisted(() => vi.fn())
const baseConfig: VaultConfig = {
  excludePatterns: [],
  defaultNoteFolder: 'notes',
  journalFolder: 'journal',
  journalDateFormat: 'YYYY-MM-DD',
  attachmentsFolder: 'attachments'
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn()
  }
}))

vi.mock('chokidar', () => ({
  default: { watch: mockWatch },
  watch: mockWatch
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  updateFtsContent: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn()
}))

vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  enqueueJournalDelete: vi.fn(),
  initializeJournalCrdt: vi.fn()
}))

vi.mock('../notes/runtime-effects', () => ({
  syncNoteCreate: vi.fn(),
  syncNoteDelete: vi.fn(),
  syncNoteUpdate: vi.fn()
}))

// Both readers are spied through to the real implementation: the add path must
// not open the file at all, by either route, and only a spy can tell "did not
// read" from "read and ignored".
vi.mock('./file-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-ops')>()
  return { ...actual, safeRead: vi.fn(actual.safeRead) }
})

vi.mock('./file-scan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-scan')>()
  return { ...actual, scanMarkdownFile: vi.fn(actual.scanMarkdownFile) }
})

vi.mock('../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: vi.fn(() => ({ getDoc: vi.fn(() => null) }))
}))

vi.mock('./index', () => ({
  getConfig: vi.fn(() => baseConfig)
}))

vi.mock('../telemetry/diagnostics', () => ({
  trackMainError: vi.fn(),
  trackMainLog: vi.fn()
}))

import { getIndexDatabase, getDatabase, updateFtsContent } from '../database'
import { enqueueJournalCreate, initializeJournalCrdt } from '../journal/runtime-effects'
import { syncNoteCreate } from '../notes/runtime-effects'
import { updateNoteEmbedding } from '../inbox/suggestions'
import { getConfig } from './index'
import { safeRead } from './file-ops'
import { scanMarkdownFile } from './file-scan'
import { clearIngestBackfill, drainIngestBackfill } from './ingest-backfill'
import { trackMainError } from '../telemetry/diagnostics'
import { VaultWatcher, getWatcher, startWatcher, stopWatcher } from './watcher'

describe('vault watcher', () => {
  let vault: ReturnType<typeof createTestVault>
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let window: MockBrowserWindow

  beforeEach(() => {
    vault = createTestVault('watcher')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    indexDb.sqlite.pragma('foreign_keys = ON')

    vi.mocked(getDatabase).mockReturnValue(asClientDb(dataDb.db))
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)
    vi.mocked(updateFtsContent).mockImplementation(() => false)
    vi.mocked(updateNoteEmbedding).mockResolvedValue(false)
    vi.mocked(getConfig).mockReturnValue(baseConfig as never)

    window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window as never])
    mockWatch.mockReset()

    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
    clearIngestBackfill()
    clearAllPendingDeletes()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  // ==========================================================================
  // T600: handleFileChange updates cache
  // ==========================================================================
  it('updates cache and emits UPDATED when a file changes', async () => {
    const notePath = createTestNote(vault, {
      title: 'change-note',
      content: 'Old content',
      tags: ['alpha']
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(notePath)

    // Files carry no Memry identity — the watcher assigns a fresh internal id
    const initial = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/change-note.md'))
      .get()
    expect(initial).toBeDefined()
    const noteId = initial!.id
    const initialHash = initial?.contentHash
    const initialWordCount = initial?.wordCount ?? 0

    window.webContents.send.mockClear()

    const raw = fs.readFileSync(notePath, 'utf8')
    const parsed = parseNote(raw, path.relative(vault.path, notePath))
    const updatedContent = serializeNote(parsed.frontmatter, 'New content with more words')
    fs.writeFileSync(notePath, updatedContent, 'utf8')

    await watcher.handleFileChange(notePath)

    const updated = indexDb.db.select().from(noteCache).where(eq(noteCache.id, noteId)).get()

    expect(updated?.contentHash).not.toBe(initialHash)
    expect(updated?.wordCount).toBeGreaterThan(initialWordCount)

    const sentCalls = window.webContents.send.mock.calls
    const hasUpdatedEvent = sentCalls.some(
      ([channel, payload]) =>
        channel === NotesChannels.events.UPDATED &&
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { id?: string }).id === noteId
    )
    const hasCreatedEvent = sentCalls.some(
      ([channel, payload]) =>
        channel === NotesChannels.events.CREATED &&
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { note?: { id?: string } }).note === 'object' &&
        (payload as { note?: { id?: string } }).note !== null &&
        (payload as { note?: { id?: string } }).note?.id === noteId
    )

    expect(hasUpdatedEvent || hasCreatedEvent).toBe(true)
  })

  // ==========================================================================
  // T601: add/unlink events sync cache, tags, links
  // ==========================================================================
  it('adds and deletes notes with tags and links', async () => {
    vi.useFakeTimers()
    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    const targetPath = createTestNote(vault, {
      title: 'Target Note',
      content: 'Target content'
    })
    await watcher.handleFileAdd(targetPath)

    const notePath = createTestNote(vault, {
      title: 'source-note',
      content: 'See [[Target Note]]',
      tags: ['Alpha', 'Beta']
    })

    await watcher.handleFileAdd(notePath)
    await drainIngestBackfill()

    // Fresh internal id assigned on add — resolve it via the path
    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/source-note.md'))
      .get()
    expect(cached).toBeDefined()
    const noteId = cached!.id
    const canonical = dataDb.db.select().from(noteMetadata).where(eq(noteMetadata.id, noteId)).get()
    expect(canonical?.path).toBe('notes/source-note.md')

    const tags = indexDb.db
      .select()
      .from(noteTags)
      .where(eq(noteTags.noteId, noteId))
      .all()
      .map((tag) => tag.tag)
      .sort()
    expect(tags).toEqual(['Alpha', 'Beta'])

    const links = indexDb.db.select().from(noteLinks).where(eq(noteLinks.sourceId, noteId)).all()
    if (links.length > 0) {
      expect(links).toEqual([expect.objectContaining({ targetTitle: 'Target Note' })])
    }

    window.webContents.send.mockClear()

    await watcher.handleFileDelete(notePath)
    await vi.advanceTimersByTimeAsync(500)

    const deleted = indexDb.db.select().from(noteCache).where(eq(noteCache.id, noteId)).get()
    expect(deleted).toBeUndefined()
    const deletedCanonical = dataDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.id, noteId))
      .get()
    expect(deletedCanonical).toBeUndefined()

    const remainingTags = indexDb.db
      .select()
      .from(noteTags)
      .where(eq(noteTags.noteId, noteId))
      .all()
    expect(remainingTags).toEqual([])

    const remainingLinks = indexDb.db
      .select()
      .from(noteLinks)
      .where(eq(noteLinks.sourceId, noteId))
      .all()
    expect(remainingLinks).toEqual([])

    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.DELETED,
      expect.objectContaining({
        id: noteId,
        path: 'notes/source-note.md',
        source: 'external'
      })
    )
  })

  // ==========================================================================
  // #1454: a body `#hashtag` is index-only — it may not reach the file's
  // frontmatter. The CRDT tag array is authoritative for write-back's `tags:`
  // block, so seeding it from the merged tag list rewrites the user's file the
  // first time they open the note.
  // ==========================================================================
  it('seeds the CRDT with the declared tags only, never the body hash tags', async () => {
    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    const notePath = createTestNote(vault, {
      title: 'inline-tag-note',
      content: 'Tagged #hashtag here.',
      tags: ['Declared']
    })

    await watcher.handleFileAdd(notePath)
    await drainIngestBackfill()

    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/inline-tag-note.md'))
      .get()
    const noteId = cached!.id

    // the index still merges the body tag in — search, the tag hub and the
    // graph all depend on that, and none of them touch the file
    const indexedTags = indexDb.db
      .select()
      .from(noteTags)
      .where(eq(noteTags.noteId, noteId))
      .all()
      .map((tag) => tag.tag)
      .sort()
    expect(indexedTags).toEqual(['Declared', 'hashtag'])

    // …but only what the file itself declares is handed to the CRDT
    expect(syncNoteCreate).toHaveBeenCalledWith(noteId, 'inline-tag-note', ['Declared'], {
      sizeClass: expect.any(String)
    })
  })

  it('hands the CRDT no tags at all for a note whose only tag is in its body', async () => {
    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    const notePath = createTestNote(vault, {
      title: 'body-only-tag-note',
      content: 'Tagged #hashtag here.'
    })

    await watcher.handleFileAdd(notePath)
    await drainIngestBackfill()

    const noteId = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/body-only-tag-note.md'))
      .get()!.id

    // An empty array is the whole fix: `mergeFrontmatter` only forces `tags:`
    // onto the file when the doc's tag array is non-empty.
    expect(syncNoteCreate).toHaveBeenCalledWith(noteId, 'body-only-tag-note', [], {
      sizeClass: expect.any(String)
    })
  })

  // ==========================================================================
  // T602: rename flow integration
  // ==========================================================================
  it('processes rename flow via rename-tracker (content-hash match)', async () => {
    vi.useFakeTimers()
    const oldPath = createTestNote(vault, {
      title: 'old-name',
      content: 'Old content'
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(oldPath)

    const cachedBefore = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/old-name.md'))
      .get()
    expect(cachedBefore).toBeDefined()
    const noteId = cachedBefore!.id

    window.webContents.send.mockClear()

    // External rename: identical bytes at a new path — matched by content hash
    const newPath = path.join(vault.notesDir, 'new-name.md')
    fs.renameSync(oldPath, newPath)

    await watcher.handleFileDelete(oldPath)
    await watcher.handleFileAdd(newPath)
    await vi.advanceTimersByTimeAsync(500)

    const updated = indexDb.db.select().from(noteCache).where(eq(noteCache.id, noteId)).get()

    expect(updated?.path).toBe('notes/new-name.md')
    expect(updated?.title).toBe('new-name')

    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.RENAMED,
      expect.objectContaining({
        id: noteId,
        oldPath: 'notes/old-name.md',
        newPath: 'notes/new-name.md',
        source: 'external'
      })
    )
  })

  // ==========================================================================
  // T603: watcher startup/shutdown and cleanup
  // ==========================================================================
  it('starts and stops the watcher, cleaning resources', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()

    const addListener = (event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? []
      existing.push(handler)
      listeners.set(event, existing)
    }

    const trigger = (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args)
      }
    }

    const mockWatcher = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        addListener(event, handler)
        return mockWatcher
      }),
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        addListener(event, handler)
        return mockWatcher
      }),
      close: vi.fn().mockResolvedValue(undefined)
    }

    mockWatch.mockReturnValue(mockWatcher)

    const startPromise = startWatcher(vault.path)
    trigger('ready')
    await startPromise

    expect(mockWatch).toHaveBeenCalledWith([vault.path], expect.any(Object))

    expect(getWatcher().isWatching()).toBe(true)

    trackPendingDelete('pending-note', 'hash-pending', 'notes/pending.md', vi.fn())
    expect(hasPendingDeletes()).toBe(true)

    await stopWatcher()

    expect(mockWatcher.close).toHaveBeenCalled()
    expect(getWatcher().isWatching()).toBe(false)
    expect(hasPendingDeletes()).toBe(false)
  })

  it('applies watcher ignore rules and forwards watcher errors', async () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const addListener = (event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
    }
    const trigger = (event: string, ...args: unknown[]) => {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    }

    const mockWatcher = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        addListener(event, handler)
        return mockWatcher
      }),
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        addListener(event, handler)
        return mockWatcher
      }),
      close: vi.fn().mockResolvedValue(undefined)
    }
    mockWatch.mockReturnValue(mockWatcher)

    const watcher = new VaultWatcher()
    const onError = vi.fn()
    const startPromise = watcher.start({
      vaultPath: vault.path,
      excludePatterns: ['ignored'],
      onError
    })

    const ignored = mockWatch.mock.calls[0][1].ignored as (
      filePath: string,
      stats?: { isFile: () => boolean }
    ) => boolean
    expect(ignored(path.join(vault.path, '.hidden'))).toBe(true)
    expect(ignored(path.join(vault.path, 'notes', 'ignored', 'note.md'))).toBe(true)
    expect(ignored(path.join(vault.path, 'notes', 'draft.tmp'), { isFile: () => true })).toBe(true)
    expect(ignored(path.join(vault.path, 'notes', 'draft.md'), { isFile: () => true })).toBe(false)
    expect(ignored(path.join(vault.path, 'notes'), { isFile: () => false })).toBe(false)

    trigger('error', 'watch failed')
    expect(onError).toHaveBeenCalledWith(expect.any(Error))

    trigger('ready')
    await startPromise
    await watcher.stop()
  })

  it('adds and updates non-markdown files as attachment notes', async () => {
    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    const imagePath = path.join(vault.notesDir, 'photo.png')
    fs.writeFileSync(imagePath, Buffer.from('image'))

    await watcher.handleFileAdd(imagePath)

    const createdCall = window.webContents.send.mock.calls.find(
      ([channel, payload]) =>
        channel === NotesChannels.events.CREATED &&
        (payload as { fileType?: string }).fileType === 'image'
    )
    expect(createdCall?.[1]).toMatchObject({
      note: expect.objectContaining({
        path: 'notes/photo.png',
        title: 'photo',
        tags: [],
        wordCount: 0
      }),
      source: 'external',
      fileType: 'image'
    })

    const createdId = (createdCall?.[1] as { note: { id: string } }).note.id
    window.webContents.send.mockClear()
    fs.writeFileSync(imagePath, Buffer.from('updated-image'))

    await watcher.handleFileChange(imagePath)

    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.UPDATED,
      expect.objectContaining({
        id: createdId,
        source: 'external',
        fileType: 'image',
        changes: expect.objectContaining({ fileSize: Buffer.byteLength('updated-image') })
      })
    )
  })

  it('emits journal create, update, and delete events for direct journal files', async () => {
    vi.useFakeTimers()
    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    const journalPath = path.join(vault.journalDir, '2026-05-10.md')
    fs.writeFileSync(
      journalPath,
      [
        '---',
        'id: "journal-direct"',
        'title: "2026-05-10"',
        'created: "2026-05-10T00:00:00.000Z"',
        'modified: "2026-05-10T00:00:00.000Z"',
        'tags:',
        '  - daily',
        '---',
        '',
        'First entry'
      ].join('\n'),
      'utf8'
    )

    await watcher.handleFileAdd(journalPath)
    await drainIngestBackfill()

    expect(window.webContents.send).toHaveBeenCalledWith(
      JournalChannels.events.ENTRY_CREATED,
      expect.objectContaining({
        date: '2026-05-10',
        source: 'external',
        entry: expect.objectContaining({
          content: '\nFirst entry',
          tags: ['daily']
        })
      })
    )

    window.webContents.send.mockClear()
    fs.writeFileSync(
      journalPath,
      [
        '---',
        'id: "journal-direct"',
        'title: "2026-05-10"',
        'created: "2026-05-10T00:00:00.000Z"',
        'modified: "2026-05-10T01:00:00.000Z"',
        'tags:',
        '  - daily',
        '---',
        '',
        'Updated entry'
      ].join('\n'),
      'utf8'
    )

    await watcher.handleFileChange(journalPath)

    expect(window.webContents.send).toHaveBeenCalledWith(
      JournalChannels.events.ENTRY_UPDATED,
      expect.objectContaining({
        date: '2026-05-10',
        source: 'external',
        entry: expect.objectContaining({
          content: '\nUpdated entry',
          tags: ['daily']
        })
      })
    )

    window.webContents.send.mockClear()
    watcher.handleFileDelete(journalPath)
    await vi.advanceTimersByTimeAsync(500)

    expect(window.webContents.send).toHaveBeenCalledWith(
      JournalChannels.events.ENTRY_DELETED,
      expect.objectContaining({
        date: '2026-05-10',
        source: 'external'
      })
    )
  })

  // ==========================================================================
  // T604: Finder copy is just a new note — fresh internal id, zero file writes
  // ==========================================================================
  it('treats a copied file as a new note without writing to it', async () => {
    // #given — original note in the cache
    const originalPath = createTestNote(vault, {
      title: 'my-note',
      content: 'Some content'
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(originalPath)

    const original = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/my-note.md'))
      .get()
    expect(original).toBeDefined()

    // #when — simulate Finder copy: identical bytes at "my-note copy.md"
    const copyFilename = 'my-note copy.md'
    const copyAbsPath = path.join(vault.notesDir, copyFilename)
    const originalContent = fs.readFileSync(originalPath, 'utf8')
    fs.writeFileSync(copyAbsPath, originalContent, 'utf8')

    await watcher.handleFileAdd(copyAbsPath)

    // #then — the watcher never writes files: both keep their exact bytes
    expect(fs.readFileSync(copyAbsPath, 'utf8')).toBe(originalContent)
    expect(fs.readFileSync(originalPath, 'utf8')).toBe(originalContent)

    // The copy is a new note with a fresh internal id and filename-derived title
    const copy = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, `notes/${copyFilename}`))
      .get()
    expect(copy).toBeDefined()
    expect(copy!.id).not.toBe(original!.id)
    expect(copy!.title).toBe('my-note copy')
  })

  // ==========================================================================
  // Large-file class: a row in the sidebar, but never a CRDT seed at ingest
  // ==========================================================================

  it('lists a pasted log dump but does not initiate a CRDT seed for it', async () => {
    // #given a 600 KB dump with no blank line anywhere. It is under the byte
    // ceiling, so only the block bound catches it — this is the shape that
    // froze the app: one paragraph holding millions of inline nodes.
    const dump = Array.from({ length: 20_000 }, (_, i) => `2026-08-15 line ${i} payload`).join('\n')
    const dumpPath = createTestNote(vault, { title: 'server-log', content: dump })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    vi.mocked(syncNoteCreate).mockClear()

    // #when
    await watcher.handleFileAdd(dumpPath)
    await drainIngestBackfill()

    // #then — the row still appears, so the file is not hidden from the user
    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/server-log.md'))
      .get()
    expect(cached).toBeDefined()

    // ...and it is classified large-file, so it gets neither a CRDT doc nor a
    // sync item. The call happens in the backfill, which is the first point
    // that has measured the block bound.
    expect(syncNoteCreate).toHaveBeenCalledWith(cached!.id, expect.any(String), expect.any(Array), {
      sizeClass: 'large-file'
    })
  })

  it('enqueues no journal sync item for a large-file-class journal entry', async () => {
    // #given a dump dropped straight into the journal folder. It has no CRDT
    // body, so a sync item would only draw a row another device cannot open.
    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    const journalPath = path.join(vault.journalDir, '2026-05-11.md')
    const dump = Array.from({ length: 20_000 }, (_, i) => `2026-05-11 line ${i} payload`).join('\n')
    fs.writeFileSync(journalPath, `---\nid: "journal-dump"\n---\n\n${dump}`, 'utf8')
    vi.mocked(enqueueJournalCreate).mockClear()
    vi.mocked(initializeJournalCrdt).mockClear()

    // #when
    await watcher.handleFileAdd(journalPath)
    await drainIngestBackfill()

    // #then — listed locally, but nothing leaves this device and nothing seeds
    expect(enqueueJournalCreate).not.toHaveBeenCalled()
    expect(initializeJournalCrdt).not.toHaveBeenCalled()
  })

  it('still enqueues a note-class journal entry for sync', async () => {
    // #then the guard must cost note-class journal entries nothing
    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    const journalPath = path.join(vault.journalDir, '2026-05-12.md')
    fs.writeFileSync(journalPath, '---\nid: "journal-small"\n---\n\nFirst entry', 'utf8')
    vi.mocked(enqueueJournalCreate).mockClear()
    vi.mocked(initializeJournalCrdt).mockClear()

    // #when
    await watcher.handleFileAdd(journalPath)
    await drainIngestBackfill()

    // #then
    expect(enqueueJournalCreate).toHaveBeenCalledWith(expect.any(String), '2026-05-12')
    expect(initializeJournalCrdt).toHaveBeenCalled()
  })

  it('still initiates a CRDT seed for a well-formed note', async () => {
    // #given ordinary prose: blank-line separated, small blocks
    const prose = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} of the note.`).join('\n\n')
    const notePath = createTestNote(vault, { title: 'ordinary', content: prose })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    vi.mocked(syncNoteCreate).mockClear()

    // #when
    await watcher.handleFileAdd(notePath)
    await drainIngestBackfill()

    // #then — the guard must not cost note-class files their CRDT doc. It is
    // the backfill that asks for it now: the add path never reads the file, so
    // the block bound cannot be measured there.
    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/ordinary.md'))
      .get()
    expect(syncNoteCreate).toHaveBeenCalledWith(cached!.id, 'ordinary', expect.any(Array), {
      sizeClass: 'note'
    })
  })

  // ==========================================================================
  // Tier 0: the sidebar row comes from `stat`, path and title alone
  // ==========================================================================

  it('lists a newly added file without reading it', async () => {
    // #given a file whose body is expensive to touch at ingest
    const body = Array.from({ length: 5_000 }, (_, i) => `2026-08-15 line ${i} payload`).join('\n')
    const notePath = createTestNote(vault, { title: 'pasted-dump', content: body })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    vi.mocked(safeRead).mockClear()
    vi.mocked(scanMarkdownFile).mockClear()
    window.webContents.send.mockClear()

    // #when
    await watcher.handleFileAdd(notePath)

    // #then the row is there, so the user sees the file immediately...
    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/pasted-dump.md'))
      .get()
    expect(cached).toBeDefined()
    expect(cached!.title).toBe('pasted-dump')

    // ...and nothing on the add path opened the file, by either route: no
    // whole-file read and no streaming pass over its bytes
    expect(safeRead).not.toHaveBeenCalled()
    expect(scanMarkdownFile).not.toHaveBeenCalled()

    // ...so every content-derived field is unknown rather than wrong
    expect(cached!.contentHash).toBeNull()
    expect(cached!.wordCount).toBeNull()
    expect(cached!.snippet).toBeNull()

    const created = window.webContents.send.mock.calls.find(
      ([channel]) => channel === NotesChannels.events.CREATED
    )
    expect(created).toBeDefined()
    const createdNote = (created![1] as { note: { wordCount: number | null; snippet?: string } })
      .note
    expect(createdNote.wordCount).toBeNull()
    expect(createdNote.snippet).toBeUndefined()
  })

  // ==========================================================================
  // Tier 1: the idle backfill fills in what tier 0 left unknown
  // ==========================================================================

  it('fills in word count, snippet, tags and search on the backfill', async () => {
    const notePath = createTestNote(vault, {
      title: 'later',
      content: 'Some words here',
      tags: ['alpha']
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(notePath)
    const before = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/later.md'))
      .get()
    expect(before!.wordCount).toBeNull()

    window.webContents.send.mockClear()

    // #when
    await drainIngestBackfill()

    // #then
    const after = indexDb.db.select().from(noteCache).where(eq(noteCache.id, before!.id)).get()
    expect(after!.wordCount).toBe(3)
    expect(after!.snippet).toContain('Some words here')
    expect(after!.contentHash).not.toBeNull()

    const tags = indexDb.db
      .select()
      .from(noteTags)
      .where(eq(noteTags.noteId, before!.id))
      .all()
      .map((row) => row.tag)
    expect(tags).toEqual(['alpha'])

    // the renderer's row is corrected in place
    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.UPDATED,
      expect.objectContaining({
        id: before!.id,
        changes: expect.objectContaining({ wordCount: 3 })
      })
    )
  })

  it('backfills the smallest file first', async () => {
    // #given two files queued largest-first
    const bigPath = createTestNote(vault, { title: 'big', content: 'word '.repeat(20_000) })
    const smallPath = createTestNote(vault, { title: 'small', content: 'tiny' })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    await watcher.handleFileAdd(bigPath)
    await watcher.handleFileAdd(smallPath)

    const bigId = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/big.md'))
      .get()?.id
    const smallId = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/small.md'))
      .get()?.id

    window.webContents.send.mockClear()

    // #when
    await drainIngestBackfill()

    // #then the cheap row is corrected first, so a queued 250 MB file never
    // holds up the notes the user is actually looking at
    const updatedIds = window.webContents.send.mock.calls
      .filter(([channel]) => channel === NotesChannels.events.UPDATED)
      .map(([, payload]) => (payload as { id: string }).id)
    expect(updatedIds).toEqual([smallId, bigId])
  })

  it('measures a file over the note ceiling without reading it as one string', async () => {
    // #given a file past NOTE_MAX_BYTES. Reading one of these whole is what
    // throws ERR_STRING_TOO_LONG once a file passes the V8 string ceiling.
    const hugePath = path.join(vault.notesDir, 'huge.md')
    fs.writeFileSync(hugePath, 'alpha beta gamma delta epsilon\n'.repeat(90_000), 'utf8')

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    vi.mocked(syncNoteCreate).mockClear()

    await watcher.handleFileAdd(hugePath)
    vi.mocked(safeRead).mockClear()

    // #when
    await drainIngestBackfill()

    // #then the whole file was measured, but never held as one string
    expect(safeRead).not.toHaveBeenCalled()

    const after = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/huge.md'))
      .get()
    expect(after!.wordCount).toBe(5 * 90_000)
    expect(after!.snippet).toContain('alpha beta gamma')
    expect(after!.contentHash).not.toBeNull()

    // large-file class by `stat` alone: no CRDT doc and no sync item, at
    // either tier
    expect(syncNoteCreate).not.toHaveBeenCalled()
  })

  it('detects a rename of a file whose body was never read', async () => {
    // #given a file added but not yet backfilled, so the cache row carries no
    // content hash for the rename tracker to match on
    vi.useFakeTimers()
    const oldPath = createTestNote(vault, { title: 'fresh', content: 'Not yet backfilled' })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    await watcher.handleFileAdd(oldPath)

    const cached = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/fresh.md'))
      .get()
    expect(cached!.contentHash).toBeNull()
    const noteId = cached!.id

    window.webContents.send.mockClear()

    // #when Finder renames it before the backfill has run
    const newPath = path.join(vault.notesDir, 'renamed.md')
    fs.renameSync(oldPath, newPath)
    await watcher.handleFileDelete(oldPath)
    await watcher.handleFileAdd(newPath)
    await vi.advanceTimersByTimeAsync(500)

    // #then it is still the same note, not a delete plus a new one
    const renamed = indexDb.db.select().from(noteCache).where(eq(noteCache.id, noteId)).get()
    expect(renamed?.path).toBe('notes/renamed.md')
    expect(renamed?.title).toBe('renamed')
    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.RENAMED,
      expect.objectContaining({ id: noteId, newPath: 'notes/renamed.md' })
    )
  })

  it('keeps the measurements a rename cannot have changed', async () => {
    // #given a note the backfill has already measured, carrying a property
    const oldPath = createTestNote(vault, {
      title: 'measured',
      content: 'One two three four',
      properties: { status: 'open' }
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    await watcher.handleFileAdd(oldPath)
    await drainIngestBackfill()

    const before = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.path, 'notes/measured.md'))
      .get()
    expect(before!.wordCount).toBe(4)
    const canonicalBefore = dataDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.id, before!.id))
      .get()
    expect(canonicalBefore?.propertyDefinitionNames).toEqual(['id', 'status', 'title'])

    // #when the file is renamed, which changes no byte of its body. Asserted
    // before the re-queued backfill runs: that is the window in which a
    // stat-only write could erase state it knows nothing about.
    const newPath = path.join(vault.notesDir, 'measured-renamed.md')
    fs.renameSync(oldPath, newPath)
    await watcher.handleFileDelete(oldPath)
    await watcher.handleFileAdd(newPath)

    // #then nothing the rename cannot have changed is blanked out
    const after = indexDb.db.select().from(noteCache).where(eq(noteCache.id, before!.id)).get()
    expect(after!.path).toBe('notes/measured-renamed.md')
    expect(after!.wordCount).toBe(4)
    expect(after!.snippet).toBe(before!.snippet)
    expect(after!.contentHash).toBe(before!.contentHash)

    const canonicalAfter = dataDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.id, before!.id))
      .get()
    expect(canonicalAfter?.path).toBe('notes/measured-renamed.md')
    expect(canonicalAfter?.propertyDefinitionNames).toEqual(['id', 'status', 'title'])
  })

  it('lists a path the vault already knows under the id it already has', async () => {
    // #given a note whose canonical row exists but whose index-cache row does
    // not. The index DB is derived — it is rebuilt, and the projector that
    // fills it runs behind the canonical write — so this is the ordinary state
    // of a path that is added a second time: overwritten from Finder, restored
    // from a backup, or re-pasted.
    const notePath = createTestNote(vault, { title: 'known', content: 'Body' })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    const reportedErrors: Error[] = []
    watcher.onError = (error: Error) => reportedErrors.push(error)

    await watcher.handleFileAdd(notePath)
    const originalId = dataDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.path, 'notes/known.md'))
      .get()!.id

    indexDb.db.delete(noteCache).where(eq(noteCache.path, 'notes/known.md')).run()
    window.webContents.send.mockClear()

    // #when the same path is added again
    await watcher.handleFileAdd(notePath)

    // #then the sidebar gets its row back, under the id the vault already had.
    // A fresh id here is an INSERT against a unique `path`, which throws and
    // costs the user the row entirely; renumbering the note would orphan the
    // CRDT doc and sync item keyed by the old id.
    expect(reportedErrors).toEqual([])
    expect(
      dataDb.db
        .select()
        .from(noteMetadata)
        .where(eq(noteMetadata.path, 'notes/known.md'))
        .all()
        .map((row) => row.id)
    ).toEqual([originalId])
    expect(
      indexDb.db.select().from(noteCache).where(eq(noteCache.path, 'notes/known.md')).get()?.id
    ).toBe(originalId)
    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.CREATED,
      expect.objectContaining({ note: expect.objectContaining({ id: originalId }) })
    )
  })

  it('keeps the bookkeeping a re-add cannot have changed', async () => {
    // #given a measured note carrying a property, whose index-cache row is gone
    const notePath = createTestNote(vault, {
      title: 'kept',
      content: 'One two three four',
      properties: { status: 'open' }
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    await watcher.handleFileAdd(notePath)
    await drainIngestBackfill()

    const before = dataDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.path, 'notes/kept.md'))
      .get()!
    expect(before.propertyDefinitionNames).toEqual(['id', 'status', 'title'])

    indexDb.db.delete(noteCache).where(eq(noteCache.path, 'notes/kept.md')).run()

    // #when the path is added again
    await watcher.handleFileAdd(notePath)

    // #then the canonical row keeps what a `stat` cannot reconstruct — the
    // property names are how the note's properties reach other devices
    const after = dataDb.db.select().from(noteMetadata).where(eq(noteMetadata.id, before.id)).get()!
    expect(after.propertyDefinitionNames).toEqual(['id', 'status', 'title'])
    expect(after.createdAt).toBe(before.createdAt)
    expect(
      indexDb.db.select().from(noteCache).where(eq(noteCache.path, 'notes/kept.md')).get()?.id
    ).toBe(before.id)
  })

  it('reports an add that fails instead of dropping the row in silence', async () => {
    // #given an add that cannot finish — the canonical write throws
    const notePath = createTestNote(vault, { title: 'broken', content: 'Body' })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path
    const reportedErrors: Error[] = []
    watcher.onError = (error: Error) => reportedErrors.push(error)

    const failing = new Error('index database unavailable')
    vi.mocked(getIndexDatabase).mockImplementationOnce(() => {
      throw failing
    })

    // #when
    await watcher.handleFileAdd(notePath)

    // #then the user loses a sidebar row, so the failure has to be countable
    // rather than swallowed by a promise nobody awaits
    expect(reportedErrors).toEqual([failing])
    expect(trackMainError).toHaveBeenCalledWith('vault', 'file_add', failing)
  })
})
