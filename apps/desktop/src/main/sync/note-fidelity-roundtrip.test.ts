/**
 * A note must reach every other device whole: its title, its body, and the
 * images and PDFs it embeds. Each field below has its own way of going missing,
 * so this suite walks a real note through the real sender pipeline — real
 * SQLite, real frontmatter parsing, real files on disk — and asserts the wire
 * payload still carries everything after an ordinary local edit.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { NoteSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import { saveCanonicalNote } from '@memry/domain-notes'
import { getNoteMetadataById, upsertNoteMetadata } from '@memry/storage-data'

const mocks = vi.hoisted(() => ({
  dataDb: null as unknown,
  vaultRoot: '',
  properties: [] as Array<{ name: string; value: unknown }>,
  pinnedTags: [] as string[]
}))

vi.mock('../database/client', () => ({
  getDatabase: () => mocks.dataDb,
  getIndexDatabase: () => ({ kind: 'index-db' })
}))

vi.mock('../vault/notes', () => ({
  toAbsolutePath: (relative: string) => path.join(mocks.vaultRoot, relative)
}))

vi.mock('../vault/index', () => ({
  getConfig: () => ({ defaultNoteFolder: 'notes' })
}))

vi.mock('@main/database/queries/notes', () => ({
  getNoteProperties: () => mocks.properties
}))

vi.mock('./item-handlers/note-pin-helpers', () => ({
  getPinnedTagsForNote: () => mocks.pinnedTags
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { buildNotePushPayload } from './item-handlers/note-handler-sync-helpers'

const NOTE_ID = 'note-fidelity-1'
const REL_PATH = 'notes/research/Deep Work.md'

const NOTE_BODY = [
  'Reading notes.',
  '',
  '![Cover](../../attachments/note-fidelity-1/cover.png)',
  '',
  '[Paper](../../attachments/note-fidelity-1/paper.pdf)'
].join('\n')

const NOTE_FILE = [
  '---',
  'tags:',
  '  - reading',
  '  - focus',
  'properties:',
  '  status: reading',
  '  rating: 5',
  '---',
  NOTE_BODY
].join('\n')

describe('note fidelity across devices', () => {
  let testDb: TestDatabaseResult
  let vaultRoot: string

  beforeEach(() => {
    testDb = createTestDataDb()
    mocks.dataDb = testDb.db
    vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-fidelity-'))
    mocks.vaultRoot = vaultRoot
    mocks.properties = [
      { name: 'status', value: 'reading' },
      { name: 'rating', value: 5 }
    ]
    mocks.pinnedTags = ['focus']

    fs.mkdirSync(path.dirname(path.join(vaultRoot, REL_PATH)), { recursive: true })
    fs.writeFileSync(path.join(vaultRoot, REL_PATH), NOTE_FILE, 'utf-8')

    upsertNoteMetadata(testDb.db as never, {
      id: NOTE_ID,
      path: REL_PATH,
      title: 'Deep Work',
      emoji: '📚',
      fileType: 'markdown',
      attachmentReferences: ['att-cover-png', 'att-paper-pdf'],
      clock: { 'device-A': 3 },
      syncedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-02T00:00:00.000Z'
    })
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(vaultRoot, { recursive: true, force: true })
  })

  const buildPayload = (operation: 'create' | 'update') => {
    const raw = buildNotePushPayload(NOTE_ID, operation)
    expect(raw).not.toBeNull()
    // Parsing through the contract proves nothing is stripped at the boundary
    return NoteSyncPayloadSchema.parse(JSON.parse(raw!))
  }

  it('puts every field a receiving device needs on the wire', () => {
    const payload = buildPayload('create')

    expect(payload.title).toBe('Deep Work')
    expect(payload.content).toBe(NOTE_BODY)
    expect(payload.folderPath).toBe('notes/research')
    expect(payload.emoji).toBe('📚')
    expect(payload.fileType).toBe('markdown')
    expect(payload.tags).toEqual(['reading', 'focus'])
    expect(payload.properties).toEqual({ status: 'reading', rating: 5 })
    expect(payload.pinnedTags).toEqual(['focus'])
    expect(payload.clock).toEqual({ 'device-A': 3 })
    // The embedded image and PDF only materialize on the other device if their
    // blob ids ride along — the markdown links alone point at files that exist
    // nowhere but the authoring machine.
    expect(payload.attachmentReferences).toEqual(['att-cover-png', 'att-paper-pdf'])
  })

  it('keeps the embedded image and PDF on the wire after an ordinary local edit', () => {
    // A rename, a move, a content save and a re-index all funnel through
    // saveCanonicalNote with file state only — no sync bookkeeping.
    saveCanonicalNote(testDb.db as never, {
      id: NOTE_ID,
      path: REL_PATH,
      title: 'Deep Work — revised',
      emoji: '📚',
      localOnly: false,
      journalDate: null,
      properties: { status: 'reading', rating: 5 },
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-03T00:00:00.000Z'
    })

    const stored = getNoteMetadataById(testDb.db as never, NOTE_ID)
    expect(stored?.title).toBe('Deep Work — revised')
    expect(stored?.attachmentReferences).toEqual(['att-cover-png', 'att-paper-pdf'])
    expect(stored?.clock).toEqual({ 'device-A': 3 })
    expect(stored?.syncedAt).toBe('2026-01-01T00:00:00.000Z')

    const payload = buildPayload('update')
    expect(payload.title).toBe('Deep Work — revised')
    expect(payload.attachmentReferences).toEqual(['att-cover-png', 'att-paper-pdf'])
    // Body updates ride the CRDT channel, so an update payload carries no content
    expect(payload.content).toBeNull()
  })

  it('never pushes a note the user marked local-only', () => {
    saveCanonicalNote(testDb.db as never, {
      id: NOTE_ID,
      path: REL_PATH,
      title: 'Deep Work',
      localOnly: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-03T00:00:00.000Z'
    })

    expect(buildNotePushPayload(NOTE_ID, 'update')).toBeNull()
  })
})
