/**
 * Tests for append-blocks.ts — the target half of the block side menu's
 * "Move to".
 *
 * The behaviour worth pinning is the ORDER, not the string concatenation:
 * `notes:update` and the MCP append path both write the file and skip
 * `feedExternalEditToCrdt`, which silently loses the appended text when the
 * target note is open (the next CRDT writeback overwrites it). These assert the
 * write is marked ignored BEFORE it lands and the CRDT feed runs AFTER, with
 * the post-append body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: string[] = []
const feedCalls: Array<{ noteId: string; content: string }> = []
const written: Array<{ path: string; content: string }> = []
const emitted: Array<{ channel: string; event: any }> = []

const noteRows: Record<string, any> = {}

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn((_db: unknown, id: string) => noteRows[id])
}))
vi.mock('../database', () => ({ getIndexDatabase: vi.fn(() => ({})) }))
vi.mock('../sync/crdt-external-feed', () => ({
  feedExternalEditToCrdt: vi.fn(async (noteId: string, content: string) => {
    calls.push('feedExternalEditToCrdt')
    feedCalls.push({ noteId, content })
  })
}))
vi.mock('../sync/crdt-writeback', () => ({
  markWritebackIgnored: vi.fn(() => calls.push('markWritebackIgnored'))
}))
vi.mock('./note-sync', () => ({
  syncNoteToCache: vi.fn(() => {
    calls.push('syncNoteToCache')
    return { wordCount: 3, characterCount: 12, tags: [] }
  })
}))
vi.mock('./file-ops', () => ({
  safeRead: vi.fn(async (p: string) => written.find((w) => w.path === p)?.content ?? null),
  atomicWrite: vi.fn(async (p: string, content: string) => {
    calls.push('atomicWrite')
    const existing = written.find((w) => w.path === p)
    if (existing) existing.content = content
    else written.push({ path: p, content })
  })
}))
vi.mock('./notes-io', () => ({
  emitNoteEvent: vi.fn((channel: string, event: unknown) => {
    calls.push('emitNoteEvent')
    emitted.push({ channel, event })
  }),
  toAbsolutePath: vi.fn((p: string) => `/vault/${p}`)
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { appendBlocksToNote } from './append-blocks'

function seedNote(id: string, notePath: string, body: string) {
  noteRows[id] = {
    id,
    path: notePath,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    localOnly: false,
    emoji: null
  }
  written.push({ path: `/vault/${notePath}`, content: body })
}

beforeEach(() => {
  calls.length = 0
  feedCalls.length = 0
  written.length = 0
  emitted.length = 0
  for (const key of Object.keys(noteRows)) delete noteRows[key]
})

describe('appendBlocksToNote', () => {
  it('appends to the end of the target body, separated by a blank line', async () => {
    seedNote('src', 'notes/source.md', 'Source body')
    seedNote('dst', 'notes/target.md', 'Existing target body')

    await appendBlocksToNote({ sourceNoteId: 'src', targetNoteId: 'dst', markdown: 'Moved block' })

    const target = written.find((w) => w.path === '/vault/notes/target.md')!
    expect(target.content).toContain('Existing target body\n\nMoved block')
  })

  it('marks the write ignored before it lands and feeds the CRDT after', async () => {
    seedNote('src', 'notes/source.md', 'Source body')
    seedNote('dst', 'notes/target.md', 'Target body')

    await appendBlocksToNote({ sourceNoteId: 'src', targetNoteId: 'dst', markdown: 'Moved block' })

    expect(calls).toEqual([
      'markWritebackIgnored',
      'atomicWrite',
      'syncNoteToCache',
      'emitNoteEvent',
      'feedExternalEditToCrdt'
    ])
  })

  it('feeds the CRDT the POST-append body, not the original', async () => {
    seedNote('src', 'notes/source.md', 'Source body')
    seedNote('dst', 'notes/target.md', 'Target body')

    await appendBlocksToNote({ sourceNoteId: 'src', targetNoteId: 'dst', markdown: 'Moved block' })

    expect(feedCalls).toHaveLength(1)
    expect(feedCalls[0].noteId).toBe('dst')
    expect(feedCalls[0].content).toContain('Moved block')
  })

  it('emits notes:updated as an EXTERNAL edit so an open editor reloads', async () => {
    seedNote('src', 'notes/source.md', 'Source body')
    seedNote('dst', 'notes/target.md', 'Target body')

    await appendBlocksToNote({ sourceNoteId: 'src', targetNoteId: 'dst', markdown: 'Moved block' })

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.id).toBe('dst')
    expect(emitted[0].event.source).toBe('external')
  })

  it('rewrites note-relative attachment refs when the notes are in different folders', async () => {
    seedNote('src', 'a/source.md', 'Source body')
    seedNote('dst', 'b/deep/target.md', 'Target body')

    await appendBlocksToNote({
      sourceNoteId: 'src',
      targetNoteId: 'dst',
      markdown: '![shot](../attachments/src/shot.png)'
    })

    const target = written.find((w) => w.path === '/vault/b/deep/target.md')!
    expect(target.content).toContain('attachments/src/shot.png')
    expect(target.content).not.toContain('](../attachments/src/shot.png)')
  })

  it('writes nothing when the target note is missing', async () => {
    seedNote('src', 'notes/source.md', 'Source body')

    await expect(
      appendBlocksToNote({ sourceNoteId: 'src', targetNoteId: 'gone', markdown: 'Moved block' })
    ).rejects.toThrow(/Target note not found/)
    expect(calls).toEqual([])
  })

  it('refuses to move a block into its own note', async () => {
    seedNote('src', 'notes/source.md', 'Source body')

    await expect(
      appendBlocksToNote({ sourceNoteId: 'src', targetNoteId: 'src', markdown: 'Moved block' })
    ).rejects.toThrow(/same/)
    expect(calls).toEqual([])
  })
})
