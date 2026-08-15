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

vi.mock('../sync/crdt-provider', () => ({
  ORIGIN_LOCAL: 'local',
  getCrdtProvider: vi.fn(() => ({ getDoc: vi.fn(() => null) }))
}))

vi.mock('./index', () => ({
  getConfig: vi.fn(() => baseConfig)
}))

import { getIndexDatabase, getDatabase, updateFtsContent } from '../database'
import { updateNoteEmbedding } from '../inbox/suggestions'
import { getConfig } from './index'
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
    vi.mocked(getConfig).mockReturnValue(baseConfig)

    window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window as never])
    mockWatch.mockReset()

    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterEach(async () => {
    await stopProjectionRuntime({ drain: true })
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
})
