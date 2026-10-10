/**
 * A push payload carries a note's *frontmatter* tags only, while the index it
 * lands in holds frontmatter ∪ body `#hashtags` — and the receiving side
 * replaces. Without a merge, a tag that exists only as a body hashtag is wiped
 * from the second device's index on every remote update: the note silently
 * drops out of tag search and the tag hub while its file stays intact (#1471).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-body-tags-'))

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult

vi.mock('../../database', () => ({ getDatabase: () => dataDb.db }))

vi.mock('../../database/client', () => ({
  getIndexDatabase: () => indexDb.db
}))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: vi.fn(() => VAULT_ROOT),
  toRelativePath: vi.fn((p: string) => path.relative(VAULT_ROOT, p)),
  toAbsolutePath: vi.fn((p: string) => path.join(VAULT_ROOT, p))
}))

vi.mock('../../vault/index', () => ({
  getStatus: vi.fn(() => ({ path: VAULT_ROOT }))
}))

vi.mock('../../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(),
  syncFileToCache: vi.fn(),
  deleteNoteFromCache: vi.fn()
}))

vi.mock('../note-sync', () => ({
  extractFolderFromPath: vi.fn(() => null)
}))

vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))

vi.mock('@memry/domain-notes', () => ({ saveCanonicalPropertyDefinition: vi.fn() }))

import { noteHandler } from './note-handler'
import { insertNoteCache, setNoteTags } from '@main/database/queries/notes'
import { NotesChannels } from '@memry/contracts/ipc-channels'

const NOTE_PATH = 'n1.md'
const REMOTE_CLOCK = { 'device-A': 1, 'device-B': 1 }

function seedNote(fileContent: string, bodyTags: string[]): void {
  dataDb.db
    .insert(noteMetadata)
    .values({
      id: 'n1',
      path: NOTE_PATH,
      title: 'n1',
      fileType: 'markdown',
      clock: { 'device-A': 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    })
    .run()
  insertNoteCache(indexDb.db, {
    id: 'n1',
    path: NOTE_PATH,
    title: 'n1',
    contentHash: 'hash-n1',
    wordCount: 0,
    characterCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z'
  })
  setNoteTags(indexDb.db, 'n1', { header: [], inline: bodyTags })

  fs.mkdirSync(VAULT_ROOT, { recursive: true })
  fs.writeFileSync(path.join(VAULT_ROOT, NOTE_PATH), fileContent, 'utf-8')
}

function indexRows(): Array<{ tag: string; in_header: number | null }> {
  return indexDb.db.all(
    sql`SELECT tag, in_header FROM note_tags WHERE note_id = 'n1' ORDER BY position`
  )
}

function readNoteFile(): string {
  return fs.readFileSync(path.join(VAULT_ROOT, NOTE_PATH), 'utf-8')
}

/** The note's frontmatter block alone — body hashtags must not be asserted against. */
function readFrontmatter(): string {
  return readNoteFile().split('---')[1] ?? ''
}

describe('noteHandler.applyUpsert — body hashtags on a synced update', () => {
  let ctx: ApplyContext

  beforeEach(() => {
    vi.clearAllMocks()
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
  })

  afterAll(() => {
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  it('keeps a body-only hashtag in the index when the remote payload carries no tags', () => {
    // #given — the tag lives only in the body, so the sender's payload is empty
    seedNote('---\ntitle: n1\n---\n\nsome body with #work in it\n', ['work', 'stale'])

    // #when
    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      { tags: [], clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    // #then — the index keeps the tag instead of being replaced with []
    expect(result).toBe('applied')
    expect(indexRows()).toEqual([{ tag: 'work', in_header: 0 }])
    // …and nothing body-derived is written back into frontmatter (#1454)
    expect(readFrontmatter()).not.toMatch(/tags:/)
  })

  it('marks the payload tags as header tags and the local body hashtag as inline', () => {
    // #given
    seedNote('---\ntitle: n1\n---\n\nsome body with #work in it\n', ['work'])

    // #when — the other device adds a frontmatter tag
    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      { tags: ['roadmap'], clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    // #then — index carries both; the file's frontmatter carries only the remote half
    expect(result).toBe('applied')
    expect(indexRows()).toEqual([
      { tag: 'roadmap', in_header: 1 },
      { tag: 'work', in_header: 0 }
    ])
    const frontmatter = readFrontmatter()
    expect(frontmatter).toMatch(/roadmap/)
    expect(frontmatter).not.toMatch(/work/)
  })

  it('dedupes case-insensitively with the frontmatter spelling winning', () => {
    // #given — one tag spelled differently on each side, plus a body-only one
    seedNote('---\ntitle: n1\n---\n\nbody with #Work and #focus\n', ['Work', 'focus'])

    // #when
    noteHandler.applyUpsert(ctx, 'n1', { tags: ['work'], clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    expect(indexRows()).toEqual([
      { tag: 'work', in_header: 1 },
      { tag: 'focus', in_header: 0 }
    ])
  })

  it('carries the merged tags on the emitted update, not the remote half alone', () => {
    // #given — the renderer refreshes its tag list from this payload
    seedNote('---\ntitle: n1\n---\n\nbody with #work\n', ['work'])

    // #when
    noteHandler.applyUpsert(ctx, 'n1', { tags: ['roadmap'], clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    // #then
    expect(ctx.emit).toHaveBeenCalledWith(
      NotesChannels.events.UPDATED,
      expect.objectContaining({
        changes: expect.objectContaining({ tags: ['roadmap', 'work'] })
      })
    )
  })

  it('keeps the body hashtag after a remote rename moves the file', () => {
    // #given — the merge reads the file, which this update also renames
    seedNote('---\ntitle: n1\n---\n\nbody with #work\n', ['work'])

    // #when
    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      { title: 'Renamed', tags: ['roadmap'], clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    // #then — read from the new path, not the unlinked old one
    expect(result).toBe('applied')
    expect(indexRows()).toEqual([
      { tag: 'roadmap', in_header: 1 },
      { tag: 'work', in_header: 0 }
    ])
  })

  it('falls back to the remote tags when the note file cannot be read', () => {
    // #given — index row without a file on disk
    seedNote('---\n---\nbody\n', ['stale'])
    fs.rmSync(path.join(VAULT_ROOT, NOTE_PATH))

    // #when
    noteHandler.applyUpsert(ctx, 'n1', { tags: ['roadmap'], clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    // #then — no merge is possible, but the remote half still lands
    expect(indexRows()).toEqual([{ tag: 'roadmap', in_header: 1 }])
  })
})
