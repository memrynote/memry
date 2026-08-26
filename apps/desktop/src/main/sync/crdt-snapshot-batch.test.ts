/**
 * The batched snapshot sender, and the three things it must never get wrong:
 * an old server (404) must still get every body, an unmerged note must never
 * ride the destructive endpoint, and a per-note `accepted: false` must come
 * back as `false` so the provider keeps the note pending.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pushCrdtSnapshotBatchMock } = vi.hoisted(() => ({
  pushCrdtSnapshotBatchMock: vi.fn()
}))

vi.mock('../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

vi.mock('../crypto/index', () => ({ secureCleanup: vi.fn() }))

// Real crypto would pull libsodium in for a test about request shaping. The
// bytes only have to be traceable back to the note they came from.
vi.mock('./crdt-encrypt', () => ({
  encryptCrdtUpdate: (state: Uint8Array, _key: Uint8Array, noteId: string) =>
    new Uint8Array([state[0] ?? 0, noteId.length])
}))

// SyncServerError stays real: the 404/413 branches are `instanceof` checks.
vi.mock('./http-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http-client')>()
  return { ...actual, pushCrdtSnapshotBatch: pushCrdtSnapshotBatchMock }
})

import { createCrdtSnapshotBatchPush, type CrdtSnapshotBatchDeps } from './crdt-snapshot-batch'
import { SyncServerError } from './http-client'
import type { SnapshotBatchEntry } from './crdt-provider'

const entry = (noteId: string): SnapshotBatchEntry => ({
  noteId,
  state: new Uint8Array([1, 2, 3])
})

const createDeps = (
  overrides: Partial<CrdtSnapshotBatchDeps> = {}
): {
  deps: CrdtSnapshotBatchDeps
  pushSingle: ReturnType<typeof vi.fn>
  onBatchError: ReturnType<typeof vi.fn>
} => {
  const pushSingle = vi.fn().mockResolvedValue(undefined)
  const onBatchError = vi.fn()
  const deps: CrdtSnapshotBatchDeps = {
    pushSingle,
    hasUnmergedRemoteState: () => false,
    getAccessToken: async () => 'token-1',
    getVaultKey: async () => new Uint8Array(32),
    getSigningKey: async () => new Uint8Array(64),
    authRetryDeps: {
      refreshAccessToken: async () => false,
      getAccessToken: async () => 'token-1'
    },
    onBatchError,
    ...overrides
  }
  return { deps, pushSingle, onBatchError }
}

const acceptAll = (): void => {
  pushCrdtSnapshotBatchMock.mockImplementation(async (snapshots: Array<{ noteId: string }>) => ({
    results: snapshots.map((s) => ({ noteId: s.noteId, accepted: true, sequenceNum: 1 }))
  }))
}

describe('createCrdtSnapshotBatchPush', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends every note in one request and answers for each of them', async () => {
    // #given three notes queued behind one seeded vault push
    acceptAll()
    const { deps, pushSingle } = createDeps()

    // #when
    const results = await createCrdtSnapshotBatchPush(deps)([
      entry('note-a'),
      entry('note-b'),
      entry('note-c')
    ])

    // #then one request, not three — the whole point of the endpoint.
    expect(pushCrdtSnapshotBatchMock).toHaveBeenCalledTimes(1)
    expect(pushSingle).not.toHaveBeenCalled()
    expect([...results.entries()]).toEqual([
      ['note-a', true],
      ['note-b', true],
      ['note-c', true]
    ])
  })

  it('splits at the wire cap instead of letting the server 400 the request', async () => {
    // #given more notes than one request may carry
    acceptAll()
    const { deps } = createDeps()
    const entries = Array.from({ length: 120 }, (_, i) => entry(`note-${i}`))

    // #when
    const results = await createCrdtSnapshotBatchPush(deps)(entries)

    // #then 50 + 50 + 20, and every note still accounted for.
    const sizes = pushCrdtSnapshotBatchMock.mock.calls.map((call) => (call[0] as unknown[]).length)
    expect(sizes).toEqual([50, 50, 20])
    expect(results.size).toBe(120)
    expect([...results.values()].every(Boolean)).toBe(true)
  })

  it('reports a per-note rejection as false so the note stays retryable', async () => {
    // #given a 200 response in which one entry failed. HTTP-level success is
    // not per-note success, and reading it as one silently drops a body.
    pushCrdtSnapshotBatchMock.mockResolvedValue({
      results: [
        { noteId: 'note-a', accepted: true, sequenceNum: 4 },
        { noteId: 'note-b', accepted: false, reason: 'storage_quota_exceeded' }
      ]
    })
    const { deps } = createDeps()

    // #when
    const results = await createCrdtSnapshotBatchPush(deps)([entry('note-a'), entry('note-b')])

    // #then
    expect(results.get('note-a')).toBe(true)
    expect(results.get('note-b')).toBe(false)
  })

  it('treats a note the response never mentioned as not pushed', async () => {
    // #given a response missing an entry. Defaulting the other way would mark a
    // body durable on the strength of silence.
    pushCrdtSnapshotBatchMock.mockResolvedValue({
      results: [{ noteId: 'note-a', accepted: true }]
    })
    const { deps } = createDeps()

    // #when
    const results = await createCrdtSnapshotBatchPush(deps)([entry('note-a'), entry('note-b')])

    // #then
    expect(results.get('note-b')).toBe(false)
  })

  describe('#given a sync server with no batch endpoint', () => {
    const notFound = (): SyncServerError => new SyncServerError('Server returned 404', 404)

    it('falls back to the per-note push and remembers the answer for the session', async () => {
      // #given the endpoint 404s, which is exactly what every server released
      // before it does.
      pushCrdtSnapshotBatchMock.mockRejectedValue(notFound())
      const { deps, pushSingle } = createDeps()
      const push = createCrdtSnapshotBatchPush(deps)

      // #when two rounds of notes go out
      const first = await push([entry('note-a'), entry('note-b')])
      const second = await push([entry('note-c')])

      // #then every body still reached the server the old way...
      expect(pushSingle.mock.calls.map((c) => c[0])).toEqual(['note-a', 'note-b', 'note-c'])
      expect(first.get('note-a')).toBe(true)
      expect(second.get('note-c')).toBe(true)
      // ...and the 404 was paid exactly once, not once per batch.
      expect(pushCrdtSnapshotBatchMock).toHaveBeenCalledTimes(1)
    })

    it('reports a note the fallback could not push either', async () => {
      // #given an old server AND a note the single push rejects
      pushCrdtSnapshotBatchMock.mockRejectedValue(notFound())
      const { deps, pushSingle } = createDeps()
      pushSingle.mockRejectedValueOnce(new Error('server offline'))

      // #when
      const results = await createCrdtSnapshotBatchPush(deps)([entry('note-a'), entry('note-b')])

      // #then the failure is a `false`, never a throw: the provider needs the
      // answer to restore that note's pending-snapshot debt.
      expect(results.get('note-a')).toBe(false)
      expect(results.get('note-b')).toBe(true)
    })
  })

  it('never lets an unmerged note ride the destructive batch', async () => {
    // #given one note whose server state this device could not merge. The batch
    // endpoint prunes every device's crdt_updates rows at or below the new
    // watermark — including the payload this device skipped (#1503).
    acceptAll()
    const { deps, pushSingle } = createDeps({
      hasUnmergedRemoteState: (noteId) => noteId === 'note-unmerged'
    })

    // #when
    const results = await createCrdtSnapshotBatchPush(deps)([
      entry('note-a'),
      entry('note-unmerged')
    ])

    // #then it goes through the single push, which routes it to the
    // non-pruning endpoint, and the batch never sees it.
    expect(pushSingle).toHaveBeenCalledTimes(1)
    expect(pushSingle.mock.calls[0][0]).toBe('note-unmerged')
    const batched = pushCrdtSnapshotBatchMock.mock.calls[0][0] as Array<{ noteId: string }>
    expect(batched.map((s) => s.noteId)).toEqual(['note-a'])
    expect(results.get('note-unmerged')).toBe(true)
  })

  it('retries a too-large batch one note at a time so the offender can be named', async () => {
    // #given a 413 on the aggregate body, which says nothing about WHICH note
    // is too big. Only the per-note path can tell the user.
    pushCrdtSnapshotBatchMock.mockRejectedValue(new SyncServerError('too large', 413))
    const { deps, pushSingle } = createDeps()
    const push = createCrdtSnapshotBatchPush(deps)

    // #when
    await push([entry('note-a'), entry('note-b')])
    await push([entry('note-c')])

    // #then it fell back...
    expect(pushSingle.mock.calls.map((c) => c[0])).toEqual(['note-a', 'note-b', 'note-c'])
    // ...but did NOT latch: a 413 is about one payload, not about the server.
    expect(pushCrdtSnapshotBatchMock).toHaveBeenCalledTimes(2)
  })

  it('hands a transport failure to the runtime and keeps every note pending', async () => {
    // #given a 401 the auth retry could not fix
    const unauthorized = new SyncServerError('unauthorized', 401)
    pushCrdtSnapshotBatchMock.mockRejectedValue(unauthorized)
    const { deps, onBatchError, pushSingle } = createDeps()

    // #when
    const results = await createCrdtSnapshotBatchPush(deps)([entry('note-a'), entry('note-b')])

    // #then the runtime gets the error (it pauses the CRDT queue on 401) and
    // both notes read as not pushed. No per-note fallback: a 401 would fail
    // there too, and re-pushing would only burn the same broken token.
    expect(onBatchError).toHaveBeenCalledWith(unauthorized)
    expect(pushSingle).not.toHaveBeenCalled()
    expect([...results.values()]).toEqual([false, false])
  })

  it('sends nothing when the credentials went away mid-session', async () => {
    // #given a token that expired during an outage
    acceptAll()
    const { deps, pushSingle } = createDeps({ getAccessToken: async () => null })

    // #when
    const results = await createCrdtSnapshotBatchPush(deps)([entry('note-a')])

    // #then no request, and the note stays pending rather than being reported
    // durable.
    expect(pushCrdtSnapshotBatchMock).not.toHaveBeenCalled()
    expect(pushSingle).not.toHaveBeenCalled()
    expect(results.get('note-a')).toBe(false)
  })
})
