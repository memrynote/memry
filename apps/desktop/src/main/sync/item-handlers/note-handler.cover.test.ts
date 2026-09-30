/**
 * A note's cover lives in frontmatter (`cover`, `coverFocus`, `coverCredit`,
 * `coverCreditUrl`), and those keys are reserved from `properties`, so the
 * payload carries them in their own `cover` field. These run against real note
 * files and the real frontmatter parser: the assertion is what lands on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { NoteSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const VAULT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-cover-'))

let dataDb: TestDatabaseResult

vi.mock('../../database', () => ({ getDatabase: () => dataDb.db }))

vi.mock('../../database/client', () => ({
  getDatabase: () => dataDb.db,
  getIndexDatabase: vi.fn(() => ({}))
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn(() => undefined),
  getNoteCacheByPath: vi.fn(() => undefined),
  getNoteTags: vi.fn(() => []),
  setNoteTags: vi.fn(),
  updateNoteCache: vi.fn(),
  setNoteProperties: vi.fn(),
  getNoteProperties: vi.fn(() => [])
}))

vi.mock('@memry/sync-client/item-handlers/note-pin-helpers', () => ({
  applyPinnedTags: vi.fn(),
  getPinnedTagsForNote: vi.fn(() => [])
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

vi.mock('../../projections', () => ({ flushProjectionEvents: vi.fn() }))

import { noteHandler } from './note-handler'
import { parseNote } from '../../vault/frontmatter'
import { mergeUnknownPayloadFields, recordUnknownPayloadFields } from '../unknown-fields'

const REMOTE_CLOCK = { 'device-A': 1, 'device-B': 1 }

function seedNote(id: string, fileContent: string): void {
  dataDb.db
    .insert(noteMetadata)
    .values({
      id,
      path: `${id}.md`,
      title: id,
      fileType: 'markdown',
      clock: { 'device-A': 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    })
    .run()
  fs.mkdirSync(VAULT_ROOT, { recursive: true })
  fs.writeFileSync(path.join(VAULT_ROOT, `${id}.md`), fileContent, 'utf-8')
}

function frontmatterOf(id: string): Record<string, unknown> {
  return parseNote(fs.readFileSync(path.join(VAULT_ROOT, `${id}.md`), 'utf-8')).frontmatter
}

function pushPayload(id: string): Record<string, unknown> {
  const raw = noteHandler.buildPushPayload(ctx.db, id, 'device-A', 'update')
  expect(raw).not.toBeNull()
  return JSON.parse(raw as string) as Record<string, unknown>
}

let ctx: ApplyContext

describe('note cover sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    dataDb = createTestDataDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  afterEach(() => {
    dataDb.close()
  })

  afterAll(() => {
    fs.rmSync(VAULT_ROOT, { recursive: true, force: true })
  })

  it('pushes the frontmatter cover in its own payload field', () => {
    seedNote(
      'n1',
      '---\ncover: ../attachments/n1/harbour.jpg\ncoverFocus: 42\ncoverCredit: Ana Ferreira\ncoverCreditUrl: https://unsplash.com/photos/x\n---\nbody\n'
    )

    expect(pushPayload('n1').cover).toEqual({
      ref: '../attachments/n1/harbour.jpg',
      focus: 42,
      credit: 'Ana Ferreira',
      creditUrl: 'https://unsplash.com/photos/x'
    })
  })

  it('omits the cover key for a note that has had no cover here, and for a text-valued cover property', () => {
    seedNote('n1', '---\ntitle: n1\n---\nbody\n')
    seedNote('n2', '---\ncover: Hardback\n---\nbody\n')

    expect(pushPayload('n1')).not.toHaveProperty('cover')
    expect(pushPayload('n2')).not.toHaveProperty('cover')
    expect(pushPayload('n1')).not.toHaveProperty('coverImage')
  })

  it('pushes null (and clears the legacy coverImage) after a local removal, until the push is confirmed', () => {
    seedNote('n1', '---\ncover: wash:sage\n---\nbody\n')
    expect(pushPayload('n1').cover).toEqual({ ref: 'wash:sage' })
    noteHandler.markPushSynced(ctx.db, 'n1')

    fs.writeFileSync(path.join(VAULT_ROOT, 'n1.md'), '---\ntitle: n1\n---\nbody\n', 'utf-8')
    const removal = pushPayload('n1')
    expect(removal.cover).toBeNull()
    expect(removal.coverImage).toBeNull()
    // A retry rebuilds the payload; the removal must still be in it.
    expect(pushPayload('n1').cover).toBeNull()

    noteHandler.markPushSynced(ctx.db, 'n1')
    expect(pushPayload('n1')).not.toHaveProperty('cover')
  })

  it('keeps a removal made while a cover push was in flight', () => {
    seedNote('n1', '---\ncover: wash:sage\n---\nbody\n')
    expect(pushPayload('n1').cover).toEqual({ ref: 'wash:sage' })

    fs.writeFileSync(path.join(VAULT_ROOT, 'n1.md'), '---\ntitle: n1\n---\nbody\n', 'utf-8')
    // The ack of the payload that still carried the cover.
    noteHandler.markPushSynced(ctx.db, 'n1')

    expect(pushPayload('n1').cover).toBeNull()
  })

  it('pushes a removal of a cover that arrived from another device, but not after a remote removal', () => {
    seedNote('n1', '---\ntitle: n1\n---\nbody\n')
    seedNote('n2', '---\ncover: wash:moss\n---\nbody\n')
    noteHandler.applyUpsert(
      ctx,
      'n1',
      { cover: { ref: 'wash:plum' }, clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )
    expect(frontmatterOf('n1').cover).toBe('wash:plum')

    fs.writeFileSync(path.join(VAULT_ROOT, 'n1.md'), '---\ntitle: n1\n---\nbody\n', 'utf-8')
    expect(pushPayload('n1').cover).toBeNull()

    expect(pushPayload('n2').cover).toEqual({ ref: 'wash:moss' })
    noteHandler.applyUpsert(ctx, 'n2', { cover: null, clock: REMOTE_CLOCK }, REMOTE_CLOCK)
    expect(pushPayload('n2')).not.toHaveProperty('cover')
  })

  it('lets a kept cover and coverImage from an older capture ride along when the key is omitted', () => {
    seedNote('n1', '---\ntitle: n1\n---\nbody\n')
    const kept = {
      cover: { ref: 'attachments/n1/ios.heic' },
      coverImage: { url: 'attachments/n1/ios.heic', offsetY: 0.4 }
    }
    recordUnknownPayloadFields(ctx.db, 'note', 'n1', kept, {})

    const raw = noteHandler.buildPushPayload(ctx.db, 'n1', 'device-A', 'update') as string
    const merged = JSON.parse(mergeUnknownPayloadFields(ctx.db, 'note', 'n1', raw)) as Record<
      string,
      unknown
    >

    expect(merged.cover).toEqual(kept.cover)
    expect(merged.coverImage).toEqual(kept.coverImage)
  })

  it('does not replace a text-valued cover property with a remote cover', () => {
    seedNote('n1', '---\ncover: Hardback\n---\nbody\n')

    noteHandler.applyUpsert(
      ctx,
      'n1',
      { cover: { ref: 'wash:sage', credit: 'Ana' }, clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    expect(frontmatterOf('n1').cover).toBe('Hardback')
    expect(frontmatterOf('n1').coverCredit).toBeUndefined()
    expect(pushPayload('n1')).not.toHaveProperty('cover')
  })

  it('round-trips a cover from one note payload onto another note file', () => {
    seedNote('n1', '---\ncover: wash:sage\n---\nbody\n')
    seedNote('n2', '---\ntitle: n2\n---\nbody\n')

    const data = NoteSyncPayloadSchema.parse(pushPayload('n1'))
    const result = noteHandler.applyUpsert(ctx, 'n2', { ...data, title: 'n2' }, REMOTE_CLOCK)

    expect(result).toBe('applied')
    expect(frontmatterOf('n2').cover).toBe('wash:sage')
  })

  it('writes a remote image cover with its focus and replaces the old credit', () => {
    seedNote(
      'n1',
      '---\ncover: wash:sand\ncoverCredit: Old Photographer\ncoverCreditUrl: https://unsplash.com/photos/old\n---\nbody\n'
    )

    noteHandler.applyUpsert(
      ctx,
      'n1',
      { cover: { ref: 'attachments/n1/photo.jpg', focus: 30 }, clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    const frontmatter = frontmatterOf('n1')
    expect(frontmatter.cover).toBe('attachments/n1/photo.jpg')
    expect(frontmatter.coverFocus).toBe(30)
    expect(frontmatter.coverCredit).toBeUndefined()
    expect(frontmatter.coverCreditUrl).toBeUndefined()
  })

  it('keeps the local cover when the payload has no cover key (an older sender)', () => {
    seedNote('n1', '---\ncover: wash:moss\ncoverFocus: 10\n---\nbody\n')

    noteHandler.applyUpsert(ctx, 'n1', { properties: {}, clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    const frontmatter = frontmatterOf('n1')
    expect(frontmatter.cover).toBe('wash:moss')
    expect(frontmatter.coverFocus).toBe(10)
  })

  it('removes the cover on an explicit null but keeps a text-valued cover property', () => {
    seedNote('n1', '---\ncover: attachments/n1/a.png\ncoverFocus: 70\n---\nbody\n')
    seedNote('n2', '---\ncover: Hardback\n---\nbody\n')

    noteHandler.applyUpsert(ctx, 'n1', { cover: null, clock: REMOTE_CLOCK }, REMOTE_CLOCK)
    noteHandler.applyUpsert(ctx, 'n2', { cover: null, clock: REMOTE_CLOCK }, REMOTE_CLOCK)

    expect(frontmatterOf('n1').cover).toBeUndefined()
    expect(frontmatterOf('n1').coverFocus).toBeUndefined()
    expect(frontmatterOf('n2').cover).toBe('Hardback')
  })

  it('writes the cover into a note created from a remote payload', () => {
    noteHandler.applyUpsert(
      ctx,
      'n3',
      {
        title: 'Fresh',
        content: 'body',
        cover: { ref: 'wash:plum' },
        clock: REMOTE_CLOCK
      },
      REMOTE_CLOCK
    )

    const file = fs.readdirSync(VAULT_ROOT).find((name) => name.startsWith('Fresh'))
    expect(file).toBeDefined()
    const frontmatter = parseNote(
      fs.readFileSync(path.join(VAULT_ROOT, file as string), 'utf-8')
    ).frontmatter
    expect(frontmatter.cover).toBe('wash:plum')
  })

  it('reads an unreadable cover value as absent rather than failing the note', () => {
    const parsed = NoteSyncPayloadSchema.parse({ title: 'x', cover: { ref: 7 } })
    expect(parsed.cover).toBeUndefined()
    expect(parsed.title).toBe('x')
  })
})
