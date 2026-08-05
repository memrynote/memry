/**
 * A note must never arrive on another device called "Untitled".
 *
 * Reported 2026-07-26 (Mac → Linux): notes synced with their body intact but
 * the placeholder title they are born with. Fixed by 4bfbe2f0f, which shipped
 * after the last release, so these are the locks that fail if any part of it is
 * reverted. Two independent seams, both exercised here against real SQLite:
 *
 *   queue.ts        — `enqueue` coalesces a fresh mutation into the row a push
 *                     is already carrying, and nothing marks a row in flight.
 *                     `markSuccess(id)` deleting unconditionally took the
 *                     rename to the grave; its clock bump was already
 *                     persisted, so no later pull could ever repair the note.
 *                     The ack is now conditional on the payload that was
 *                     actually pushed.
 *
 *   note-handler.ts — `markPushSynced` stamps `syncedAt` on a successful push.
 *                     Without it `syncedAt` only ever recorded *incoming*
 *                     pulls, so dirty-recovery could not tell a note whose push
 *                     was lost from one that is perfectly in step, and installs
 *                     that had already diverged stayed "Untitled" forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import {
  createTestDataDb,
  asClientDb,
  asSyncDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { SyncQueueManager } from './queue'
import { recoverDirtyItems } from './dirty-recovery'
import { noteHandler } from './item-handlers/note-handler'

/** The title every note is born with, before the user types a real one. */
const BORN_TITLE = 'Untitled'
const REAL_TITLE = 'Quarterly retro'

const payloadWith = (title: string, tick: number): string =>
  JSON.stringify({ title, content: 'body', clock: { mac: tick } })

let testDb: TestDatabaseResult
let queue: SyncQueueManager

beforeEach(() => {
  testDb = createTestDataDb()
  queue = new SyncQueueManager(asClientDb(testDb.db))
})

afterEach(() => {
  testDb.close()
})

describe('note title: a rename made while the push is in flight is not lost', () => {
  it('keeps the queue row when the ack does not match what was pushed', () => {
    // #given the create was pushed carrying the placeholder title
    const inFlightPayload = payloadWith(BORN_TITLE, 1)
    const queueId = queue.enqueue({
      type: 'note',
      itemId: 'note-1',
      operation: 'create',
      payload: inFlightPayload
    })
    const [dequeued] = queue.dequeue(10)
    expect(dequeued.payload).toBe(inFlightPayload)

    // #when the user names the note before the server answers — enqueue
    // coalesces straight into the row the push is about to acknowledge
    queue.enqueue({
      type: 'note',
      itemId: 'note-1',
      operation: 'update',
      payload: payloadWith(REAL_TITLE, 2)
    })

    // #when the ack for the payload we actually sent arrives
    const removed = queue.markSuccess(queueId, dequeued.payload)

    // #then the rename survives and is what the next push carries
    expect(removed).toBe(false)
    const [next] = queue.dequeue(10)
    expect(next).toBeDefined()
    expect(JSON.parse(next.payload).title).toBe(REAL_TITLE)
  })

  it('is the real title, never the placeholder, that finally reaches the server', () => {
    const inFlightPayload = payloadWith(BORN_TITLE, 1)
    const queueId = queue.enqueue({
      type: 'note',
      itemId: 'note-1',
      operation: 'create',
      payload: inFlightPayload
    })
    queue.dequeue(10)
    queue.enqueue({
      type: 'note',
      itemId: 'note-1',
      operation: 'update',
      payload: payloadWith(REAL_TITLE, 2)
    })
    queue.markSuccess(queueId, inFlightPayload)

    // Second push round: this is the payload the receiving device renders.
    const [second] = queue.dequeue(10)
    expect(JSON.parse(second.payload).title).not.toBe(BORN_TITLE)
    queue.markSuccess(second.id, second.payload)
    expect(queue.getSize()).toBe(0)
  })

  it('still clears the row when the ack matches the pushed payload', () => {
    const payload = payloadWith(REAL_TITLE, 1)
    const queueId = queue.enqueue({
      type: 'note',
      itemId: 'note-1',
      operation: 'create',
      payload
    })

    expect(queue.markSuccess(queueId, payload)).toBe(true)
    expect(queue.getSize()).toBe(0)
  })
})

describe('note title: a push that never landed is re-pushed, not forgotten', () => {
  const recovered: string[] = []
  const noteAdapters = {
    getLocal: (type: string) =>
      type === 'note' ? { enqueueRecoveredUpdate: (id: string) => recovered.push(id) } : undefined
  } as unknown as Parameters<typeof recoverDirtyItems>[1]

  const insertNote = (values: Record<string, unknown>): void => {
    testDb.db
      .insert(noteMetadata)
      .values({
        path: 'notes/retro.md',
        title: REAL_TITLE,
        createdAt: '2026-01-01T00:00:00Z',
        ...values
      } as never)
      .run()
  }

  beforeEach(() => {
    recovered.length = 0
  })

  it('stamps syncedAt on a successful push so an in-step note is left alone', () => {
    insertNote({
      id: 'note-in-step',
      clock: { mac: 2 },
      syncedAt: null,
      modifiedAt: '2026-01-02T00:00:00Z'
    })

    // What the push coordinator calls once the server accepts the item.
    noteHandler.markPushSynced?.(asSyncDb(testDb.db), 'note-in-step')

    const row = testDb.db
      .select()
      .from(noteMetadata)
      .where(eq(noteMetadata.id, 'note-in-step'))
      .get()
    expect(row?.syncedAt).toBeTruthy()
    expect(row!.syncedAt! > row!.modifiedAt!).toBe(true)

    expect(recoverDirtyItems(asSyncDb(testDb.db), noteAdapters).notes).toBe(0)
    expect(recovered).toEqual([])
  })

  it('re-enqueues the note whose rename never reached the server', () => {
    // #given a note the server knows, renamed after its last confirmed push —
    // exactly the state the dropped-ack bug above leaves behind
    insertNote({
      id: 'note-diverged',
      clock: { mac: 2 },
      syncedAt: '2026-01-01T00:00:00Z',
      modifiedAt: '2026-01-02T00:00:00Z'
    })

    expect(recoverDirtyItems(asSyncDb(testDb.db), noteAdapters).notes).toBe(1)
    expect(recovered).toEqual(['note-diverged'])
  })
})
