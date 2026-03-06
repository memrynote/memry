import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DrizzleDb } from './types'

const VAULT_ROOT = '/tmp/test-vault-binary'

vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({}))
}))

vi.mock('../../vault/notes', () => ({
  getNotesDir: vi.fn(() => `${VAULT_ROOT}/notes`),
  toRelativePath: vi.fn((p: string) => p.replace(`${VAULT_ROOT}/`, '')),
  toAbsolutePath: vi.fn((p: string) => `${VAULT_ROOT}/${p}`)
}))

vi.mock('../../vault/frontmatter', () => ({
  parseNote: vi.fn(() => ({ content: 'markdown content', frontmatter: { tags: ['tag1'] } }))
}))

vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
  deleteNoteFromCache: vi.fn()
}))

const mockGetNoteCacheById = vi.fn()

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: (...args: unknown[]) => mockGetNoteCacheById(...args),
  getNoteCacheByPath: vi.fn(() => undefined),
  updateNoteCache: vi.fn(),
  getNoteProperties: vi.fn(() => []),
  setNoteProperties: vi.fn(),
  getPropertyType: vi.fn(),
  setNoteTags: vi.fn(),
  getNoteTags: vi.fn(() => [])
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
  extractFolderFromPath: vi.fn((p: string) => {
    const parts = p.split('/')
    return parts.length > 2 ? parts[1] : null
  })
}))

vi.mock('../../vault/file-ops', async () => {
  const actual =
    await vi.importActual<typeof import('../../vault/file-ops')>('../../vault/file-ops')
  return {
    ...actual,
    atomicWrite: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    generateNotePath: vi.fn(),
    generateUniquePathSync: vi.fn()
  }
})

vi.mock('./note-pin-helpers', () => ({
  getPinnedTagsForNote: vi.fn(() => []),
  applyPinnedTags: vi.fn()
}))

vi.mock('../crdt-writeback', () => ({
  markWritebackIgnored: vi.fn()
}))

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(() => '---\ntags: [tag1]\n---\nmarkdown content'),
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn()
  }
}))

import { noteHandler } from './note-handler'

function makeCachedNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'note-1',
    title: 'test-file',
    path: 'notes/folder/test-file.md',
    emoji: null,
    fileType: 'markdown',
    clock: { dev1: 1 },
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('noteHandler.buildPushPayload — binary guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns metadata-only payload for PDF files (no content, tags, properties)', () => {
    // #given
    mockGetNoteCacheById.mockReturnValue(makeCachedNote({ fileType: 'pdf', title: 'report' }))

    // #when
    const result = noteHandler.buildPushPayload!({} as DrizzleDb, 'note-1', 'dev1', 'create')
    const parsed = JSON.parse(result!)

    // #then
    expect(parsed.title).toBe('report')
    expect(parsed.fileType).toBe('pdf')
    expect(parsed).not.toHaveProperty('content')
    expect(parsed).not.toHaveProperty('tags')
    expect(parsed).not.toHaveProperty('properties')
    expect(parsed).not.toHaveProperty('pinnedTags')
  })

  it('returns metadata-only payload for image files', () => {
    // #given
    mockGetNoteCacheById.mockReturnValue(makeCachedNote({ fileType: 'image', title: 'photo' }))

    // #when
    const result = noteHandler.buildPushPayload!({} as DrizzleDb, 'note-1', 'dev1', 'update')
    const parsed = JSON.parse(result!)

    // #then
    expect(parsed.fileType).toBe('image')
    expect(parsed).not.toHaveProperty('content')
    expect(parsed).not.toHaveProperty('tags')
  })

  it('returns metadata-only payload for video files', () => {
    // #given
    mockGetNoteCacheById.mockReturnValue(makeCachedNote({ fileType: 'video', title: 'clip' }))

    // #when
    const result = noteHandler.buildPushPayload!({} as DrizzleDb, 'note-1', 'dev1', 'create')
    const parsed = JSON.parse(result!)

    // #then
    expect(parsed.fileType).toBe('video')
    expect(parsed).not.toHaveProperty('content')
  })

  it('returns metadata-only payload for audio files', () => {
    // #given
    mockGetNoteCacheById.mockReturnValue(makeCachedNote({ fileType: 'audio', title: 'recording' }))

    // #when
    const result = noteHandler.buildPushPayload!({} as DrizzleDb, 'note-1', 'dev1', 'create')
    const parsed = JSON.parse(result!)

    // #then
    expect(parsed.fileType).toBe('audio')
    expect(parsed).not.toHaveProperty('content')
  })

  it('includes content field for markdown files on create', () => {
    // #given
    mockGetNoteCacheById.mockReturnValue(makeCachedNote({ fileType: 'markdown' }))

    // #when
    const result = noteHandler.buildPushPayload!({} as DrizzleDb, 'note-1', 'dev1', 'create')
    const parsed = JSON.parse(result!)

    // #then
    expect(parsed.fileType).toBe('markdown')
    expect(parsed).toHaveProperty('content')
    expect(parsed).toHaveProperty('tags')
    expect(parsed).toHaveProperty('properties')
    expect(parsed).toHaveProperty('pinnedTags')
  })

  it('preserves clock and timestamps in binary payload', () => {
    // #given
    mockGetNoteCacheById.mockReturnValue(
      makeCachedNote({
        fileType: 'pdf',
        clock: { dev1: 3, dev2: 1 },
        createdAt: '2024-06-15T10:00:00.000Z',
        modifiedAt: '2024-06-15T12:00:00.000Z'
      })
    )

    // #when
    const result = noteHandler.buildPushPayload!({} as DrizzleDb, 'note-1', 'dev1', 'create')
    const parsed = JSON.parse(result!)

    // #then
    expect(parsed.clock).toEqual({ dev1: 3, dev2: 1 })
    expect(parsed.createdAt).toBe('2024-06-15T10:00:00.000Z')
    expect(parsed.modifiedAt).toBe('2024-06-15T12:00:00.000Z')
  })

  it('returns null when cached note not found', () => {
    // #given
    mockGetNoteCacheById.mockReturnValue(undefined)

    // #when
    const result = noteHandler.buildPushPayload!({} as DrizzleDb, 'note-1', 'dev1', 'create')

    // #then
    expect(result).toBeNull()
  })
})
