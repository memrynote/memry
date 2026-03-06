import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import * as path from 'path'
import type { ApplyContext } from './types'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-handler-'))
const NOTES_DIR = path.join(VAULT_ROOT, 'notes')

vi.mock('../../database/client', () => ({
  getIndexDatabase: vi.fn(() => ({}))
}))

vi.mock('../../vault/notes', () => ({
  getNotesDir: vi.fn(() => NOTES_DIR),
  toRelativePath: vi.fn((p: string) => path.relative(VAULT_ROOT, p)),
  toAbsolutePath: vi.fn((p: string) => path.join(VAULT_ROOT, p))
}))

vi.mock('../../vault/frontmatter', () => ({
  serializeNote: vi.fn(() => '---\n---\ncontent')
}))

vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
  deleteNoteFromCache: vi.fn()
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn(() => undefined),
  getNoteCacheByPath: vi.fn(() => undefined),
  updateNoteCache: vi.fn()
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

vi.mock('../../vault/file-ops', async () => {
  const actual =
    await vi.importActual<typeof import('../../vault/file-ops')>('../../vault/file-ops')
  return {
    ...actual,
    atomicWrite: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined)
  }
})

import { noteHandler } from './note-handler'
import { syncNoteToCache } from '../../vault/note-sync'
import { getNoteCacheByPath } from '@main/database/queries/notes'

function makeCtx(): ApplyContext {
  return {
    db: {} as ApplyContext['db'],
    emit: vi.fn()
  }
}

function makePayload(overrides: Partial<NoteSyncPayload> = {}): NoteSyncPayload {
  return {
    title: 'a1',
    content: 'test content',
    folderPath: 'a1',
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-01T00:00:00.000Z',
    tags: [],
    ...overrides
  }
}

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

    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
    fs.mkdirSync(NOTES_DIR, { recursive: true })

    vi.mocked(getNoteCacheByPath).mockImplementation((_db, p) =>
      takenRelPaths.has(p)
        ? ({ id: 'existing', path: p } as ReturnType<typeof getNoteCacheByPath>)
        : undefined
    )

    vi.mocked(syncNoteToCache).mockImplementation((_db, data, _opts) => {
      takenRelPaths.add(data.path)
      return {} as ReturnType<typeof syncNoteToCache>
    })
  })

  it('assigns unique paths when two notes share the same title and folder', () => {
    // #given — two sync payloads with identical title + folder
    const payloadA = makePayload()
    const payloadB = makePayload()

    // #when — both are applied in sequence
    const resultA = noteHandler.applyUpsert(ctx, 'note-1', payloadA, {})
    const resultB = noteHandler.applyUpsert(ctx, 'note-2', payloadB, {})

    // #then — both succeed with different paths
    expect(resultA).toBe('applied')
    expect(resultB).toBe('applied')

    const calls = vi.mocked(syncNoteToCache).mock.calls
    const pathA = calls[0][1].path
    const pathB = calls[1][1].path

    expect(pathA).toBe(path.join('notes', 'a1', 'a1.md'))
    expect(pathB).toBe(path.join('notes', 'a1', 'a1 1.md'))
    expect(pathA).not.toBe(pathB)
  })

  it('deduplicates path when local note_cache already has matching path', () => {
    // #given — path already exists in note_cache
    takenRelPaths.add(path.join('notes', 'a1', 'a1.md'))

    // #when
    const result = noteHandler.applyUpsert(ctx, 'note-new', makePayload(), {})

    // #then
    expect(result).toBe('applied')

    const calls = vi.mocked(syncNoteToCache).mock.calls
    expect(calls[0][1].path).toBe(path.join('notes', 'a1', 'a1 1.md'))
  })

  it('increments suffix when multiple collisions exist', () => {
    // #given — two paths already taken
    takenRelPaths.add(path.join('notes', 'a1', 'a1.md'))
    takenRelPaths.add(path.join('notes', 'a1', 'a1 1.md'))

    // #when
    const result = noteHandler.applyUpsert(ctx, 'note-new', makePayload(), {})

    // #then
    expect(result).toBe('applied')

    const calls = vi.mocked(syncNoteToCache).mock.calls
    expect(calls[0][1].path).toBe(path.join('notes', 'a1', 'a1 2.md'))
  })
})
