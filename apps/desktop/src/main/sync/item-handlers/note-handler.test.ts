import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import * as path from 'path'
import type { ApplyContext } from './types'
import { makeCtx, makeNotePayload } from '@tests/utils/fixtures/sync-item-handlers'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-handler-'))

vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({}))
}))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: vi.fn(() => VAULT_ROOT),
  toRelativePath: vi.fn((p: string) => path.relative(VAULT_ROOT, p)),
  toAbsolutePath: vi.fn((p: string) => path.join(VAULT_ROOT, p))
}))

vi.mock('../../vault/frontmatter', () => ({
  parseNote: vi.fn(() => ({
    frontmatter: { id: 'note-1', title: 'a1', tags: ['local'] },
    content: 'old content'
  })),
  serializeNote: vi.fn(() => '---\n---\ncontent'),
  serializeParsedNote: vi.fn(() => '---\n---\ncontent'),
  inferPropertyType: vi.fn(() => 'number'),
  resolvePropertyType: vi.fn(
    (
      name: string,
      value: unknown,
      definitionType: string | undefined,
      inferFn: (name: string, value: unknown) => string
    ) => (name === 'project' ? 'project' : (definitionType ?? inferFn(name, value)))
  )
}))

vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
  syncFileToCache: vi.fn(),
  deleteNoteFromCache: vi.fn()
}))

const mockGetNoteMetadataById = vi.fn(() => undefined)
const mockUpdateNoteMetadata = vi.fn()
const mockGetPropertyDefinition = vi.fn()

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn(() => undefined),
  getNoteCacheByPath: vi.fn(() => undefined),
  getNoteTags: vi.fn(() => []),
  setNoteTags: vi.fn(),
  updateNoteCache: vi.fn(),
  setNoteProperties: vi.fn()
}))

vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: (...args: unknown[]) => mockGetNoteMetadataById(...args),
  updateNoteMetadata: (...args: unknown[]) => mockUpdateNoteMetadata(...args),
  getPropertyDefinition: (...args: unknown[]) => mockGetPropertyDefinition(...args)
}))

const mockSaveCanonicalPropertyDefinition = vi.fn()
vi.mock('@memry/domain-notes', () => ({
  saveCanonicalPropertyDefinition: (...args: unknown[]) =>
    mockSaveCanonicalPropertyDefinition(...args)
}))

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }))
}))

vi.mock('../note-sync', () => ({
  extractFolderFromPath: vi.fn(() => null)
}))

const mockFlushProjectionEvents = vi.fn()
vi.mock('../../projections', () => ({
  flushProjectionEvents: (...args: unknown[]) => mockFlushProjectionEvents(...args)
}))

// `ctx.db` here is a bare stub, so the frontmatter→project_links reconcile the
// update path performs is stubbed out. Its real behaviour is covered against a
// real data DB in note-handler.project-links.test.ts.
const mockReconcileNoteLinks = vi.fn()
vi.mock('../../projections/projectors/note-project-links-projector', () => ({
  reconcileNoteLinks: (...args: unknown[]) => mockReconcileNoteLinks(...args)
}))
vi.mock('../../database/queries/projects', () => ({
  isMarkdownNote: vi.fn(() => true)
}))

const mockCleanupProjectLinksForDeletedNote = vi.fn(() => Promise.resolve())
vi.mock('../../notes/runtime-effects', () => ({
  cleanupProjectLinksForDeletedNote: (...args: unknown[]) =>
    mockCleanupProjectLinksForDeletedNote(...(args as []))
}))

const mockMarkWritebackIgnored = vi.fn()
vi.mock('../crdt-writeback', () => ({
  markWritebackIgnored: (...args: unknown[]) => mockMarkWritebackIgnored(...args)
}))

const mockApplyPinnedTags = vi.fn()
vi.mock('./note-pin-helpers', () => ({
  applyPinnedTags: (...args: unknown[]) => mockApplyPinnedTags(...args)
}))

vi.mock('./note-handler-sync-helpers', () => ({
  buildNotePushPayload: vi.fn(),
  fetchLocalNote: vi.fn(),
  seedUnclockedNotes: vi.fn()
}))

vi.mock('../../vault/file-ops', async () => {
  const actual =
    await vi.importActual<typeof import('../../vault/file-ops')>('../../vault/file-ops')
  return {
    ...actual,
    atomicWrite: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined)
  }
})

vi.mock('../../vault/attachments', () => ({
  getNoteAttachmentsDir: vi.fn((vaultPath: string, noteId: string) =>
    path.join(vaultPath, 'attachments', noteId)
  )
}))

vi.mock('../../vault/index', () => ({
  getStatus: vi.fn(() => ({ path: VAULT_ROOT }))
}))

import { noteHandler, resetRequestedAttachmentDownloads } from './note-handler'
import { deleteFile } from '../../vault/file-ops'
import { parseNote, serializeParsedNote } from '../../vault/frontmatter'
import { deleteNoteFromCache, syncFileToCache, syncNoteToCache } from '../../vault/note-sync'
import {
  getNoteCacheByPath,
  setNoteProperties,
  setNoteTags,
  updateNoteCache
} from '@main/database/queries/notes'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import { attachmentEvents } from '../attachment-events'
import { extractFolderFromPath } from '../note-sync'
import {
  buildNotePushPayload,
  fetchLocalNote,
  seedUnclockedNotes
} from './note-handler-sync-helpers'

describe('noteHandler.applyUpsert — path collision', () => {
  let ctx: ApplyContext
  const takenRelPaths = new Set<string>()

  afterAll(() => {
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeCtx()
    takenRelPaths.clear()
    mockGetNoteMetadataById.mockReturnValue(undefined)
    mockGetPropertyDefinition.mockReturnValue(undefined)

    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
    fs.mkdirSync(VAULT_ROOT, { recursive: true })

    vi.mocked(getNoteCacheByPath).mockImplementation((_db, p) =>
      takenRelPaths.has(p)
        ? ({ id: 'existing', path: p } as ReturnType<typeof getNoteCacheByPath>)
        : undefined
    )

    vi.mocked(syncNoteToCache).mockImplementation((_db, data, _opts) => {
      takenRelPaths.add(data.path)
      return {} as ReturnType<typeof syncNoteToCache>
    })
    vi.mocked(setNoteProperties).mockImplementation((_db, _itemId, properties, getType) => {
      for (const [name, value] of Object.entries(properties)) {
        getType(name, value)
      }
    })
  })

  it('assigns unique paths when two notes share the same title and folder', () => {
    // #given — two sync payloads with identical title + folder
    const payloadA = makeNotePayload()
    const payloadB = makeNotePayload()

    // #when — both are applied in sequence
    const resultA = noteHandler.applyUpsert(ctx, 'note-1', payloadA, {})
    const resultB = noteHandler.applyUpsert(ctx, 'note-2', payloadB, {})

    // #then — both succeed with different paths
    expect(resultA).toBe('applied')
    expect(resultB).toBe('applied')

    const calls = vi.mocked(syncNoteToCache).mock.calls
    const pathA = calls[0][1].path
    const pathB = calls[1][1].path

    expect(pathA).toBe(path.join('a1', 'a1.md'))
    expect(pathB).toBe(path.join('a1', 'a1 1.md'))
    expect(pathA).not.toBe(pathB)
  })

  it('deduplicates path when local note_cache already has matching path', () => {
    // #given — path already exists in note_cache
    takenRelPaths.add(path.join('a1', 'a1.md'))

    // #when
    const result = noteHandler.applyUpsert(ctx, 'note-new', makeNotePayload(), {})

    // #then
    expect(result).toBe('applied')

    const calls = vi.mocked(syncNoteToCache).mock.calls
    expect(calls[0][1].path).toBe(path.join('a1', 'a1 1.md'))
  })

  it('increments suffix when multiple collisions exist', () => {
    // #given — two paths already taken
    takenRelPaths.add(path.join('a1', 'a1.md'))
    takenRelPaths.add(path.join('a1', 'a1 1.md'))

    // #when
    const result = noteHandler.applyUpsert(ctx, 'note-new', makeNotePayload(), {})

    // #then
    expect(result).toBe('applied')

    const calls = vi.mocked(syncNoteToCache).mock.calls
    expect(calls[0][1].path).toBe(path.join('a1', 'a1 2.md'))
  })

  it('updates existing markdown note tags, properties, emoji, cache metadata, and events', () => {
    // #given — remote metadata is newer for an existing markdown note
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-1',
      title: 'a1',
      path: path.join('a1', 'a1.md'),
      emoji: null,
      fileType: 'markdown',
      mimeType: null,
      fileSize: null,
      attachmentId: null,
      clock: { dev1: 1 },
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-01T00:00:00.000Z'
    })
    fs.mkdirSync(path.join(VAULT_ROOT, 'a1'), { recursive: true })
    fs.writeFileSync(path.join(VAULT_ROOT, 'a1', 'a1.md'), '---\n---\nold content')

    // #when
    const result = noteHandler.applyUpsert(
      ctx,
      'note-1',
      makeNotePayload({
        title: 'a1',
        tags: ['remote'],
        properties: { Rating: 5 },
        pinnedTags: ['remote'],
        emoji: 'sparkles'
      }),
      { dev1: 2 }
    )

    // #then
    expect(result).toBe('applied')
    expect(setNoteTags).toHaveBeenCalledWith({}, 'note-1', ['remote'])
    expect(setNoteProperties).toHaveBeenCalledWith(
      {},
      'note-1',
      { Rating: 5 },
      expect.any(Function)
    )
    expect(mockSaveCanonicalPropertyDefinition).toHaveBeenCalledWith(ctx.db, {
      name: 'Rating',
      type: 'number'
    })
    expect(mockApplyPinnedTags).toHaveBeenCalledWith({}, 'note-1', ['remote'])
    expect(mockUpdateNoteMetadata).toHaveBeenCalledWith(
      ctx.db,
      'note-1',
      expect.objectContaining({
        title: 'a1',
        emoji: 'sparkles',
        clock: { dev1: 2 },
        propertyDefinitionNames: ['Rating']
      })
    )
    // `changes` is not decoration: renderer subscribers dereference it without
    // guarding, so an emit that omits it throws once per pulled note. `content`
    // must stay out — this branch never rewrites the note body.
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.UPDATED, {
      id: 'note-1',
      changes: { title: 'a1', emoji: 'sparkles', tags: ['remote'] },
      source: 'sync'
    })
    expect(ctx.emit).toHaveBeenCalledWith('notes:tags-changed', {})
  })

  it('renames an existing markdown note and removes empty parent folders', () => {
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-1',
      title: 'a1',
      path: path.join('Old', 'a1.md'),
      emoji: null,
      fileType: 'markdown',
      mimeType: null,
      fileSize: null,
      attachmentId: null,
      clock: { dev1: 1 },
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-01T00:00:00.000Z'
    })
    vi.mocked(extractFolderFromPath).mockReturnValueOnce('Old')
    fs.mkdirSync(path.join(VAULT_ROOT, 'Old'), { recursive: true })
    fs.writeFileSync(path.join(VAULT_ROOT, 'Old', 'a1.md'), '---\n---\nold content')
    fs.writeFileSync(path.join(VAULT_ROOT, 'Old', '.DS_Store'), '')

    const result = noteHandler.applyUpsert(
      ctx,
      'note-1',
      makeNotePayload({
        title: 'Renamed',
        folderPath: 'New',
        tags: ['remote'],
        properties: {},
        emoji: 'memo'
      }),
      { dev1: 2 }
    )

    expect(result).toBe('applied')
    expect(serializeParsedNote).toHaveBeenCalled()
    expect(updateNoteCache).toHaveBeenCalledWith(
      {},
      'note-1',
      expect.objectContaining({ path: path.join('New', 'Renamed.md') })
    )
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.RENAMED, {
      id: 'note-1',
      oldPath: path.join('Old', 'a1.md'),
      newPath: path.join('New', 'Renamed.md'),
      oldTitle: 'a1',
      newTitle: 'Renamed',
      source: 'sync'
    })
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.MOVED, {
      id: 'note-1',
      oldPath: path.join('Old', 'a1.md'),
      newPath: path.join('New', 'Renamed.md'),
      source: 'sync'
    })
  })

  it('preserves a legacy bracketed basename on a folder-only move (no retroactive rename)', () => {
    // #given — a legacy on-disk file whose basename predates the sanitizer widening
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-1',
      title: 'Team [q3]',
      path: path.join('Old', 'Team [q3].md'),
      emoji: null,
      fileType: 'markdown',
      mimeType: null,
      fileSize: null,
      attachmentId: null,
      clock: { dev1: 1 },
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-01T00:00:00.000Z'
    })
    vi.mocked(extractFolderFromPath).mockReturnValueOnce('Old')
    fs.mkdirSync(path.join(VAULT_ROOT, 'Old'), { recursive: true })
    fs.writeFileSync(path.join(VAULT_ROOT, 'Old', 'Team [q3].md'), '---\n---\nold content')

    // #when — only the folder changes; the title is unchanged
    const result = noteHandler.applyUpsert(
      ctx,
      'note-1',
      makeNotePayload({ title: 'Team [q3]', folderPath: 'New', properties: {} }),
      { dev1: 2 }
    )

    // #then — basename is preserved byte-for-byte, only the folder moves
    expect(result).toBe('applied')
    expect(updateNoteCache).toHaveBeenCalledWith(
      {},
      'note-1',
      expect.objectContaining({ path: path.join('New', 'Team [q3].md') })
    )
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.MOVED, {
      id: 'note-1',
      oldPath: path.join('Old', 'Team [q3].md'),
      newPath: path.join('New', 'Team [q3].md'),
      source: 'sync'
    })
    expect(ctx.emit).not.toHaveBeenCalledWith(NotesChannels.events.RENAMED, expect.any(Object))
  })

  it('returns conflict for concurrent markdown updates and tolerates frontmatter write failures', () => {
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-1',
      title: 'a1',
      path: path.join('a1', 'a1.md'),
      emoji: null,
      fileType: 'markdown',
      mimeType: null,
      fileSize: null,
      attachmentId: null,
      clock: { dev1: 1 },
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-01T00:00:00.000Z'
    })
    vi.mocked(parseNote).mockImplementationOnce(() => {
      throw new Error('bad yaml')
    })

    const result = noteHandler.applyUpsert(
      ctx,
      'note-1',
      makeNotePayload({
        title: 'a1',
        tags: ['remote'],
        properties: null,
        emoji: 'sparkles'
      }),
      { dev2: 1 }
    )

    expect(result).toBe('conflict')
    expect(updateNoteCache).toHaveBeenCalledWith(
      {},
      'note-1',
      expect.objectContaining({ emoji: 'sparkles', clock: { dev1: 1, dev2: 1 } })
    )
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.UPDATED, {
      id: 'note-1',
      changes: { title: 'a1', emoji: 'sparkles', tags: ['remote'] },
      source: 'sync'
    })
  })

  it('skips an existing markdown note when the local clock is newer', () => {
    // #given
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-1',
      title: 'a1',
      path: path.join('a1', 'a1.md'),
      fileType: 'markdown',
      clock: { dev1: 3 }
    })

    // #when
    const result = noteHandler.applyUpsert(ctx, 'note-1', makeNotePayload(), { dev1: 2 })

    // #then
    expect(result).toBe('skipped')
    expect(mockUpdateNoteMetadata).not.toHaveBeenCalled()
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('creates a binary note placeholder and emits an attachment download request', () => {
    // #given
    const downloads: unknown[] = []
    const handler = (event: unknown) => downloads.push(event)
    attachmentEvents.onDownloadNeeded(handler)

    try {
      // #when
      const result = noteHandler.applyUpsert(
        ctx,
        'file-1',
        makeNotePayload({
          title: 'Report',
          content: undefined,
          fileType: 'pdf',
          mimeType: 'application/pdf',
          attachmentId: 'att-1',
          folderPath: 'Files'
        }),
        { dev1: 1 }
      )

      // #then
      expect(result).toBe('applied')
      expect(syncFileToCache).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          id: 'file-1',
          title: 'Report',
          fileType: 'pdf',
          mimeType: 'application/pdf'
        })
      )
      expect(downloads).toEqual([
        expect.objectContaining({
          noteId: 'file-1',
          attachmentId: 'att-1',
          diskPath: path.join(VAULT_ROOT, 'Files', 'Report.pdf')
        })
      ])
      expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.CREATED, {
        note: {
          id: 'file-1',
          path: path.join('Files', 'Report.pdf'),
          title: 'Report'
        },
        source: 'sync'
      })
    } finally {
      attachmentEvents.offDownloadNeeded(handler)
    }
  })

  it('updates and moves an existing binary note without touching frontmatter', () => {
    mockGetNoteMetadataById.mockReturnValue({
      id: 'file-1',
      title: 'Report',
      path: path.join('Old', 'Report.pdf'),
      emoji: null,
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSize: 1024,
      attachmentId: 'att-old',
      clock: { dev1: 1 },
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-01T00:00:00.000Z'
    })
    vi.mocked(extractFolderFromPath).mockReturnValueOnce('Old')
    fs.mkdirSync(path.join(VAULT_ROOT, 'Old'), { recursive: true })
    fs.writeFileSync(path.join(VAULT_ROOT, 'Old', 'Report.pdf'), 'pdf')

    const result = noteHandler.applyUpsert(
      ctx,
      'file-1',
      makeNotePayload({
        title: 'Quarterly',
        fileType: 'pdf',
        mimeType: 'application/pdf',
        attachmentId: 'att-new',
        folderPath: 'Archive',
        emoji: 'file'
      }),
      { dev1: 2 }
    )

    expect(result).toBe('applied')
    expect(updateNoteCache).toHaveBeenCalledWith(
      {},
      'file-1',
      expect.objectContaining({
        path: path.join('Archive', 'Quarterly.pdf'),
        title: 'Quarterly',
        emoji: 'file'
      })
    )
    expect(mockUpdateNoteMetadata).toHaveBeenCalledWith(
      ctx.db,
      'file-1',
      expect.objectContaining({
        path: path.join('Archive', 'Quarterly.pdf'),
        title: 'Quarterly',
        attachmentId: 'att-new'
      })
    )
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.RENAMED, expect.any(Object))
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.MOVED, expect.any(Object))
  })

  it('applies remote delete only when the remote clock is newer', () => {
    // #given
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-1',
      title: 'a1',
      path: path.join('a1', 'a1.md'),
      fileType: 'markdown',
      clock: { dev1: 1 }
    })

    // #when
    const applied = noteHandler.applyDelete(ctx, 'note-1', { dev1: 2 })

    // #then
    expect(applied).toBe('applied')
    expect(deleteNoteFromCache).toHaveBeenCalledWith({}, 'note-1')
    expect(deleteFile).toHaveBeenCalledWith(path.join(VAULT_ROOT, 'a1', 'a1.md'))
    expect(ctx.emit).toHaveBeenCalledWith(NotesChannels.events.DELETED, {
      id: 'note-1',
      path: path.join('a1', 'a1.md'),
      source: 'sync'
    })
    // A remote delete must run the same project-link cleanup as the local path,
    // otherwise the receiving device keeps orphan links + a dangling home note.
    expect(mockCleanupProjectLinksForDeletedNote).toHaveBeenCalledWith('note-1')

    vi.clearAllMocks()
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-1',
      path: path.join('a1', 'a1.md'),
      clock: { dev1: 3 }
    })

    expect(noteHandler.applyDelete(ctx, 'note-1', { dev1: 2 })).toBe('skipped')
    expect(deleteNoteFromCache).not.toHaveBeenCalled()
    expect(mockCleanupProjectLinksForDeletedNote).not.toHaveBeenCalled()
  })

  it('skips delete for missing notes and deletes without a remote clock', () => {
    mockGetNoteMetadataById.mockReturnValueOnce(undefined)
    expect(noteHandler.applyDelete(ctx, 'missing')).toBe('skipped')

    mockGetNoteMetadataById.mockReturnValueOnce({
      id: 'note-1',
      title: 'a1',
      path: path.join('a1', 'a1.md'),
      fileType: 'markdown',
      clock: { dev1: 1 }
    })

    expect(noteHandler.applyDelete(ctx, 'note-1')).toBe('applied')
    expect(deleteNoteFromCache).toHaveBeenCalledWith({}, 'note-1')
  })

  it('delegates local fetch, push payload build, and seeding to sync helpers', () => {
    vi.mocked(fetchLocalNote).mockReturnValueOnce({ title: 'Local' })
    vi.mocked(buildNotePushPayload).mockReturnValueOnce('{"title":"Local"}')
    vi.mocked(seedUnclockedNotes).mockReturnValueOnce(2)
    const queue = {} as Parameters<typeof noteHandler.seedUnclocked>[2]

    expect(noteHandler.fetchLocal(ctx.db, 'note-1')).toEqual({ title: 'Local' })
    expect(noteHandler.buildPushPayload(ctx.db, 'note-1', 'dev1', 'update')).toBe(
      '{"title":"Local"}'
    )
    expect(noteHandler.seedUnclocked(ctx.db, 'dev1', queue)).toBe(2)
    expect(seedUnclockedNotes).toHaveBeenCalledWith('dev1', queue)
  })
})

describe('noteHandler.applyUpsert — embedded attachment references', () => {
  let ctx: ApplyContext
  let downloadEvents: Array<{
    noteId: string
    attachmentId: string
    diskPath: string
    intoDir?: boolean
  }>
  const listener = (e: {
    noteId: string
    attachmentId: string
    diskPath: string
    intoDir?: boolean
  }): void => {
    downloadEvents.push(e)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = makeCtx()
    downloadEvents = []
    mockGetNoteMetadataById.mockReturnValue(undefined)
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
    fs.mkdirSync(VAULT_ROOT, { recursive: true })
    attachmentEvents.onDownloadNeeded(listener)
  })

  afterEach(() => {
    attachmentEvents.offDownloadNeeded(listener)
  })

  it('requests directory downloads for referenced attachments on create and persists the list', () => {
    const result = noteHandler.applyUpsert(
      ctx,
      'note-att-create',
      makeNotePayload({ attachmentReferences: ['att-a', 'att-b'] }),
      {}
    )

    expect(result).toBe('applied')
    expect(downloadEvents).toEqual([
      {
        noteId: 'note-att-create',
        attachmentId: 'att-a',
        diskPath: path.join(VAULT_ROOT, 'attachments', 'note-att-create'),
        intoDir: true
      },
      {
        noteId: 'note-att-create',
        attachmentId: 'att-b',
        diskPath: path.join(VAULT_ROOT, 'attachments', 'note-att-create'),
        intoDir: true
      }
    ])
    expect(mockUpdateNoteMetadata).toHaveBeenCalledWith(
      expect.anything(),
      'note-att-create',
      expect.objectContaining({ attachmentReferences: ['att-a', 'att-b'] })
    )
  })

  it('merges remote references into local ones on update and dedupes repeated requests', () => {
    mockGetNoteMetadataById.mockReturnValue({
      id: 'note-att-update',
      path: path.join('a1', 'a1.md'),
      title: 'a1',
      emoji: null,
      fileType: 'markdown',
      clock: { d1: 1 },
      attachmentReferences: ['att-a']
    } as unknown as ReturnType<typeof mockGetNoteMetadataById>)

    const payload = makeNotePayload({ folderPath: null, attachmentReferences: ['att-b'] })
    const result = noteHandler.applyUpsert(ctx, 'note-att-update', payload, { d1: 2 })

    expect(result).toBe('applied')
    expect(downloadEvents).toEqual([
      {
        noteId: 'note-att-update',
        attachmentId: 'att-b',
        diskPath: path.join(VAULT_ROOT, 'attachments', 'note-att-update'),
        intoDir: true
      }
    ])
    expect(mockUpdateNoteMetadata).toHaveBeenCalledWith(
      expect.anything(),
      'note-att-update',
      expect.objectContaining({ attachmentReferences: ['att-a', 'att-b'] })
    )

    // Re-applying the same note (steady-state pull) must not re-emit requests.
    downloadEvents = []
    noteHandler.applyUpsert(ctx, 'note-att-update', payload, { d1: 3 })
    expect(downloadEvents).toEqual([])
  })

  it('leaves the stored reference list untouched when the payload carries none', () => {
    const result = noteHandler.applyUpsert(ctx, 'note-att-none', makeNotePayload(), {})

    expect(result).toBe('applied')
    expect(downloadEvents).toEqual([])
    const call = mockUpdateNoteMetadata.mock.calls.find((c) => c[1] === 'note-att-none')
    expect(call).toBeTruthy()
    expect((call![2] as Record<string, unknown>).attachmentReferences).toBeUndefined()
  })

  it('re-requests downloads after a vault teardown clears the session guard', () => {
    // #given — a note whose attachment was already requested this session
    const payload = makeNotePayload({ attachmentReferences: ['att-a'] })
    noteHandler.applyUpsert(ctx, 'note-att-vault', payload, {})
    noteHandler.applyUpsert(ctx, 'note-att-vault', payload, {})
    expect(downloadEvents).toHaveLength(1)

    // #when — the vault is switched (stopSyncRuntime → resetSyncServiceSingletons)
    resetRequestedAttachmentDownloads()
    noteHandler.applyUpsert(ctx, 'note-att-vault', payload, {})

    // #then — the guard no longer carries the previous vault's keys, so the new
    // vault's copy of the note asks for its attachment again
    expect(downloadEvents).toHaveLength(2)
  })
})
