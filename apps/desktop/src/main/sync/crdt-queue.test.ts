import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CrdtUpdateQueue, type CrdtUpdateQueueOptions } from './crdt-queue'
import { SyncServerError } from './http-client'

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('CrdtUpdateQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T09:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('buffers updates by note, flushes on the interval, and tracks outstanding work', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi.fn(async () => undefined)

    queue.start(push)
    queue.enqueue('note-a', new Uint8Array([1]))
    queue.enqueue('note-a', new Uint8Array([2]))
    queue.enqueue('note-b', new Uint8Array([3]))

    expect(queue.getPendingCount()).toBe(3)
    expect(queue.getOutstandingCount()).toBe(3)

    vi.advanceTimersByTime(1000)

    expect(push).toHaveBeenCalledWith('note-a', [new Uint8Array([1]), new Uint8Array([2])])
    expect(push).toHaveBeenCalledWith('note-b', [new Uint8Array([3])])
    expect(queue.getPendingCount()).toBe(0)
    expect(queue.getOutstandingCount()).toBe(2)

    await flushPromises()
    expect(queue.getOutstandingCount()).toBe(0)

    queue.stop()
  })

  it('pauses flushes, resumes queued work, and retries retryable push failures', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi
      .fn<(noteId: string, updates: Uint8Array[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(undefined)

    queue.start(push)
    queue.pause()
    queue.enqueue('note-a', new Uint8Array([1]))
    vi.advanceTimersByTime(1000)

    expect(push).not.toHaveBeenCalled()
    expect(queue.getPendingCount()).toBe(1)

    queue.resume()
    expect(push).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(1)

    vi.advanceTimersByTime(1000)
    expect(push).toHaveBeenCalledTimes(2)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(0)

    queue.stop()
  })

  it('re-buffers the flushed batch when the push fails with a 401', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi.fn(async () => {
      throw new SyncServerError('Token expired: "exp" claim', 401)
    })

    queue.start(push)
    queue.enqueue('note-a', new Uint8Array([1]))
    queue.enqueue('note-a', new Uint8Array([2]))
    vi.advanceTimersByTime(1000)

    expect(push).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(2)

    queue.pause()
    queue.stop()
  })

  it('drops non-retryable client failures and flushes immediately at the max batch size', async () => {
    const queue = new CrdtUpdateQueue()
    const push = vi.fn(async () => {
      throw new SyncServerError('bad update', 400)
    })

    queue.start(push)
    for (let i = 0; i < 50; i++) {
      queue.enqueue('note-a', new Uint8Array([i]))
    }

    expect(push).toHaveBeenCalledTimes(1)
    await flushPromises()
    expect(queue.getPendingCount()).toBe(0)
    expect(queue.getOutstandingCount()).toBe(0)

    queue.stop()
  })

  it('drops updates flushed before a push function is registered', async () => {
    const queue = new CrdtUpdateQueue()

    queue.enqueue('note-a', new Uint8Array([1]))
    queue.stop()

    expect(queue.getPendingCount()).toBe(0)
  })

  it('coalesces a paused buffer instead of growing it per update, losing nothing', async () => {
    const queue = new CrdtUpdateQueue()
    const pushed: Uint8Array[] = []
    const push = vi.fn(async (_noteId: string, updates: Uint8Array[]) => {
      pushed.push(...updates)
    })

    // Real Yjs updates, one per transaction, exactly what the provider forwards
    // while the queue is paused. ~1KB each so the total crosses the merged-run
    // size bound several times over and the coalesced buffer holds more than a
    // single merged entry.
    const source = new Y.Doc()
    const rawUpdates: Uint8Array[] = []
    source.on('update', (update: Uint8Array) => rawUpdates.push(update))
    const text = source.getText('body')
    for (let i = 0; i < 1000; i++) {
      text.insert(text.length, `${String(i).padStart(4, '0')}${'x'.repeat(1020)}`)
    }
    expect(rawUpdates).toHaveLength(1000)

    queue.start(push)
    queue.pause()
    for (const update of rawUpdates) {
      queue.enqueue('note-a', update)
    }

    // Bounded: a handful of merged runs, not one buffer entry per edit.
    expect(queue.getPendingCount()).toBeLessThanOrEqual(50)
    expect(queue.getPendingCount()).toBeGreaterThan(1)
    expect(push).not.toHaveBeenCalled()

    queue.resume()
    for (let i = 0; i < 20; i++) {
      await flushPromises()
      vi.advanceTimersByTime(1000)
    }
    await flushPromises()
    expect(queue.getPendingCount()).toBe(0)

    // No flush carries a payload the server would reject (~900KB base64).
    for (const [, updates] of push.mock.calls) {
      const bytes = updates.reduce((total, update) => total + update.byteLength, 0)
      expect(bytes).toBeLessThanOrEqual(768 * 1024)
    }

    // Every character the user typed while paused still reaches the server.
    const replica = new Y.Doc()
    for (const update of pushed) {
      Y.applyUpdate(replica, update)
    }
    expect(replica.getText('body').toString()).toBe(text.toString())

    queue.stop()
  })

  it('hands still-buffered notes to the durable store when stopped while paused', () => {
    const persistUnflushed = vi.fn()
    const queue = new CrdtUpdateQueue({ persistUnflushed })

    queue.start(vi.fn(async () => undefined))
    queue.pause()
    queue.enqueue('note-a', new Uint8Array([1]))
    queue.enqueue('note-b', new Uint8Array([2]))

    queue.stop()

    expect(persistUnflushed).toHaveBeenCalledWith(['note-a', 'note-b'])
  })

  it('flushes instead of releasing when the total budget is crossed while running', async () => {
    const persistUnflushed = vi.fn()
    const queue = new CrdtUpdateQueue({ persistUnflushed })
    const pushedNotes: string[] = []
    const push = vi.fn(async (noteId: string) => {
      pushedNotes.push(noteId)
    })

    queue.start(push)
    // 40MB across 20 notes, past the 32MB total ceiling, with no pause: the
    // sweep must drain to the server rather than release anything.
    for (let i = 0; i < 20; i++) {
      queue.enqueue(`note-${i}`, new Uint8Array(2 * 1024 * 1024))
      vi.advanceTimersByTime(1)
    }

    expect(persistUnflushed).not.toHaveBeenCalled()
    expect(queue.getPendingBytes()).toBeLessThanOrEqual(32 * 1024 * 1024)

    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(new Set(pushedNotes).size).toBe(20)
    expect(queue.getPendingBytes()).toBe(0)

    queue.stop()
  })

  it('bounds the total buffer across notes while paused without losing an update', async () => {
    const persisted: string[] = []
    const persistUnflushed = vi.fn((noteIds: string[]) => {
      persisted.push(...noteIds)
    })
    const queue = new CrdtUpdateQueue({ persistUnflushed })
    const pushedByNote = new Map<string, Uint8Array[]>()
    const push = vi.fn(async (noteId: string, updates: Uint8Array[]) => {
      const existing = pushedByNote.get(noteId) ?? []
      existing.push(...updates)
      pushedByNote.set(noteId, existing)
    })

    // 20 notes, ~2MB of real edits each — 40MB in total, well past the 32MB
    // cross-note ceiling, while every per-note cap is still satisfied.
    const noteIds = Array.from({ length: 20 }, (_, i) => `note-${i}`)
    const docs = new Map<string, Y.Doc>()
    const rawByNote = new Map<string, Uint8Array[]>()
    for (const noteId of noteIds) {
      const doc = new Y.Doc()
      const raw: Uint8Array[] = []
      doc.on('update', (update: Uint8Array) => raw.push(update))
      doc.getText('body').insert(0, `${noteId}:${'x'.repeat(2 * 1024 * 1024)}`)
      docs.set(noteId, doc)
      rawByNote.set(noteId, raw)
    }

    queue.start(push)
    queue.pause()
    for (const noteId of noteIds) {
      for (const update of rawByNote.get(noteId)!) {
        queue.enqueue(noteId, update)
      }
      // Distinct timestamps so "oldest first" is a real ordering, not the
      // stable-sort fallback.
      vi.advanceTimersByTime(1)
    }

    // The map is bounded now, not just each note's slot in it.
    expect(persisted.length).toBeGreaterThan(0)
    // Released oldest first, and only as far as the low-water mark.
    expect(persisted).toEqual(noteIds.slice(0, persisted.length))
    expect(queue.getPendingBytes()).toBeLessThanOrEqual(32 * 1024 * 1024)
    expect(push).not.toHaveBeenCalled()

    queue.resume()
    for (let i = 0; i < 5; i++) {
      await flushPromises()
      vi.advanceTimersByTime(1000)
    }
    await flushPromises()
    expect(queue.getPendingBytes()).toBe(0)

    // Nothing was lost: every note either reached the server through the queue
    // or was recorded for the full-state replay `drainPendingCrdtNotes` runs.
    const replayed = new Set(persisted)
    expect(new Set([...replayed, ...pushedByNote.keys()])).toEqual(new Set(noteIds))
    for (const noteId of noteIds) {
      const replica = new Y.Doc()
      if (replayed.has(noteId)) {
        Y.applyUpdate(replica, Y.encodeStateAsUpdate(docs.get(noteId)!))
      }
      for (const update of pushedByNote.get(noteId) ?? []) {
        Y.applyUpdate(replica, update)
      }
      expect(replica.getText('body').toString()).toBe(docs.get(noteId)!.getText('body').toString())
    }

    queue.stop()
  })

  it('keeps every buffered update when there is no durable store to release into', () => {
    const queue = new CrdtUpdateQueue()

    queue.start(vi.fn(async () => undefined))
    queue.pause()
    for (let i = 0; i < 20; i++) {
      queue.enqueue(`note-${i}`, new Uint8Array(2 * 1024 * 1024))
      vi.advanceTimersByTime(1)
    }

    expect(queue.getPendingCount()).toBe(20)
    expect(queue.getPendingBytes()).toBe(40 * 1024 * 1024)

    queue.stop()
  })

  it('keeps every buffered update when recording notes for replay throws', () => {
    // Typed off the real option so the throwing implementation does not narrow the
    // mock's return type to `never` and lock out the `undefined` restore below.
    const persistUnflushed = vi.fn<NonNullable<CrdtUpdateQueueOptions['persistUnflushed']>>(() => {
      throw new Error('disk full')
    })
    const queue = new CrdtUpdateQueue({ persistUnflushed })

    queue.start(vi.fn(async () => undefined))
    queue.pause()
    for (let i = 0; i < 20; i++) {
      queue.enqueue(`note-${i}`, new Uint8Array(2 * 1024 * 1024))
      vi.advanceTimersByTime(1)
    }

    expect(persistUnflushed).toHaveBeenCalled()
    expect(queue.getPendingCount()).toBe(20)
    expect(queue.getPendingBytes()).toBe(40 * 1024 * 1024)

    persistUnflushed.mockImplementation(() => undefined)
    queue.stop()
  })

  it('does not persist anything when the shutdown flush drains the buffers', async () => {
    const persistUnflushed = vi.fn()
    const queue = new CrdtUpdateQueue({ persistUnflushed })

    queue.start(vi.fn(async () => undefined))
    queue.enqueue('note-a', new Uint8Array([1]))
    await flushPromises()
    vi.advanceTimersByTime(1000)
    await flushPromises()

    queue.stop()

    expect(persistUnflushed).not.toHaveBeenCalled()
  })
})
