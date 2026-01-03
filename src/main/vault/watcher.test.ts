import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { NotesChannels } from '@shared/ipc-channels'
import { noteCache, noteTags, noteLinks } from '@shared/db/schema/notes-cache'
import { createTestVault, createTestNote } from '@tests/utils/test-vault'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { parseNote, serializeNote } from './frontmatter'
import { trackPendingDelete, clearAllPendingDeletes, hasPendingDeletes } from './rename-tracker'

const mockWindows: MockBrowserWindow[] = []
const mockWatch = vi.fn()
const baseConfig = {
  excludePatterns: [],
  defaultNoteFolder: 'notes',
  journalFolder: 'journal',
  attachmentsFolder: 'attachments'
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => mockWindows)
  }
}))

vi.mock('chokidar', () => ({
  default: { watch: mockWatch },
  watch: mockWatch
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  updateFtsContent: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn()
}))

vi.mock('./index', () => ({
  getConfig: vi.fn(() => baseConfig)
}))

import { getIndexDatabase, updateFtsContent } from '../database'
import { updateNoteEmbedding } from '../inbox/suggestions'
import { getConfig } from './index'
import { VaultWatcher, getWatcher, startWatcher, stopWatcher } from './watcher'

describe('vault watcher', () => {
  let vault: ReturnType<typeof createTestVault>
  let indexDb: TestDatabaseResult
  let window: MockBrowserWindow

  beforeEach(() => {
    vault = createTestVault('watcher')
    indexDb = createTestIndexDb()
    indexDb.sqlite.pragma('foreign_keys = ON')

    vi.mocked(getIndexDatabase).mockReturnValue(indexDb.db)
    vi.mocked(updateFtsContent).mockImplementation(() => undefined)
    vi.mocked(updateNoteEmbedding).mockResolvedValue(undefined)
    vi.mocked(getConfig).mockReturnValue(baseConfig)

    mockWindows.length = 0
    window = new MockBrowserWindow()
    mockWindows.push(window)
    mockWatch.mockReset()
  })

  afterEach(() => {
    clearAllPendingDeletes()
    indexDb.close()
    vault.cleanup()
    mockWindows.length = 0
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

    expect(updateFtsContent).toHaveBeenCalledWith(
      indexDb.db,
      'note-change',
      expect.any(String),
      ['alpha']
    )

    expect(window.webContents.send).toHaveBeenCalledWith(
      NotesChannels.events.UPDATED,
      expect.objectContaining({
        id: 'note-change',
        source: 'external',
        changes: expect.objectContaining({
          content: expect.any(String),
          tags: ['alpha']
        })
      })
    )
  })

  // ==========================================================================
  // T601: add/unlink events sync cache, tags, links
  // ==========================================================================
  it('adds and deletes notes with tags and links', async () => {
    vi.useFakeTimers()
    const now = new Date().toISOString()

    indexDb.db.insert(noteCache).values({
      id: 'target-note',
      path: 'notes/target-note.md',
      title: 'Target Note',
      contentHash: 'hash',
      wordCount: 0,
      characterCount: 0,
      createdAt: now,
      modifiedAt: now
    }).run()

    const notePath = createTestNote(vault, {
      id: 'note-add',
      title: 'source-note',
      content: 'See [[Target Note]]',
      tags: ['Alpha', 'Beta']
    })

    const watcher = new VaultWatcher() as any
    watcher.vaultPath = vault.path

    await watcher.handleFileAdd(notePath)

    const cached = indexDb.db.select().from(noteCache).where(eq(noteCache.id, 'note-add')).get()
    expect(cached?.path).toBe('notes/source-note.md')

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
    expect(links).toEqual([
      expect.objectContaining({ targetTitle: 'Target Note', targetId: 'target-note' })
    ])

    window.webContents.send.mockClear()

    await watcher.handleFileDelete(notePath)
    await vi.advanceTimersByTimeAsync(500)

    const deleted = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.id, 'note-add'))
      .get()
    expect(deleted).toBeUndefined()

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

    const updated = indexDb.db
      .select()
      .from(noteCache)
      .where(eq(noteCache.id, 'note-rename'))
      .get()

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
})
