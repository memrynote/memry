import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDataDb,
  createTestIndexDb,
  asClientDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { crdtOwedFileBodies } from '@memry/db-schema/schema/crdt-owed-file-bodies'
import { noteBodySync } from '@memry/db-schema/schema/note-body-sync'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import type { IndexDb } from '../database/client'
import {
  getNoteSyncState,
  listUnsentNotes,
  recordNoteBodyPush,
  type NoteSyncStateDbs
} from './note-sync-state'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const T0 = Date.parse('2026-10-07T10:00:00.000Z')

describe('note sync state (#2647)', () => {
  let data: TestDatabaseResult
  let index: TestDatabaseResult
  let dbs: NoteSyncStateDbs

  const addNote = (id: string, extra: { localOnly?: boolean; syncedAt?: string } = {}) => {
    index.db
      .insert(noteCache)
      .values({
        id,
        path: `notes/${id}.md`,
        title: `Title ${id}`,
        createdAt: '2026-10-01T00:00:00.000Z',
        modifiedAt: '2026-10-01T00:00:00.000Z',
        localOnly: extra.localOnly ?? false,
        syncedAt: extra.syncedAt ?? null
      })
      .run()
  }
  const queueRow = (itemId: string, type: string, atMs: number) => {
    data.db
      .insert(syncQueue)
      .values({
        id: `${itemId}-${type}-${atMs}`,
        type,
        itemId,
        operation: 'update',
        payload: 'AAE=',
        createdAt: new Date(atMs)
      })
      .run()
  }
  const record = (noteId: string, event: 'sent' | 'confirmed' | 'failed' | 'rejected', at: number) =>
    recordNoteBodyPush(noteId, event, at, dbs.data)
  const state = (noteId: string, syncEligible = true) =>
    getNoteSyncState(noteId, { dbs, syncEligible })

  beforeEach(() => {
    data = createTestDataDb()
    index = createTestIndexDb()
    dbs = { data: asClientDb(data.db), index: index.db as unknown as IndexDb }
  })

  afterEach(() => {
    data.close()
    index.close()
  })

  it('reports changes waiting on this device from a queued body row', () => {
    addNote('n1')
    queueRow('n1', 'note_body', T0)

    expect(state('n1')).toMatchObject({ state: 'pending', waitingSince: T0, bodyConfirmedAt: null })
  })

  it('reports sent while a body push has no answer yet', () => {
    addNote('n1')
    queueRow('n1', 'note_body', T0)
    record('n1', 'sent', T0 + 1000)

    expect(state('n1')).toMatchObject({ state: 'sent', lastSentAt: T0 + 1000 })
  })

  it('reports confirmed with the time the server stored the body', () => {
    addNote('n1')
    record('n1', 'sent', T0)
    record('n1', 'confirmed', T0 + 500)

    expect(state('n1')).toEqual({
      state: 'confirmed',
      waitingSince: null,
      lastSentAt: T0,
      bodyConfirmedAt: T0 + 500,
      lastFailedAt: null,
      lastRejectedAt: null
    })
  })

  it('goes back to pending after a retryable failure, keeping the last confirmed time', () => {
    addNote('n1')
    record('n1', 'confirmed', T0)
    queueRow('n1', 'note_body', T0 + 2000)
    record('n1', 'sent', T0 + 3000)
    record('n1', 'failed', T0 + 4000)

    expect(state('n1')).toMatchObject({
      state: 'pending',
      waitingSince: T0 + 2000,
      bodyConfirmedAt: T0,
      lastFailedAt: T0 + 4000
    })
  })

  // The Ask: until AF-019 the state must not report a replayed push as confirmed.
  it('never treats a record sync stamp as a confirmed body', () => {
    addNote('n1', { syncedAt: new Date(T0 + 60_000).toISOString() })
    queueRow('n1', 'note_body', T0)

    expect(state('n1')).toMatchObject({ state: 'pending', bodyConfirmedAt: null })
  })

  it('reports not_recorded, not confirmed, for a note this version never pushed', () => {
    addNote('n1', { syncedAt: new Date(T0).toISOString() })

    expect(state('n1')).toMatchObject({ state: 'not_recorded', bodyConfirmedAt: null })
  })

  it('reports rejected when the server refused the latest body push', () => {
    addNote('n1')
    record('n1', 'confirmed', T0)
    record('n1', 'sent', T0 + 1000)
    record('n1', 'rejected', T0 + 2000)

    expect(state('n1')).toMatchObject({ state: 'rejected', lastRejectedAt: T0 + 2000 })
  })

  it('counts a queued record change and a file the doc has not taken as waiting', () => {
    addNote('n1')
    addNote('n2')
    queueRow('n1', 'note', T0 + 5000)
    data.db.insert(crdtOwedFileBodies).values({ noteId: 'n2', createdAt: T0 + 7000 }).run()

    expect(state('n1')).toMatchObject({ state: 'pending', waitingSince: T0 + 5000 })
    expect(state('n2')).toMatchObject({ state: 'pending', waitingSince: T0 + 7000 })
  })

  it('says local_only and not_syncing before anything else', () => {
    addNote('n1', { localOnly: true })
    addNote('n2')
    queueRow('n2', 'note_body', T0)

    expect(state('n1').state).toBe('local_only')
    expect(state('n2', false).state).toBe('not_syncing')
  })

  it('returns null for an id with no note', () => {
    expect(state('missing')).toBeNull()
  })

  it('lists every note with unsent changes, refused pushes first, then oldest first', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) addNote(id)
    addNote('local', { localOnly: true })
    queueRow('a', 'note_body', T0 + 3000)
    queueRow('b', 'journal', T0 + 1000)
    data.db.insert(crdtOwedFileBodies).values({ noteId: 'c', createdAt: T0 + 2000 }).run()
    record('d', 'confirmed', T0)
    record('d', 'rejected', T0 + 9000)
    record('e', 'confirmed', T0)
    record('f', 'rejected', T0)
    record('f', 'confirmed', T0 + 1)
    queueRow('local', 'note_body', T0)
    queueRow('ghost', 'note_body', T0)

    const result = listUnsentNotes({ dbs, syncEligible: true })

    expect(result.total).toBe(4)
    expect(result.notes.map((note) => [note.id, note.state, note.reasons])).toEqual([
      ['d', 'rejected', ['rejected']],
      ['b', 'pending', ['record']],
      ['c', 'pending', ['file_not_taken']],
      ['a', 'pending', ['body']]
    ])
    expect(result.notes[1]).toMatchObject({ title: 'Title b', path: 'notes/b.md' })
  })

  it('caps the list but keeps the total', () => {
    for (const id of ['a', 'b', 'c']) {
      addNote(id)
      queueRow(id, 'note_body', T0)
    }

    const result = listUnsentNotes({ dbs, syncEligible: true, limit: 2 })

    expect(result.total).toBe(3)
    expect(result.notes).toHaveLength(2)
  })

  it('writes one row per note and keeps earlier columns', () => {
    record('n1', 'sent', T0)
    record('n1', 'confirmed', T0 + 1)

    expect(data.db.select().from(noteBodySync).all()).toEqual([
      {
        noteId: 'n1',
        lastSentAt: T0,
        lastConfirmedAt: T0 + 1,
        lastFailedAt: null,
        lastRejectedAt: null,
        updatedAt: T0 + 1
      }
    ])
  })
})
