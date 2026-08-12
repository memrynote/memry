import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalChannels, NotesChannels } from '@memry/contracts/ipc-channels'

const mocks = vi.hoisted(() => ({
  yDocToMarkdown: vi.fn(),
  getNoteCacheById: vi.fn(),
  getNoteCacheByPath: vi.fn(),
  getNoteMetadataById: vi.fn(),
  atomicWrite: vi.fn(),
  safeRead: vi.fn(),
  fileExists: vi.fn(),
  generateNotePath: vi.fn(),
  generateUniquePath: vi.fn(),
  ensureDirectory: vi.fn(),
  deleteFile: vi.fn(),
  parseNote: vi.fn(),
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn(),
  getNotesDir: vi.fn(),
  toRelativePath: vi.fn(),
  toAbsolutePath: vi.fn(),
  maybeCreateSignificantSnapshot: vi.fn(),
  getJournalPath: vi.fn(),
  syncNoteToCache: vi.fn(),
  deleteNoteFromCache: vi.fn(),
  flushProjectionEvents: vi.fn(),
  closeDoc: vi.fn(),
  getDoc: vi.fn(),
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn(),
  createRemindersService: vi.fn(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => mocks.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ close: mocks.closeDoc, getDoc: mocks.getDoc })
}))

vi.mock('./blocknote-converter', () => ({
  yDocToMarkdown: (...args: unknown[]) => mocks.yDocToMarkdown(...args)
}))

vi.mock('@memry/shared/utc', () => ({
  utcNow: () => '2026-01-01T00:00:00.000Z'
}))

vi.mock('../vault/file-ops', () => ({
  atomicWrite: (...args: unknown[]) => mocks.atomicWrite(...args),
  safeRead: (...args: unknown[]) => mocks.safeRead(...args),
  fileExists: (...args: unknown[]) => mocks.fileExists(...args),
  generateNotePath: (...args: unknown[]) => mocks.generateNotePath(...args),
  generateUniquePath: (...args: unknown[]) => mocks.generateUniquePath(...args),
  ensureDirectory: (...args: unknown[]) => mocks.ensureDirectory(...args),
  deleteFile: (...args: unknown[]) => mocks.deleteFile(...args)
}))

vi.mock('../vault/frontmatter', () => ({
  parseNote: (...args: unknown[]) => mocks.parseNote(...args),
  serializeNote: (...args: unknown[]) => mocks.serializeNote(...args),
  serializeParsedNote: (...args: unknown[]) => mocks.serializeParsedNote(...args)
}))

vi.mock('../vault/notes', () => ({
  getNotesDir: (...args: unknown[]) => mocks.getNotesDir(...args),
  toRelativePath: (...args: unknown[]) => mocks.toRelativePath(...args),
  toAbsolutePath: (...args: unknown[]) => mocks.toAbsolutePath(...args),
  maybeCreateSignificantSnapshot: (...args: unknown[]) =>
    mocks.maybeCreateSignificantSnapshot(...args)
}))

vi.mock('../vault/journal', () => ({
  getJournalPath: (...args: unknown[]) => mocks.getJournalPath(...args)
}))

vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: (...args: unknown[]) => mocks.syncNoteToCache(...args),
  deleteNoteFromCache: (...args: unknown[]) => mocks.deleteNoteFromCache(...args)
}))

vi.mock('../projections', () => ({
  flushProjectionEvents: (...args: unknown[]) => mocks.flushProjectionEvents(...args)
}))

vi.mock('../database/client', () => ({
  getIndexDatabase: () => ({ kind: 'index-db' }),
  getDatabase: () => ({ kind: 'data-db' })
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (...args: unknown[]) => mocks.getNoteCacheById(...args),
  getNoteCacheByPath: (...args: unknown[]) => mocks.getNoteCacheByPath(...args)
}))

vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (...args: unknown[]) => mocks.getNoteMetadataById(...args)
}))

vi.mock('@memry/app-core/reminders', () => ({
  createRemindersService: (...args: unknown[]) => mocks.createRemindersService(...args)
}))

vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: (...args: unknown[]) => mocks.syncNoteDateReminders(...args),
  clearNoteDateReminders: (...args: unknown[]) => mocks.clearNoteDateReminders(...args)
}))

import {
  cancelPendingWritebacks,
  flushPendingWritebacks,
  getWritebackDebugState,
  getWritebackStateSizes,
  handleSyncDeletion,
  isWritebackIgnored,
  markWritebackIgnored,
  recordNetworkUpdate,
  resetWritebackState,
  scheduleWriteback,
  wasRecentNetworkUpdate
} from './crdt-writeback'

function makeDoc(title = 'Synced title', tags: string[] = []): Y.Doc {
  const doc = new Y.Doc()
  doc.getMap('meta').set('title', title)
  doc.getMap('meta').set('date', '2026-01-01T00:00:00.000Z')
  const tagArray = doc.getArray('tags')
  for (const tag of tags) tagArray.push([tag])
  return doc
}

describe('crdt writeback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    vi.clearAllMocks()
    mocks.sent = []
    mocks.yDocToMarkdown.mockResolvedValue('updated markdown')
    mocks.getNoteCacheById.mockReturnValue({
      id: 'note-1',
      path: 'notes/Existing.md',
      title: 'Existing'
    })
    mocks.getNoteCacheByPath.mockReturnValue(undefined)
    mocks.getNoteMetadataById.mockReturnValue(undefined)
    mocks.safeRead.mockResolvedValue('---\ntitle: Existing\n---\nold markdown')
    mocks.parseNote.mockReturnValue({
      frontmatter: { id: 'note-1', title: 'Existing', tags: ['old'] },
      content: 'old markdown'
    })
    mocks.serializeNote.mockImplementation((frontmatter, markdown) =>
      JSON.stringify({ frontmatter, markdown })
    )
    mocks.serializeParsedNote.mockImplementation((parsed, markdown, options) =>
      JSON.stringify({
        frontmatter: (parsed as { frontmatter: unknown }).frontmatter,
        markdown,
        options
      })
    )
    mocks.toAbsolutePath.mockImplementation((relative: string) => `/vault/${relative}`)
    mocks.toRelativePath.mockImplementation((absolute: string) => absolute.replace('/vault/', ''))
    mocks.getNotesDir.mockReturnValue('/vault/notes')
    mocks.generateNotePath.mockReturnValue('/vault/notes/New.md')
    mocks.generateUniquePath.mockImplementation((p: string) => Promise.resolve(p))
    mocks.getJournalPath.mockImplementation((date: string) => `/vault/journal/${date}.md`)
    mocks.fileExists.mockResolvedValue(false)
    mocks.atomicWrite.mockResolvedValue(undefined)
    mocks.deleteFile.mockResolvedValue(undefined)
    mocks.ensureDirectory.mockResolvedValue(undefined)
    mocks.closeDoc.mockResolvedValue(undefined)
    // Default: the note is not in the provider's map (closed, or never opened
    // through the provider), so a pending write-back falls back to the doc it
    // captured — the behaviour every case below except the reopen ones wants.
    mocks.getDoc.mockReturnValue(undefined)
    mocks.maybeCreateSignificantSnapshot.mockReturnValue({ id: 'snap-1' })
  })

  afterEach(() => {
    cancelPendingWritebacks()
    vi.useRealTimers()
  })

  it('tracks ignored write and recent network update TTL windows', () => {
    markWritebackIgnored('/vault/notes/A.md')
    expect(isWritebackIgnored('/vault/notes/A.md')).toBe(true)

    vi.advanceTimersByTime(5000)
    expect(isWritebackIgnored('/vault/notes/A.md')).toBe(false)

    recordNetworkUpdate('note-1')
    expect(wasRecentNetworkUpdate('note-1')).toBe(true)

    vi.advanceTimersByTime(2000)
    expect(wasRecentNetworkUpdate('note-1')).toBe(false)
  })

  it('debounces and writes back an existing markdown note with merged frontmatter', async () => {
    scheduleWriteback('note-1', makeDoc('Yjs title', ['new-tag']))
    scheduleWriteback('note-1', makeDoc('Latest title', ['new-tag']))

    expect(getWritebackDebugState('note-1')).toMatchObject({
      pending: true,
      scheduledCount: 2
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.yDocToMarkdown).toHaveBeenCalledTimes(1)
    expect(mocks.maybeCreateSignificantSnapshot).toHaveBeenCalledWith(
      'note-1',
      expect.any(String),
      'old markdown',
      'updated markdown',
      'Existing'
    )
    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      '/vault/notes/Existing.md',
      expect.stringContaining('updated markdown')
    )
    expect(mocks.syncNoteToCache).toHaveBeenCalledWith(
      { kind: 'index-db' },
      expect.objectContaining({ id: 'note-1', path: 'notes/Existing.md' }),
      { isNew: false }
    )
    // The body changed here, so `content` rides along — that is what lets an
    // open editor pick up a remote edit instead of showing stale text.
    expect(mocks.sent).toContainEqual({
      channel: NotesChannels.events.UPDATED,
      payload: { id: 'note-1', changes: { content: 'updated markdown' }, source: 'sync' }
    })
    expect(getWritebackDebugState('note-1')).toMatchObject({
      pending: false,
      performedCount: 1,
      lastMarkdown: 'updated markdown'
    })
  })

  it('keeps no debug state (and no note markdown) outside test mode', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      scheduleWriteback('note-prod', makeDoc('Yjs title'))
      expect(getWritebackDebugState('note-prod')).toBeNull()

      await vi.advanceTimersByTimeAsync(500)

      // The write-back itself still runs; only the debug bookkeeping is skipped.
      expect(mocks.atomicWrite).toHaveBeenCalledWith(
        '/vault/notes/Existing.md',
        expect.stringContaining('updated markdown')
      )
      expect(getWritebackDebugState('note-prod')).toBeNull()
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('serializes CriticMarkup marks from the Y.Doc during existing note writeback', async () => {
    const markdown = 'updated markdown added deleted'
    const doc = makeDoc('Yjs title')
    doc.getArray('criticMarkupMarks').push([
      {
        id: 'add-1',
        kind: 'addition',
        visibleText: 'added',
        start: markdown.indexOf('added'),
        end: markdown.indexOf('added') + 'added'.length
      },
      {
        id: 'del-1',
        kind: 'deletion',
        visibleText: 'deleted',
        originalText: 'deleted',
        start: markdown.indexOf('deleted'),
        end: markdown.indexOf('deleted') + 'deleted'.length
      }
    ])
    mocks.yDocToMarkdown.mockResolvedValueOnce(markdown)

    scheduleWriteback('note-1', doc)
    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      '/vault/notes/Existing.md',
      expect.stringContaining('updated markdown {++added++} {--deleted--}')
    )
    expect(mocks.syncNoteToCache).toHaveBeenCalledWith(
      { kind: 'index-db' },
      expect.objectContaining({ parsedContent: 'updated markdown {++added++} {--deleted--}' }),
      { isNew: false }
    )
  })

  it('treats a note the item handler already applied as existing while its index row is still projecting', async () => {
    // The note handler writes note_metadata synchronously but only queues the
    // note_cache row (`void flushProjectionEvents()`), so a write-back landing
    // in that gap used to look "new" and clobber the freshly-applied title and
    // path with the Y.Doc meta title — the "Untitled" a note is born with.
    mocks.getNoteCacheById.mockReturnValue(undefined)
    mocks.getNoteMetadataById.mockReturnValue({
      id: 'note-applied',
      path: 'notes/Real Title.md',
      title: 'Real Title',
      createdAt: '2025-12-01T00:00:00.000Z',
      localOnly: false,
      emoji: null
    })

    scheduleWriteback('note-applied', makeDoc('Untitled'))
    await vi.advanceTimersByTimeAsync(500)

    // #then no second file, no CREATED event, and the applied title survives
    expect(mocks.generateNotePath).not.toHaveBeenCalled()
    expect(mocks.sent).not.toContainEqual(
      expect.objectContaining({ channel: NotesChannels.events.CREATED })
    )
    expect(mocks.syncNoteToCache).toHaveBeenCalledWith(
      { kind: 'index-db' },
      expect.objectContaining({
        id: 'note-applied',
        path: 'notes/Real Title.md',
        title: 'Real Title'
      }),
      { isNew: false }
    )
  })

  it('creates a new markdown note when cache has no path for the synced id', async () => {
    mocks.getNoteCacheById.mockReturnValue(undefined)

    scheduleWriteback('note-new', makeDoc('New Note', ['tag-a']))
    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.generateNotePath).toHaveBeenCalledWith('/vault/notes', 'New Note')
    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      '/vault/notes/New.md',
      expect.stringContaining('updated markdown')
    )
    expect(mocks.syncNoteToCache).toHaveBeenCalledWith(
      { kind: 'index-db' },
      expect.objectContaining({ id: 'note-new', path: 'notes/New.md' }),
      { isNew: true }
    )
    expect(mocks.sent).toContainEqual({
      channel: NotesChannels.events.CREATED,
      payload: {
        note: { id: 'note-new', path: 'notes/New.md', title: 'New Note' },
        source: 'sync'
      }
    })
  })

  it('writes journal entries and emits a journal-created event for uncached journals', async () => {
    mocks.getNoteCacheById.mockReturnValue(undefined)

    scheduleWriteback('j2026-01-02', makeDoc('Ignored', ['journal']))
    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.ensureDirectory).toHaveBeenCalledWith('/vault/journal')
    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      '/vault/journal/2026-01-02.md',
      expect.stringContaining('2026-01-02')
    )
    expect(mocks.sent).toContainEqual({
      channel: JournalChannels.events.ENTRY_CREATED,
      payload: { date: '2026-01-02', source: 'sync' }
    })
  })

  it('writes a collision file when a synced journal date already belongs to another id', async () => {
    mocks.getNoteCacheById.mockReturnValue(undefined)
    mocks.fileExists.mockResolvedValue(true)
    // Collision detection keys on the note_cache row at the journal path,
    // not on a frontmatter id (files no longer carry one)
    mocks.getNoteCacheByPath.mockReturnValue({
      id: 'local-journal',
      path: 'journal/2026-01-03.md',
      title: '2026-01-03'
    })

    scheduleWriteback('j2026-01-03', makeDoc('Collision'))
    await vi.advanceTimersByTimeAsync(500)

    expect(mocks.getNoteCacheByPath).toHaveBeenCalledWith(
      { kind: 'index-db' },
      'journal/2026-01-03.md'
    )
    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      '/vault/journal/2026-01-03-j2026-01.md',
      expect.stringContaining('updated markdown')
    )
    expect(mocks.sent).toContainEqual({
      channel: 'sync:journal-conflict',
      payload: {
        date: '2026-01-03',
        incomingId: 'j2026-01-03',
        existingId: 'local-journal',
        collisionPath: 'journal/2026-01-03-j2026-01.md'
      }
    })
  })

  it('deletes synced note files, closes CRDT docs, and emits note or journal deletion events', async () => {
    await handleSyncDeletion('note-1')

    expect(mocks.deleteNoteFromCache).toHaveBeenCalledWith({ kind: 'index-db' }, 'note-1')
    expect(mocks.deleteFile).toHaveBeenCalledWith('/vault/notes/Existing.md')
    expect(mocks.closeDoc).toHaveBeenCalledWith('note-1')
    expect(mocks.sent).toContainEqual({
      channel: NotesChannels.events.DELETED,
      payload: {
        id: 'note-1',
        path: 'notes/Existing.md',
        date: undefined,
        source: 'sync'
      }
    })

    mocks.sent = []
    mocks.getNoteCacheById.mockReturnValue({
      id: 'j2026-01-04',
      path: 'journal/2026-01-04.md',
      title: 'Journal'
    })

    await handleSyncDeletion('j2026-01-04')

    expect(mocks.sent).toContainEqual({
      channel: JournalChannels.events.ENTRY_DELETED,
      payload: {
        id: 'j2026-01-04',
        path: 'journal/2026-01-04.md',
        date: '2026-01-04',
        source: 'sync'
      }
    })
  })

  it('flushPendingWritebacks runs a scheduled write-back without advancing the debounce timer', async () => {
    scheduleWriteback('note-1', makeDoc('Pending title', ['flush-tag']))
    expect(mocks.atomicWrite).not.toHaveBeenCalled()

    await flushPendingWritebacks()

    expect(mocks.atomicWrite).toHaveBeenCalledWith(
      '/vault/notes/Existing.md',
      expect.stringContaining('updated markdown')
    )
  })

  it('flushPendingWritebacks clears pending timers so they do not fire a second time', async () => {
    scheduleWriteback('note-1', makeDoc('Pending title'))

    await flushPendingWritebacks()
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(1)
  })

  it('flushPendingWritebacks with nothing pending is a no-op', async () => {
    await flushPendingWritebacks()
    expect(mocks.atomicWrite).not.toHaveBeenCalled()
  })

  it('flushPendingWritebacks swallows a failing write-back and logs instead of rejecting', async () => {
    mocks.yDocToMarkdown.mockRejectedValueOnce(new Error('conversion boom'))
    scheduleWriteback('note-1', makeDoc('Pending title'))

    await expect(flushPendingWritebacks()).resolves.toBeUndefined()
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Write-back failed during shutdown flush',
      expect.objectContaining({ noteId: 'note-1' })
    )
  })

  /**
   * Burn `ms` of clock inside the conversion — the dominant stage of a pass —
   * and hand back a different body every time so the no-op guard never trips.
   * Measured real costs: ~36ms for a 2KB note, ~134ms at 12KB, ~430ms at 49KB.
   */
  function withWritebackCost(ms: number): () => number {
    let pass = 0
    mocks.yDocToMarkdown.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + ms))
      return `updated markdown ${pass++}`
    })
    return () => pass
  }

  /** 60 updates 500ms apart — the rhythm that fires the debounce every time. */
  async function typeFor30Seconds(): Promise<void> {
    for (let i = 0; i < 60; i++) {
      scheduleWriteback('note-1', makeDoc('Typing', ['new-tag']))
      await vi.advanceTimersByTimeAsync(500)
    }
    await vi.advanceTimersByTimeAsync(5000)
  }

  it('throttles the write-back pipeline in proportion to what the last pass cost', async () => {
    withWritebackCost(200)

    await typeFor30Seconds()

    // A 200ms pass buys a 1800ms cooldown, so passes land every ~2s of wall
    // clock: 16 full serialize→read→parse→write→reindex cycles instead of the
    // 60 this rhythm used to cost, and write-back now burns ~10% of a core
    // instead of 40%.
    expect(mocks.yDocToMarkdown).toHaveBeenCalledTimes(16)
    expect(mocks.safeRead).toHaveBeenCalledTimes(16)
    expect(mocks.parseNote).toHaveBeenCalledTimes(16)
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(16)
    expect(mocks.syncNoteToCache).toHaveBeenCalledTimes(16)

    // The file still ends up holding the last body the doc produced, byte for
    // byte what an unthrottled pass would have written.
    expect(mocks.atomicWrite).toHaveBeenLastCalledWith(
      '/vault/notes/Existing.md',
      JSON.stringify({
        frontmatter: { id: 'note-1', title: 'Existing', tags: ['new-tag'] },
        markdown: 'updated markdown 15',
        options: { frontmatterEdited: true }
      })
    )
  })

  it('leaves cheap notes on the plain 500ms debounce', async () => {
    withWritebackCost(0)

    await typeFor30Seconds()

    // A pass that costs nothing earns no cooldown: unchanged from before.
    expect(mocks.yDocToMarkdown).toHaveBeenCalledTimes(60)
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(60)
  })

  it('caps the cooldown so a pathologically slow pass cannot strand the file', async () => {
    withWritebackCost(3000)

    await typeFor30Seconds()

    // 3000ms * 9 would be 27s of cooldown; the 5s ceiling keeps the file
    // catching up during the run instead of only at the end.
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(7)
  })

  it('flushPendingWritebacks still lands a write-back that is inside its cooldown', async () => {
    withWritebackCost(200)

    scheduleWriteback('note-1', makeDoc('First', ['new-tag']))
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(1)

    // Second edit lands inside the 1800ms cooldown, so its timer has not fired.
    scheduleWriteback('note-1', makeDoc('Second', ['new-tag']))
    await vi.advanceTimersByTimeAsync(500)
    expect(mocks.atomicWrite).toHaveBeenCalledTimes(1)

    await flushPendingWritebacks()

    expect(mocks.atomicWrite).toHaveBeenCalledTimes(2)
    expect(mocks.atomicWrite).toHaveBeenLastCalledWith(
      '/vault/notes/Existing.md',
      JSON.stringify({
        frontmatter: { id: 'note-1', title: 'Existing', tags: ['new-tag'] },
        markdown: 'updated markdown 1',
        options: { frontmatterEdited: true }
      })
    )
  })

  /**
   * The note's markdown file, for real: `safeRead` hands back what the last
   * `atomicWrite` put there, and the body written is a pure function of the doc
   * that was serialized. That is what makes an overwrite by a stale doc show up
   * as the wrong bytes in the file instead of as a mock-call shape.
   */
  describe('a note closed and reopened inside the debounce window', () => {
    let vaultFile = ''

    function makeDocWithBody(body: string): Y.Doc {
      const doc = makeDoc('Existing')
      doc.getText('body').insert(0, body)
      return doc
    }

    beforeEach(() => {
      vaultFile = ''
      mocks.yDocToMarkdown.mockImplementation(async (doc: Y.Doc) => doc.getText('body').toString())
      mocks.safeRead.mockImplementation(async () => vaultFile)
      mocks.atomicWrite.mockImplementation(async (_path: string, content: string) => {
        vaultFile = content
      })
      mocks.parseNote.mockImplementation((raw: string) => ({ frontmatter: {}, content: raw }))
      mocks.serializeParsedNote.mockImplementation((_parsed, markdown: string) => markdown)
      mocks.serializeNote.mockImplementation((_frontmatter, markdown: string) => markdown)
    })

    it('does not overwrite the file with the superseded doc when the note was reopened', async () => {
      // #given — the user edits, arming a write-back against the doc that is
      // live right now
      const closedDoc = makeDocWithBody('paragraph one')
      vaultFile = 'paragraph one'
      scheduleWriteback('note-1', closedDoc)

      // #when — the note is closed and reopened inside the debounce: the
      // provider's map now holds a different Y.Doc for the same id, and a sync
      // pull has already landed the remote paragraph in both the file and the
      // reopened doc
      const reopenedDoc = makeDocWithBody('paragraph one\n\nparagraph two from another device')
      vaultFile = 'paragraph one\n\nparagraph two from another device'
      mocks.getDoc.mockReturnValue(reopenedDoc)
      // What `CrdtProvider.close()` does to the doc it superseded. It is not
      // what makes this safe: a destroyed Y.Doc keeps its store readable, so
      // the stale pass would serialize it just fine.
      closedDoc.destroy()
      expect(closedDoc.getText('body').toString()).toBe('paragraph one')

      await vi.advanceTimersByTimeAsync(500)

      // #then — the file still holds the live content. Serializing the
      // superseded doc here would have written 'paragraph one' back over it and
      // destroyed the pulled paragraph.
      expect(vaultFile).toBe('paragraph one\n\nparagraph two from another device')
      expect(mocks.atomicWrite).not.toHaveBeenCalled()
    })

    it('writes the reopened doc, so content only that doc has still reaches disk', async () => {
      // #given — same race, but this time the file is the stale side: the
      // reopened doc holds content that has not been written yet
      const closedDoc = makeDocWithBody('paragraph one')
      vaultFile = 'paragraph one'
      scheduleWriteback('note-1', closedDoc)

      const reopenedDoc = makeDocWithBody('paragraph one\n\nparagraph two from another device')
      mocks.getDoc.mockReturnValue(reopenedDoc)

      await vi.advanceTimersByTimeAsync(500)

      // #then — the pass serialized the live doc, so the new paragraph lands.
      // Serializing the superseded doc would have produced a byte-identical
      // no-op and left it on disk-less limbo until the next edit.
      expect(vaultFile).toBe('paragraph one\n\nparagraph two from another device')
      expect(mocks.atomicWrite).toHaveBeenCalledWith(
        '/vault/notes/Existing.md',
        'paragraph one\n\nparagraph two from another device'
      )
    })

    it('still lands a pending write-back for a note that was NOT superseded', async () => {
      // #given — the note stays open on the same doc for the whole debounce
      const liveDoc = makeDocWithBody('paragraph one edited')
      vaultFile = 'paragraph one'
      mocks.getDoc.mockReturnValue(liveDoc)

      scheduleWriteback('note-1', liveDoc)
      await vi.advanceTimersByTimeAsync(500)

      expect(vaultFile).toBe('paragraph one edited')
    })

    it('still lands a pending write-back for a note that was closed and not reopened', async () => {
      // #given — the note is closed (or LRU-evicted) before the timer fires, so
      // the provider has no doc for it. The captured doc is the last known
      // state and must not be dropped on the floor.
      const closedDoc = makeDocWithBody('paragraph one edited')
      vaultFile = 'paragraph one'
      scheduleWriteback('note-1', closedDoc)
      mocks.getDoc.mockReturnValue(undefined)

      await vi.advanceTimersByTimeAsync(500)

      expect(vaultFile).toBe('paragraph one edited')
    })

    it('resolves the live doc on the shutdown flush too', async () => {
      const closedDoc = makeDocWithBody('paragraph one')
      vaultFile = 'paragraph one\n\nparagraph two from another device'
      scheduleWriteback('note-1', closedDoc)

      mocks.getDoc.mockReturnValue(
        makeDocWithBody('paragraph one\n\nparagraph two from another device')
      )
      await flushPendingWritebacks()

      expect(vaultFile).toBe('paragraph one\n\nparagraph two from another device')
      expect(mocks.atomicWrite).not.toHaveBeenCalled()
    })
  })
})

describe('crdt-writeback per-vault state reset', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetWritebackState()
  })

  afterEach(() => {
    cancelPendingWritebacks()
    resetWritebackState()
    vi.useRealTimers()
  })

  it('drops ignored writes, network-update marks and debug state on vault teardown', () => {
    // #given — a vault session that populated every module-level per-note map
    markWritebackIgnored('/vault-a/notes/One.md')
    recordNetworkUpdate('note-1')
    scheduleWriteback('note-1', makeDoc('One'))

    expect(isWritebackIgnored('/vault-a/notes/One.md')).toBe(true)
    expect(wasRecentNetworkUpdate('note-1')).toBe(true)
    expect(getWritebackDebugState('note-1')).not.toBeNull()

    // #when — the vault is closed (CrdtProvider.destroy)
    cancelPendingWritebacks()
    resetWritebackState()

    // #then — nothing from the old vault survives into the next one
    expect(isWritebackIgnored('/vault-a/notes/One.md')).toBe(false)
    expect(wasRecentNetworkUpdate('note-1')).toBe(false)
    expect(getWritebackDebugState('note-1')).toBeNull()
    expect(getWritebackStateSizes()).toEqual({
      ignoredWrites: 0,
      networkUpdates: 0,
      debugState: 0
    })
  })

  it('evicts expired network-update marks instead of keeping one per note forever', () => {
    // #given — a note that received a network update
    recordNetworkUpdate('note-old')
    expect(wasRecentNetworkUpdate('note-old')).toBe(true)

    // #when — the concurrent-edit window passes and any other note updates.
    // `wasRecentNetworkUpdate('note-old')` is deliberately NOT called here: it
    // used to be the only thing that ever deleted an entry, so a note nobody
    // re-reads is exactly the case that leaked.
    vi.advanceTimersByTime(2500)
    recordNetworkUpdate('note-new')

    // #then — only the fresh note is still held; the stale key was evicted
    // rather than merely reported as expired
    expect(getWritebackStateSizes().networkUpdates).toBe(1)
    expect(wasRecentNetworkUpdate('note-old')).toBe(false)
    expect(wasRecentNetworkUpdate('note-new')).toBe(true)
  })

  it('evicts expired ignored writes from the write path, not only from watcher reads', () => {
    // #given — a write-back marked a file as self-written
    markWritebackIgnored('/vault-a/notes/Old.md')

    // #when — the TTL passes and another write-back lands, with no watcher event
    // in between (a stopped watcher never calls `isWritebackIgnored`)
    vi.advanceTimersByTime(6000)
    markWritebackIgnored('/vault-a/notes/New.md')

    // #then — the expired entry did not survive the session
    expect(getWritebackStateSizes().ignoredWrites).toBe(1)
    expect(isWritebackIgnored('/vault-a/notes/Old.md')).toBe(false)
    expect(isWritebackIgnored('/vault-a/notes/New.md')).toBe(true)
  })
})
