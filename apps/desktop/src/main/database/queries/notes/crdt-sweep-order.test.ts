import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import type { NewNoteCache } from '@memry/db-schema/schema/notes-cache'
import { getAllCrdtNoteIds, insertNoteCache } from '.'

// getAllCrdtNoteIds is the source of the CRDT catch-up sweep's work list, and
// the order it returns is the order the sweep pulls in — the paced queue drains
// FIFO, so this SELECT decides which stale note a user sees fixed first. It used
// to be unordered, i.e. rowid/index-build order, which correlates with nothing.
// #1614 makes it modifiedAt DESC. The order is a priority and must never become
// a filter: the sweep is the only channel by which a body-only remote edit
// reaches a device that missed the `crdt_updated` broadcast.

describe('getAllCrdtNoteIds — sweep priority order', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const createNote = (id: string, overrides: Partial<NewNoteCache> = {}): void => {
    insertNoteCache(db, {
      id,
      path: overrides.path ?? `notes/${id}.md`,
      title: overrides.title ?? `Note ${id}`,
      contentHash: `hash-${id}`,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: overrides.modifiedAt ?? '2026-01-12T00:00:00.000Z',
      ...(overrides.fileType !== undefined && { fileType: overrides.fileType })
    })
  }

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('returns the most recently modified note first', () => {
    // Inserted oldest-first so rowid order is the exact opposite of the answer:
    // an unordered SELECT passes only by accident, and not this way round.
    createNote('oldest', { modifiedAt: '2026-01-01T00:00:00.000Z' })
    createNote('middle', { modifiedAt: '2026-02-01T00:00:00.000Z' })
    createNote('newest', { modifiedAt: '2026-03-01T00:00:00.000Z' })

    expect(getAllCrdtNoteIds(db)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('still returns every markdown note, whatever the order', () => {
    // The invariant. Ordering may shuffle the work list; it may never shorten
    // it. A note dropped here keeps a stale body with no other path to discover
    // the remote edit, which turns a slow catch-up into a silent one.
    const ids = Array.from({ length: 40 }, (_, index) => `note-${index}`)
    for (const [index, id] of ids.entries()) {
      createNote(id, {
        modifiedAt: `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`
      })
    }

    const swept = getAllCrdtNoteIds(db)

    expect(swept).toHaveLength(ids.length)
    expect(new Set(swept)).toEqual(new Set(ids))
  })

  it('keeps notes whose mtimes are identical rather than collapsing them', () => {
    // A vault restored from backup, freshly cloned or bulk-imported has uniform
    // mtimes. Ordering degrades to arbitrary — exactly the behaviour before the
    // ORDER BY — but every note must still be swept.
    createNote('a', { modifiedAt: '2026-01-12T00:00:00.000Z' })
    createNote('b', { modifiedAt: '2026-01-12T00:00:00.000Z' })
    createNote('c', { modifiedAt: '2026-01-12T00:00:00.000Z' })

    expect(getAllCrdtNoteIds(db).sort()).toEqual(['a', 'b', 'c'])
  })

  it('leaves non-markdown files out, as before', () => {
    // Only markdown notes are CRDT-backed. The ORDER BY must not widen the
    // WHERE: a PDF in the sweep is a pull for a doc that does not exist.
    createNote('note', { modifiedAt: '2026-01-01T00:00:00.000Z' })
    createNote('scan', {
      fileType: 'pdf',
      path: 'notes/scan.pdf',
      modifiedAt: '2026-06-01T00:00:00.000Z'
    })

    expect(getAllCrdtNoteIds(db)).toEqual(['note'])
  })
})
