import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  rows: new Map<string, Record<string, unknown>>(),
  indexDb: null as unknown,
  contentHash: (_raw: string): string => ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] }
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn(), trackMainLog: vi.fn() }))
vi.mock('../database/client', () => ({
  getIndexDatabase: () => h.indexDb,
  getDatabase: () => ({})
}))
vi.mock('../database', () => ({ getIndexDatabase: () => h.indexDb, getDatabase: () => ({}) }))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => ({ getDoc: () => undefined, purge: async () => {} })
}))
vi.mock('./crdt-external-feed', () => ({ feedExternalEditToCrdt: async () => false }))
vi.mock('./crdt-feed', () => ({ replaceNoteTagsInCrdt: vi.fn() }))
vi.mock('@main/database/queries/notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/database/queries/notes')>()),
  getNoteCacheById: (_db: unknown, noteId: string) => h.rows.get(noteId)
}))
vi.mock('@memry/storage-data', () => ({ getNoteMetadataById: () => undefined }))
vi.mock('../vault/notes-io', () => ({
  emitNoteEvent: vi.fn(),
  toAbsolutePath: (relative: string) => `/vault/${relative}`
}))
vi.mock('../vault/notes', async () => {
  const versions = await import('../vault/notes-versions')
  return {
    getVaultRoot: () => '/vault',
    toAbsolutePath: (relative: string) => `/vault/${relative}`,
    createSnapshot: versions.createSnapshot,
    maybeCreateSignificantSnapshot: versions.maybeCreateSignificantSnapshot
  }
})
vi.mock('../vault/file-ops', () => ({
  safeRead: async (absolute: string) => h.files.get(absolute) ?? null,
  atomicWrite: async (absolute: string, content: string) => {
    h.files.set(absolute, content)
  },
  ensureDirectory: vi.fn(),
  deleteFile: vi.fn()
}))
vi.mock('../vault/journal', () => ({
  getJournalPath: (date: string) => `/vault/journal/${date}.md`
}))
vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: (_db: unknown, input: { id: string; fileContent: string }) => {
    const row = h.rows.get(input.id)
    if (row) h.rows.set(input.id, { ...row, contentHash: h.contentHash(input.fileContent) })
  },
  deleteNoteFromCache: vi.fn()
}))
vi.mock('../vault/attachment-rename-reconcile', () => ({ reconcileRenamedAttachments: vi.fn() }))
vi.mock('../projections', () => ({ flushProjectionEvents: vi.fn() }))
vi.mock('../notes/note-date-reminders', () => ({
  syncNoteDateReminders: vi.fn(),
  clearNoteDateReminders: vi.fn()
}))
vi.mock('@memry/app-core/reminders', () => ({ createRemindersService: vi.fn() }))
vi.mock('./local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn()
}))

import {
  cancelPendingWritebacks,
  resetWritebackState,
  scheduleWriteback,
  writebackNow
} from './crdt-writeback'
import { markdownToYFragment } from './blocknote-converter'
import { generateContentHash } from '../vault/frontmatter'

const NOTE = 'note-1'
const NOTE_FILE = '/vault/notes/Fox.md'
const JOURNAL = 'j2026-01-03'
const JOURNAL_FILE = '/vault/journal/2026-01-03.md'

let index: TestDatabaseResult

function fileOf(noteId: string): string {
  return noteId === JOURNAL ? JOURNAL_FILE : NOTE_FILE
}

/**
 * The file as some other writer left it (`updateNote`, an earlier session):
 * on disk and read by the index, which is what lets a write-back replace it.
 */
function writtenElsewhere(noteId: string, raw: string): void {
  const relativePath = noteId === JOURNAL ? 'journal/2026-01-03.md' : 'notes/Fox.md'
  index.sqlite
    .prepare(
      `INSERT OR IGNORE INTO note_cache (id, path, title, created_at, modified_at)
       VALUES (?, ?, 'Fox', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    )
    .run(noteId, relativePath)
  h.files.set(fileOf(noteId), raw)
  h.rows.set(noteId, {
    id: noteId,
    path: relativePath,
    title: 'Fox',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    localOnly: false,
    contentHash: generateContentHash(raw)
  })
}

async function docWith(body: string, tags: string[] = []): Promise<Y.Doc> {
  const doc = new Y.Doc()
  await markdownToYFragment(body, doc.getXmlFragment(CRDT_FRAGMENT_NAME), 'notes/Fox.md')
  for (const tag of tags) doc.getArray('tags').push([tag])
  return doc
}

/** A pass armed by a peer's edit, or by this device's editor. */
async function pass(noteId: string, doc: Y.Doc, source: 'remote' | 'local'): Promise<void> {
  if (source === 'local') scheduleWriteback(noteId, doc, 'local')
  await writebackNow(noteId, doc)
}

function versionsKept(noteId: string): string[] {
  return (
    index.sqlite
      .prepare('SELECT content FROM note_snapshots WHERE note_id = ? ORDER BY rowid')
      .all(noteId) as Array<{ content: string }>
  ).map((row) => row.content)
}

describe('the version a write-back keeps of the bytes it replaces (#2646)', () => {
  beforeEach(() => {
    index = createTestIndexDb()
    h.indexDb = index.db
    h.contentHash = generateContentHash
    h.files.clear()
    h.rows.clear()
    resetWritebackState()
  })

  afterEach(() => {
    cancelPendingWritebacks()
    resetWritebackState()
    index.close()
  })

  it('keeps one version while a peer types into the note for 60 passes', async () => {
    const first = '---\nid: note-1\n---\nThe fox\n'
    writtenElsewhere(NOTE, first)

    for (let i = 1; i <= 60; i++) {
      await pass(NOTE, await docWith(`The fox ${'x'.repeat(i)}`), 'remote')
    }

    expect(h.files.get(NOTE_FILE)).toBe(`---\nid: note-1\n---\nThe fox ${'x'.repeat(60)}\n`)
    expect(versionsKept(NOTE)).toEqual([first])
  })

  const NOTE_AFTER = '---\nid: x\ntags:\n  - a\n---\nThe slow red fox jumps over the lazy cat\n'
  const JOURNAL_AFTER =
    "---\nid: x\ndate: '2026-01-03'\ntags:\n  - a\n---\nThe slow red fox jumps over the lazy cat\n"

  it.each([
    ['note, remote pass', NOTE, 'remote', NOTE_AFTER],
    ['note, local pass', NOTE, 'local', NOTE_AFTER],
    ['journal, remote pass', JOURNAL, 'remote', JOURNAL_AFTER],
    ['journal, local pass', JOURNAL, 'local', JOURNAL_AFTER]
  ] as const)(
    'keeps the bytes updateNote wrote when a pass changes three words of them (%s)',
    async (_label, noteId, source, after) => {
      writtenElsewhere(noteId, '---\nid: x\n---\nThe quick brown fox\n')
      await pass(noteId, await docWith('The quick brown fox', ['a']), source)
      const agentEdit = '---\nid: x\n---\nThe quick brown fox jumps over the lazy dog\n'
      writtenElsewhere(noteId, agentEdit)

      await pass(noteId, await docWith('The slow red fox jumps over the lazy cat', ['a']), source)

      expect(h.files.get(fileOf(noteId))).toBe(after)
      expect(versionsKept(noteId)).toEqual([agentEdit])
    }
  )

  it.each(['remote', 'local'] as const)(
    'keeps no version when a %s pass changes three words of bytes it wrote itself',
    async (source) => {
      writtenElsewhere(NOTE, '---\nid: note-1\n---\nThe quick brown fox jumps over the lazy dog\n')
      await pass(NOTE, await docWith('The quick brown fox jumps over the lazy dog', ['a']), source)
      const ownWrite = h.files.get(NOTE_FILE)

      await pass(NOTE, await docWith('The slow red fox jumps over the lazy cat', ['a']), source)

      expect(ownWrite).toBe(
        '---\nid: note-1\ntags:\n  - a\n---\nThe quick brown fox jumps over the lazy dog\n'
      )
      expect(h.files.get(NOTE_FILE)).toBe(
        '---\nid: note-1\ntags:\n  - a\n---\nThe slow red fox jumps over the lazy cat\n'
      )
      expect(versionsKept(NOTE)).toEqual([])
    }
  )

  it.each([
    [
      'LF',
      '---\ntags:\n  - old\n---\nThe quick brown fox\n\nSecond line\n',
      '---\ntags:\n  - new\n---\nThe quick brown fox\n\nSecond line\n'
    ],
    [
      'CRLF',
      '---\r\ntags:\r\n  - old\r\n---\r\nThe quick brown fox\r\n\r\nSecond line\r\n',
      '---\r\ntags:\r\n  - new\r\n---\r\nThe quick brown fox\r\n\r\nSecond line\r\n'
    ]
  ])(
    'keeps no version when a remote pass changes only the tags of a %s file',
    async (_eol, raw, after) => {
      writtenElsewhere(NOTE, raw)

      await pass(NOTE, await docWith('The quick brown fox\n\nSecond line', ['new']), 'remote')

      expect(h.files.get(NOTE_FILE)).toBe(after)
      expect(versionsKept(NOTE)).toEqual([])
    }
  )

  it.each([
    [NOTE, '---\nid: x\n---\nThe slow red fox\n'],
    [JOURNAL, "---\nid: x\ndate: '2026-01-03'\n---\nThe slow red fox\n"]
  ])('writes the file when the version store throws (%s)', async (noteId, after) => {
    writtenElsewhere(noteId, '---\nid: x\n---\nThe quick brown fox\n')
    index.sqlite.exec('DROP TABLE note_snapshots')

    await pass(noteId, await docWith('The slow red fox'), 'remote')

    expect(h.files.get(fileOf(noteId))).toBe(after)
  })
})
