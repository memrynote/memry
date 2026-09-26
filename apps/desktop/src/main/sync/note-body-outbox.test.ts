import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { NOTE_BODY_FULL_STATE_PAYLOAD, SyncQueueManager } from '@memry/sync-client/queue'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import {
  NoteBodyFlushDeferredError,
  NoteBodyOutbox,
  importLegacyPendingCrdtNotes,
  type NoteBodyPushFn
} from './note-body-outbox'
import { RateLimitError, SyncServerError } from './http-client'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** Every text edit applied to one doc, captured as the raw Yjs updates it emitted. */
function recordEdits(texts: string[]): { updates: Uint8Array[]; doc: Y.Doc } {
  const doc = new Y.Doc()
  const updates: Uint8Array[] = []
  doc.on('update', (update: Uint8Array) => updates.push(update))
  for (const text of texts) doc.getText('body').insert(doc.getText('body').length, text)
  return { updates, doc }
}

/** What a peer ends up with after applying everything one push carried. */
function textAfter(pushed: Uint8Array[]): string {
  const doc = new Y.Doc()
  for (const update of pushed) Y.applyUpdate(doc, update)
  return doc.getText('body').toString()
}

describe('NoteBodyOutbox', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let push: ReturnType<typeof vi.fn<NoteBodyPushFn>>
  let outboxes: NoteBodyOutbox[]

  const createOutbox = (
    readFullState: (noteId: string) => Promise<Uint8Array | null> = async () => null
  ): NoteBodyOutbox => {
    const outbox = new NoteBodyOutbox({ queue, push })
    outbox.enableFullStateFlush(readFullState)
    outboxes.push(outbox)
    return outbox
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-24T09:00:00.000Z'))
    testDb = createTestDataDb()
    queue = new SyncQueueManager(testDb.db as unknown as DrizzleDb)
    push = vi.fn<NoteBodyPushFn>(async () => undefined)
    outboxes = []
  })

  afterEach(() => {
    for (const outbox of outboxes) outbox.stop()
    testDb.close()
    vi.useRealTimers()
  })

  // #2298: the review's acceptance test for the coalescing blocker.
  it('pushes two updates enqueued for one note before a flush, both of them', async () => {
    const { updates } = recordEdits(['first ', 'second'])
    const outbox = createOutbox()
    outbox.start()
    outbox.pause()

    outbox.enqueue('note-a', updates[0])
    outbox.enqueue('note-a', updates[1])
    outbox.resume()
    await flushPromises()

    expect(push).toHaveBeenCalledTimes(1)
    expect(textAfter(push.mock.calls[0][1])).toBe('first second')
    expect(outbox.getOutstandingCount()).toBe(0)
  })

  // #2298: crash between enqueue and flush.
  it('pushes updates a previous process enqueued but never flushed, as updates', async () => {
    const { updates } = recordEdits(['typed ', 'before the crash'])
    const readFullState = vi.fn(async () => new Uint8Array([9]))
    const crashed = createOutbox(readFullState)
    crashed.pause()
    crashed.enqueue('note-a', updates[0])
    crashed.enqueue('note-a', updates[1])
    // No stop(): the process dies with the rows still queued.

    const restarted = createOutbox(readFullState)
    restarted.start()
    await flushPromises()

    expect(push).toHaveBeenCalledTimes(1)
    expect(textAfter(push.mock.calls[0][1])).toBe('typed before the crash')
    expect(readFullState).not.toHaveBeenCalled()
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  // #2298
  it('posts one note’s updates in enqueue order when they merge into several', async () => {
    const big = 'x'.repeat(200 * 1024)
    const { updates } = recordEdits([big, big, 'tail'])
    const outbox = createOutbox()
    outbox.start()
    outbox.pause()
    for (const update of updates) outbox.enqueue('note-a', update)

    outbox.resume()
    await flushPromises()

    const pushed = push.mock.calls[0][1]
    expect(pushed).toHaveLength(2)
    expect(pushed[0]).toEqual(updates[0])
    expect(textAfter(pushed)).toBe(big + big + 'tail')
  })

  // #2289
  it('flushes a lone update on the leading edge instead of waiting for a tick', () => {
    const { updates } = recordEdits(['a'])
    const outbox = createOutbox()
    outbox.start()

    outbox.enqueue('note-a', updates[0])

    expect(push).toHaveBeenCalledWith('note-a', [updates[0]])
  })

  // #2289
  it('sends the updates of one window as a single trailing flush', async () => {
    const { updates } = recordEdits(['0', '1', '2', '3'])
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('note-a', updates[0])
    await flushPromises()

    for (const update of updates.slice(1)) {
      vi.advanceTimersByTime(20)
      outbox.enqueue('note-a', update)
    }
    expect(push).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(2)
    expect(textAfter([updates[0], ...push.mock.calls[1][1]])).toBe('0123')

    vi.advanceTimersByTime(5000)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(2)
  })

  // #2289
  it('flushes an update that lands mid-push once the push settles', async () => {
    const { updates } = recordEdits(['a', 'b'])
    let resolvePush!: () => void
    push.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePush = resolve
        })
    )
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('note-a', updates[0])

    vi.advanceTimersByTime(1500)
    outbox.enqueue('note-a', updates[1])
    vi.advanceTimersByTime(5000)
    expect(push).toHaveBeenCalledTimes(1)

    resolvePush()
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(2)
    expect(push).toHaveBeenLastCalledWith('note-a', [updates[1]])

    resolvePush()
    await flushPromises()
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  it('holds every note back until Retry-After once the server answers 429', async () => {
    const { updates } = recordEdits(['a', 'b'])
    push.mockRejectedValueOnce(new RateLimitError(5))
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('note-a', updates[0])
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)

    // Global, not per note: the server's crdt_push bucket is per device.
    outbox.enqueue('note-b', updates[1])
    vi.advanceTimersByTime(4000)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(push.mock.calls.map(([noteId]) => noteId).sort()).toEqual(['note-a', 'note-a', 'note-b'])
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  it('keeps the rows of a retryable failure and retries them on the next window', async () => {
    const { updates } = recordEdits(['a'])
    push.mockRejectedValueOnce(new SyncServerError('unavailable', 503))
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('note-a', updates[0])
    await flushPromises()
    expect(queue.countNoteBodyRows()).toBe(1)

    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(2)
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  // #2299 review round 2: an oversized note on the update route (flagged, or
  // refused) cannot push until its pull merges; it retried every second.
  it('backs a deferred note off exponentially and flushes it at once after a success', async () => {
    const { updates } = recordEdits(['a', 'b'])
    push.mockRejectedValue(new NoteBodyFlushDeferredError('CRDT snapshot fallback failed'))
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('note-a', updates[0])
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1999)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(3999)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(3)
    expect(queue.countNoteBodyRows()).toBe(1)

    push.mockReset()
    push.mockResolvedValue(undefined)
    vi.advanceTimersByTime(8000)
    await flushPromises()
    expect(queue.countNoteBodyRows()).toBe(0)
    outbox.enqueue('note-a', updates[1])
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('never backs off past a minute', async () => {
    const { updates } = recordEdits(['a'])
    push.mockRejectedValue(new NoteBodyFlushDeferredError('CRDT snapshot fallback failed'))
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('note-a', updates[0])
    await flushPromises()
    for (const waitMs of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const before = push.mock.calls.length
      vi.advanceTimersByTime(waitMs)
      await flushPromises()
      expect(push.mock.calls.length).toBe(before + 1)
    }
  })

  it('drops the rows of a non-retryable client rejection', async () => {
    const { updates } = recordEdits(['a'])
    push.mockRejectedValueOnce(new SyncServerError('bad update', 400))
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('note-a', updates[0])
    await flushPromises()

    expect(queue.countNoteBodyRows()).toBe(0)
  })

  it('keeps every row while paused and flushes them on resume', async () => {
    const { updates } = recordEdits(['a'])
    const outbox = createOutbox()
    outbox.start()
    outbox.pause()
    outbox.enqueue('note-a', updates[0])
    vi.advanceTimersByTime(5000)
    expect(push).not.toHaveBeenCalled()

    outbox.resume()
    await flushPromises()
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('drops a note’s rows without pushing them, and an in-flight ack does not bring them back', async () => {
    const { updates } = recordEdits(['a', 'b'])
    let resolvePush!: () => void
    push.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePush = resolve
        })
    )
    const outbox = createOutbox()
    outbox.start()
    outbox.enqueue('going-local', updates[0])
    outbox.enqueue('going-local', updates[1])

    outbox.dropNote('going-local')
    resolvePush()
    await flushPromises()
    vi.advanceTimersByTime(5000)
    await flushPromises()

    expect(push).toHaveBeenCalledTimes(1)
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  it('pushes the full doc state for a full-state row and acknowledges the updates it covers', async () => {
    const { updates, doc } = recordEdits(['edited ', 'while signed out'])
    const outbox = createOutbox(async () => Y.encodeStateAsUpdate(doc))
    queue.enqueueNoteBody('note-a', NOTE_BODY_FULL_STATE_PAYLOAD)
    outbox.enqueue('note-a', updates[1])

    outbox.start()
    await flushPromises()

    expect(push).toHaveBeenCalledTimes(1)
    expect(textAfter(push.mock.calls[0][1])).toBe('edited while signed out')
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  it('drops a full-state row for a note that no longer syncs', async () => {
    const outbox = createOutbox(async () => null)
    queue.enqueueNoteBody('deleted-note', NOTE_BODY_FULL_STATE_PAYLOAD)

    outbox.start()
    await flushPromises()

    expect(push).not.toHaveBeenCalled()
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  it('keeps full-state rows queued until full-state flushing is enabled', async () => {
    const { doc } = recordEdits(['owed'])
    const outbox = new NoteBodyOutbox({ queue, push })
    outboxes.push(outbox)
    queue.enqueueNoteBody('note-a', NOTE_BODY_FULL_STATE_PAYLOAD)

    outbox.start()
    await flushPromises()
    expect(push).not.toHaveBeenCalled()

    outbox.enableFullStateFlush(async () => Y.encodeStateAsUpdate(doc))
    await flushPromises()
    expect(textAfter(push.mock.calls[0][1])).toBe('owed')
  })

  it('flushes one full-state row at a time, like the replay it replaces', async () => {
    let release!: () => void
    const readFullState = vi.fn(
      (noteId: string) =>
        new Promise<Uint8Array>((resolve) => {
          release = () => resolve(new Uint8Array([noteId === 'note-a' ? 1 : 2]))
        })
    )
    const outbox = createOutbox(readFullState)
    queue.enqueueNoteBody('note-a', NOTE_BODY_FULL_STATE_PAYLOAD)
    queue.enqueueNoteBody('note-b', NOTE_BODY_FULL_STATE_PAYLOAD)

    outbox.start()
    await flushPromises()
    expect(readFullState).toHaveBeenCalledTimes(1)

    release()
    await flushPromises()
    expect(readFullState).toHaveBeenCalledTimes(2)
    release()
    await flushPromises()
    expect(push.mock.calls.map(([noteId]) => noteId).sort()).toEqual(['note-a', 'note-b'])
    expect(queue.countNoteBodyRows()).toBe(0)
  })

  it('keeps a full-state row when reading the state fails', async () => {
    const outbox = createOutbox(async () => {
      throw new Error('merge did not complete')
    })
    queue.enqueueNoteBody('note-a', NOTE_BODY_FULL_STATE_PAYLOAD)

    outbox.start()
    await flushPromises()

    expect(push).not.toHaveBeenCalled()
    expect(queue.countNoteBodyRows()).toBe(1)
  })
})

describe('importLegacyPendingCrdtNotes', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let dir: string

  beforeEach(() => {
    testDb = createTestDataDb()
    queue = new SyncQueueManager(testDb.db as unknown as DrizzleDb)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-pending-crdt-'))
  })

  afterEach(() => {
    testDb.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // #2298: notes an older build left owed must still be pushed after upgrade.
  it('turns every id an older build recorded into a full-state row, then retires the file', () => {
    const file = path.join(dir, 'crdt-pending-notes.json')
    fs.writeFileSync(file, JSON.stringify(['note-a', 'note-b']))

    expect(importLegacyPendingCrdtNotes(queue, dir)).toBe(2)

    expect(queue.listNoteBodyNoteIds().sort()).toEqual(['note-a', 'note-b'])
    expect(queue.takeNoteBodyRows('note-a', 10)[0].payload).toBe(NOTE_BODY_FULL_STATE_PAYLOAD)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('salvages the ids of a torn write', () => {
    fs.writeFileSync(path.join(dir, 'crdt-pending-notes.json'), '["note-a","note-b","note-')

    expect(importLegacyPendingCrdtNotes(queue, dir)).toBe(2)
    expect(queue.listNoteBodyNoteIds().sort()).toEqual(['note-a', 'note-b'])
  })

  it('does nothing when there is no file', () => {
    expect(importLegacyPendingCrdtNotes(queue, dir)).toBe(0)
    expect(queue.countNoteBodyRows()).toBe(0)
  })
})
