import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const restoreThrows = vi.hoisted(() => ({ next: false }))
vi.mock('@memry/shared/markdown-source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@memry/shared/markdown-source')>()
  return {
    ...actual,
    restoreMarkdownSource: (...args: Parameters<typeof actual.restoreMarkdownSource>) => {
      if (restoreThrows.next) {
        restoreThrows.next = false
        throw new Error('restore blew up')
      }
      return actual.restoreMarkdownSource(...args)
    }
  }
})

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  rows: new Map<string, Record<string, unknown>>(),
  indexDb: null as unknown,
  contentHash: (_raw: string): string => '',
  failNextRead: false
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
  safeRead: async (absolute: string) => {
    if (h.failNextRead) {
      h.failNextRead = false
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    return h.files.get(absolute) ?? null
  },
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
  cancelWriteback,
  getWritebackDebugState,
  getWritebackStateSizes,
  resetWritebackState,
  scheduleWriteback,
  settleWriteback,
  writebackNow
} from './crdt-writeback'
import { trackMainError } from '../telemetry/diagnostics'
import { resetTelemetryThrottle } from '../telemetry/throttle'
import type { Block } from '@blocknote/core'
import { blocksToYFragment, markdownToYFragment, yFragmentToBlocks } from './blocknote-converter'
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

beforeEach(() => {
  index = createTestIndexDb()
  h.indexDb = index.db
  h.contentHash = generateContentHash
  h.files.clear()
  h.rows.clear()
  h.failNextRead = false
  restoreThrows.next = false
  vi.mocked(trackMainError).mockClear()
  resetTelemetryThrottle()
  resetWritebackState()
})

afterEach(() => {
  cancelPendingWritebacks()
  resetWritebackState()
  index.close()
})

describe('the version a write-back keeps of the bytes it replaces (#2646)', () => {
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

  it('forgets the bytes it wrote for a note once the note is purged or the vault closes', async () => {
    writtenElsewhere(NOTE, '---\nid: x\n---\nThe quick brown fox\n')
    writtenElsewhere(JOURNAL, '---\nid: x\n---\nThe quick brown fox\n')
    await pass(NOTE, await docWith('The slow red fox'), 'remote')
    await pass(JOURNAL, await docWith('The slow red fox'), 'remote')
    expect(getWritebackStateSizes().lastWrittenHashes).toBe(2)

    cancelWriteback(NOTE)
    expect(getWritebackStateSizes().lastWrittenHashes).toBe(1)

    resetWritebackState()
    expect(getWritebackStateSizes().lastWrittenHashes).toBe(0)
  })
})

describe('the spelling a write-back keeps when the source record no longer restores (#2615)', () => {
  const FOREIGN = 'Title\n=====\n\nText:\n* One\n* Two\n\n_em_ here.\n'

  /** A doc that says `body` and carries the record of an older body. */
  async function docWithStaleRecord(body: string): Promise<Y.Doc> {
    const doc = await docWith(body)
    writeMarkdownSourceToYDoc(doc, 'Draft\n=====\n\n* Alpha\n* Beta\n\n__old__ words.\n')
    return doc
  }

  it.each([NOTE, JOURNAL])(
    'leaves the file as written when it already says what the doc says (%s)',
    async (noteId) => {
      const head =
        noteId === JOURNAL ? "---\nid: x\ndate: '2026-01-03'\n---\n" : '---\nid: x\n---\n'
      const raw = `${head}${FOREIGN}`
      writtenElsewhere(noteId, raw)

      await pass(noteId, await docWithStaleRecord(FOREIGN), 'remote')

      expect(h.files.get(fileOf(noteId))).toBe(raw)
      expect(versionsKept(noteId)).toEqual([])
    }
  )

  it('merges an edit into the spelling the file holds', async () => {
    writtenElsewhere(NOTE, `---\nid: x\n---\n${FOREIGN}`)

    await pass(NOTE, await docWithStaleRecord(FOREIGN.replace('_em_ here.', 'Edited.')), 'local')

    expect(h.files.get(NOTE_FILE)).toBe(
      '---\nid: x\n---\nTitle\n=====\n\nText:\n* One\n* Two\n\nEdited.\n'
    )
  })

  it.each([
    ['the file it would restore from cannot be read', () => (h.failNextRead = true)],
    ['the spelling restore throws', () => (restoreThrows.next = true)]
  ])('keeps the file and reports a failed pass when %s', async (_case, fail) => {
    const raw = `---\nid: x\n---\n${FOREIGN}`
    writtenElsewhere(NOTE, raw)
    fail()

    scheduleWriteback(
      NOTE,
      await docWithStaleRecord(FOREIGN.replace('_em_ here.', 'Edited.')),
      'local'
    )
    await settleWriteback(NOTE)

    expect(h.files.get(NOTE_FILE)).toBe(raw)
    expect(getWritebackDebugState(NOTE)?.lastError).toMatch(/kept the file/)
    expect(trackMainError).toHaveBeenCalledWith('notes', 'note_writeback', expect.any(Error))
  })

  it('does not bring back CriticMarkup the doc no longer holds', async () => {
    writtenElsewhere(NOTE, '---\nid: x\n---\nKeep {--this--} word.\n\n* One\n')

    await pass(NOTE, await docWithStaleRecord('Keep this word.\n\n* One\n'), 'remote')

    expect(h.files.get(NOTE_FILE)).toBe('---\nid: x\n---\nKeep this word.\n\n* One\n')
  })
})

describe('a CRLF note edited in the editor (#2615)', () => {
  const BROAD = [
    'Broad Title',
    '===========',
    '',
    'Intro with __bold__ and *em* text.   ',
    'Second line after a hard break.',
    '',
    '',
    '',
    '* star one',
    '* star two',
    '    * nested star',
    '',
    '+ plus one',
    '+ plus two',
    '',
    '***',
    '',
    'Middle paragraph to edit.',
    '',
    'Sub Heading',
    '-----------',
    '',
    '<div align="center">',
    '<b>html block</b>',
    '</div>',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '',
    '    indented code line 1',
    '    indented code line 2',
    '',
    'Tail paragraph with a break.  ',
    'Final line.',
    ''
  ].join('\n')

  /** The doc an editor open seeds from the file body, with one paragraph retyped. */
  async function editedDoc(body: string, from: string, to: string): Promise<Y.Doc> {
    const doc = await docWith(body)
    const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
    const blocks = (await yFragmentToBlocks(fragment)) as Block[]
    const target = blocks.find((block) => (JSON.stringify(block.content) ?? '').includes(from))
    if (!target) throw new Error(`no block holds ${from}`)
    ;(target as unknown as { content: unknown }).content = [{ type: 'text', text: to, styles: {} }]
    doc.transact(() => {
      fragment.delete(0, fragment.length)
      blocksToYFragment(blocks, fragment)
    })
    return doc
  }

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n']
  ])('changes only the edited line of a %s note', async (_eol, eol) => {
    const body = BROAD.replace(/\n/g, eol)
    const raw = `---${eol}id: x${eol}---${eol}${body}`
    writtenElsewhere(NOTE, raw)

    await pass(
      NOTE,
      await editedDoc(body, 'Middle paragraph to edit.', 'Middle paragraph, edited.'),
      'local'
    )

    expect(h.files.get(NOTE_FILE)).toBe(
      raw.replace('Middle paragraph to edit.', 'Middle paragraph, edited.')
    )
  })
})
