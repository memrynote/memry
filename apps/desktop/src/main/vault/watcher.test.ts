import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import { noteCache, noteTags, noteLinks } from '@memry/db-schema/schema/notes-cache'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { createTestVault, createTestNote } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'
import { parseNote, serializeNote } from './frontmatter'
import { trackPendingDelete, clearAllPendingDeletes, hasPendingDeletes } from './rename-tracker'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'

const mockWatch = vi.hoisted(() => vi.fn())
const baseConfig = {
  excludePatterns: [],
  defaultNoteFolder: 'notes',
  journalFolder: 'journal',
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
  updateFtsContent: vi.fn(),
  queueFtsUpdate: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn()
}))

vi.mock('./index', () => ({
  getConfig: vi.fn(() => baseConfig)
}))

import { getIndexDatabase, getDatabase, updateFtsContent, queueFtsUpdate } from '../database'
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

    vi.mocked(getDatabase).mockReturnValue(dataDb.db)
    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)
    vi.mocked(updateFtsContent).mockImplementation(() => false)
    vi.mocked(queueFtsUpdate).mockImplementation(() => false)
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
      id: 'note-change',
      title: 'change-note',
      content: 'Old content',
      tags: ['alpha']
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(notePath)

    const initial = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-change')).get()
    const initialHash = initial?.contentHash
    const initialWordCount = initial?.wordCount ?? 0

    window.webContents.send.mockClear()

    const raw = fs.readFileSync(notePath, 'utf8')
    const parsed = parseNote(raw, path.relative(vault.path, notePath))
    const updatedContent = serializeNote(parsed.frontmatter, 'New content with more words')
    fs.writeFileSync(notePath, updatedContent, 'utf8')

    await watcher.handleFileChange(notePath)

    const updated = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-change')).get()

    expect(updated?.contentHash).not.toBe(initialHash)
    expect(updated?.wordCount).toBeGreaterThan(initialWordCount)

    const sentCalls = window.webContents.send.mock.calls
    const hasUpdatedEvent = sentCalls.some(
      ([channel, payload]) =>
        channel === NotesChannels.events.UPDATED &&
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { id?: string }).id === 'note-change'
    )
    const hasCreatedEvent = sentCalls.some(
      ([channel, payload]) =>
        channel === NotesChannels.events.CREATED &&
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as { note?: { id?: string } }).note === 'object' &&
        (payload as { note?: { id?: string } }).note !== null &&
        (payload as { note?: { id?: string } }).note?.id === 'note-change'
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
      id: 'target-note',
      title: 'Target Note',
      content: 'Target content'
    })
    await watcher.handleFileAdd(targetPath)

    const notePath = createTestNote(vault, {
      id: 'note-add',
      title: 'source-note',
      content: 'See [[Target Note]]',
      tags: ['Alpha', 'Beta']
    })

    await watcher.handleFileAdd(notePath)

    const cached = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-add')).get()
    expect(cached?.path).toBe('notes/source-note.md')
    const canonical = dataDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.id, 'note-add'))
      .get()
    expect(canonical?.path).toBe('notes/source-note.md')

    const tags = indexDb.db
      .select()
      .from(noteTags)
      .where(eq(noteTags.noteId, 'note-add'))
      .all()
      .map((tag) => tag.tag)
      .sort()
    expect(tags).toEqual(['alpha', 'beta'])

    const links = indexDb.db
      .select()
      .from(noteLinks)
      .where(eq(noteLinks.sourceId, 'note-add'))
      .all()
    if (links.length > 0) {
      expect(links).toEqual([expect.objectContaining({ targetTitle: 'Target Note' })])
    }

    window.webContents.send.mockClear()

    await watcher.handleFileDelete(notePath)
    await vi.advanceTimersByTimeAsync(500)

    const deleted = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-add')).get()
    expect(deleted).toBeUndefined()
    const deletedCanonical = dataDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.id, 'note-add'))
      .get()
    expect(deletedCanonical).toBeUndefined()

    const remainingTags = indexDb.db
      .select()
      .from(noteTags)
      .where(eq(noteTags.noteId, 'note-add'))
      .all()
    expect(remainingTags).toEqual([])

    const remainingLinks = indexDb.db
      .select()
      .from(noteLinks)
      .where(eq(noteLinks.sourceId, 'note-add'))
      .all()
    expect(remainingLinks).toEqual([])

    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.DELETED,
      expect.objectContaining({
        id: 'note-add',
        path: 'notes/source-note.md',
        source: 'external'
      })
    )
  })

  // ==========================================================================
  // T602: rename flow integration
  // ==========================================================================
  it('processes rename flow via rename-tracker', async () => {
    vi.useFakeTimers()
    const oldPath = createTestNote(vault, {
      id: 'note-rename',
      title: 'old-name',
      content: 'Old content'
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(oldPath)

    window.webContents.send.mockClear()

    const newPath = createTestNote(vault, {
      id: 'note-rename',
      title: 'new-name',
      content: 'Old content'
    })

    await watcher.handleFileDelete(oldPath)
    await watcher.handleFileAdd(newPath)
    await vi.advanceTimersByTimeAsync(500)

    const updated = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-rename')).get()

    expect(updated?.path).toBe('notes/new-name.md')
    expect(updated?.title).toBe('new-name')

    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.RENAMED,
      expect.objectContaining({
        id: 'note-rename',
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

    expect(mockWatch).toHaveBeenCalledWith(
      [path.join(vault.path, 'notes'), path.join(vault.path, 'journal')],
      expect.any(Object)
    )

    expect(getWatcher().isWatching()).toBe(true)

    trackPendingDelete('pending-note', 'notes/pending.md', vi.fn())
    expect(hasPendingDeletes()).toBe(true)

    await stopWatcher()

    expect(mockWatcher.close).toHaveBeenCalled()
    expect(getWatcher().isWatching()).toBe(false)
    expect(hasPendingDeletes()).toBe(false)
  })

  // ==========================================================================
  // T604: Finder copy derives title from OS filename, not original
  // ==========================================================================
  it('sets frontmatter title from OS filename when detecting a copy', async () => {
    // #given — original note in the cache
    const originalPath = createTestNote(vault, {
      id: 'original-id',
      title: 'my-note',
      content: 'Some content'
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(originalPath)

    // #when — simulate Finder copy: identical frontmatter at "my-note copy.md"
    const copyFilename = 'my-note copy.md'
    const copyAbsPath = path.join(vault.notesDir, copyFilename)
    const originalContent = fs.readFileSync(originalPath, 'utf8')
    fs.writeFileSync(copyAbsPath, originalContent, 'utf8')

    await watcher.handleFileAdd(copyAbsPath)

    // #then — copy gets new ID AND title derived from OS filename
    const copyContent = fs.readFileSync(copyAbsPath, 'utf8')
    const parsed = parseNote(copyContent, `notes/${copyFilename}`)

    expect(parsed.frontmatter.id).not.toBe('original-id')
    expect(parsed.frontmatter.title).toBe('my-note copy')
  })
})
