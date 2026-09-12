/**
 * Tests for remove-task-line-from-note.ts.
 *
 * Deleting a task used to leave its `- [ ] … {task:id}` line in the source
 * note, so the note kept showing a checkbox for a task that no longer exists.
 * Two things are pinned here: the line removal is surgical (every other byte of
 * the file survives, including content nested under the line), and the write
 * lands in the same order as every other main-originated note edit —
 * `markWritebackIgnored` before `atomicWrite`, `feedExternalEditToCrdt` after,
 * with the post-edit body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[] = []
const feedCalls: Array<{ noteId: string; content: string }> = []
const files = new Map<string, string>()
const emitted: Array<{ channel: string; event: unknown }> = []
const noteRows = new Map<string, Record<string, unknown>>()

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn((_db: unknown, id: string) => noteRows.get(id))
}))
vi.mock('../database', () => ({ getIndexDatabase: vi.fn(() => ({})) }))
vi.mock('../sync/crdt-external-feed', () => ({
  feedExternalEditToCrdt: vi.fn(async (noteId: string, content: string) => {
    calls.push('feedExternalEditToCrdt')
    feedCalls.push({ noteId, content })
  })
}))
const openDocs = new Set<string>()

vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: vi.fn(() => ({
    getDoc: (noteId: string) => (openDocs.has(noteId) ? {} : undefined)
  }))
}))
vi.mock('../sync/crdt-writeback', () => ({
  markWritebackIgnored: vi.fn(() => calls.push('markWritebackIgnored'))
}))
vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: vi.fn(() => {
    calls.push('syncNoteToCache')
    return { wordCount: 3, characterCount: 12, tags: [] }
  })
}))
vi.mock('../vault/file-ops', () => ({
  safeRead: vi.fn(async (p: string) => files.get(p) ?? null),
  atomicWrite: vi.fn(async (p: string, content: string) => {
    calls.push('atomicWrite')
    files.set(p, content)
  })
}))
vi.mock('../vault/notes-io', () => ({
  emitNoteEvent: vi.fn((channel: string, event: unknown) => {
    calls.push('emitNoteEvent')
    emitted.push({ channel, event })
  }),
  toAbsolutePath: vi.fn((p: string) => `/vault/${p}`)
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

import {
  removeTaskLineFromMarkdown,
  removeTaskLineFromSourceNote
} from './remove-task-line-from-note'

function seedNote(id: string, notePath: string, file: string): void {
  noteRows.set(id, {
    id,
    path: notePath,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    localOnly: false,
    emoji: null
  })
  files.set(`/vault/${notePath}`, file)
}

beforeEach(() => {
  calls.length = 0
  feedCalls.length = 0
  emitted.length = 0
  files.clear()
  noteRows.clear()
  openDocs.clear()
})

describe('removeTaskLineFromMarkdown', () => {
  it('removes only the checkbox line carrying the id', () => {
    const markdown = '# Notes\n\n- [ ] Keep me {task:t1}\n- [x] Drop me {task:t2}\n\nTail text\n'
    expect(removeTaskLineFromMarkdown(markdown, 't2')).toBe(
      '# Notes\n\n- [ ] Keep me {task:t1}\n\nTail text\n'
    )
  })

  it('leaves content nested under the removed line in place', () => {
    const markdown = '- [ ] Parent {task:t1}\n  - buy milk\n  - [ ] Child {task:t2}\n\nAfter\n'
    expect(removeTaskLineFromMarkdown(markdown, 't1')).toBe(
      '  - buy milk\n  - [ ] Child {task:t2}\n\nAfter\n'
    )
  })

  it('returns null when the note no longer carries the id', () => {
    const markdown = '- [ ] Other {task:t1}\n'
    expect(removeTaskLineFromMarkdown(markdown, 't2')).toBeNull()
  })

  it('returns null for a plain mention that is not a checkbox line', () => {
    const markdown = 'See {task:t2} for context\n'
    expect(removeTaskLineFromMarkdown(markdown, 't2')).toBeNull()
  })

  it('keeps CRLF line endings on the surviving lines', () => {
    const markdown = 'Intro\r\n- [ ] Drop me {task:t2}\r\nOutro\r\n'
    expect(removeTaskLineFromMarkdown(markdown, 't2')).toBe('Intro\r\nOutro\r\n')
  })

  it('removes a final line that has no trailing newline', () => {
    expect(removeTaskLineFromMarkdown('Intro\n- [ ] Drop me {task:t2}', 't2')).toBe('Intro\n')
  })

  it('removes every duplicate of the line so a second pass is a no-op', () => {
    const markdown = '- [ ] Dupe {task:t2}\nMiddle\n* [X] Dupe {task:t2}\n'
    const once = removeTaskLineFromMarkdown(markdown, 't2')
    expect(once).toBe('Middle\n')
    expect(removeTaskLineFromMarkdown(once as string, 't2')).toBeNull()
  })
})

describe('removeTaskLineFromSourceNote', () => {
  it('rewrites the file without the line and keeps every other byte', async () => {
    const file =
      '---\ntitle: Planning\ntags:\n  - work # keep this comment\n---\n\n# Plan\n\n- [ ] Keep {task:t1}\n- [ ] Drop {task:t2}\n\nTrailing paragraph.\n'
    seedNote('note-1', 'Plan.md', file)

    await removeTaskLineFromSourceNote('t2', 'note-1')

    expect(files.get('/vault/Plan.md')).toBe(
      '---\ntitle: Planning\ntags:\n  - work # keep this comment\n---\n\n# Plan\n\n- [ ] Keep {task:t1}\n\nTrailing paragraph.\n'
    )
  })

  it('marks the write ignored before writing and feeds the CRDT after', async () => {
    seedNote('note-1', 'Plan.md', '# Plan\n\n- [ ] Drop {task:t2}\n')

    await removeTaskLineFromSourceNote('t2', 'note-1')

    expect(calls).toEqual([
      'markWritebackIgnored',
      'atomicWrite',
      'syncNoteToCache',
      'emitNoteEvent',
      'feedExternalEditToCrdt'
    ])
    expect(feedCalls).toEqual([{ noteId: 'note-1', content: '# Plan\n' }])
  })

  it('is idempotent: a second delete of the same task writes nothing', async () => {
    seedNote('note-1', 'Plan.md', '# Plan\n\n- [ ] Drop {task:t2}\n')
    await removeTaskLineFromSourceNote('t2', 'note-1')
    calls.length = 0

    await removeTaskLineFromSourceNote('t2', 'note-1')

    expect(calls).toEqual([])
  })

  it('leaves the file alone while the note is open in an editor', async () => {
    seedNote('note-1', 'Plan.md', '# Plan\n\n- [ ] Drop {task:t2}\n')
    openDocs.add('note-1')

    await removeTaskLineFromSourceNote('t2', 'note-1')

    expect(calls).toEqual([])
    expect(files.get('/vault/Plan.md')).toBe('# Plan\n\n- [ ] Drop {task:t2}\n')
  })

  it('does nothing when the note row is gone', async () => {
    await removeTaskLineFromSourceNote('t2', 'missing-note')
    expect(calls).toEqual([])
  })

  it('does nothing when the file is unreadable, for example after a rename', async () => {
    noteRows.set('note-1', {
      id: 'note-1',
      path: 'Moved.md',
      title: 'note-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      localOnly: false,
      emoji: null
    })

    await removeTaskLineFromSourceNote('t2', 'note-1')

    expect(calls).toEqual([])
  })

  it('never throws when the write fails', async () => {
    seedNote('note-1', 'Plan.md', '- [ ] Drop {task:t2}\n')
    const fileOps = await import('../vault/file-ops')
    vi.mocked(fileOps.atomicWrite).mockRejectedValueOnce(new Error('EACCES'))

    await expect(removeTaskLineFromSourceNote('t2', 'note-1')).resolves.toBeUndefined()
  })
})
