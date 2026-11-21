/**
 * #3276: a note whose full state is over the non-pruning route's ceiling must
 * fail once, as a body-limit 413, so the runtime names the note to the user
 * and the provider keeps it pending. It used to throw a plain Error, which
 * `withRetry` retried four times and then dead-lettered with no visible error.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_CRDT_UPDATE_PAYLOAD_CHARS } from '@memry/sync-client/crdt-payload'
import type * as HttpClientModule from './http-client'

const { fetchMock, routes } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  /** Set by a test to answer a route instead of the real client. */
  routes: { request: null as null | (() => Promise<never>) }
}))

vi.mock('../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})
vi.mock('../crypto/index', () => ({ secureCleanup: vi.fn() }))
vi.mock('./crdt-encrypt', () => ({ encryptCrdtUpdate: (state: Uint8Array) => state }))
vi.mock('./http-client', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpClientModule>()
  return {
    ...actual,
    pushCrdtSnapshot: (...args: Parameters<typeof actual.pushCrdtSnapshot>) =>
      routes.request ? routes.request() : actual.pushCrdtSnapshot(...args),
    pushCrdtFullUpdate: (...args: Parameters<typeof actual.pushCrdtFullUpdate>) =>
      routes.request ? routes.request() : actual.pushCrdtFullUpdate(...args)
  }
})

import { createCrdtSnapshotPush } from './crdt-snapshot-push'
import { SyncServerError } from './http-client'
import { classifyError } from './sync-errors'

describe('createCrdtSnapshotPush on the non-pruning route', () => {
  it('fails an oversized unmerged note once, as a body-limit 413', async () => {
    // #given a note unmerged at the encode, whose state is over the D1 ceiling
    vi.stubGlobal('fetch', fetchMock)
    const onError = vi.fn()
    const push = createCrdtSnapshotPush({
      getAccessToken: async () => 'token-1',
      getVaultKey: async () => new Uint8Array(32),
      getSigningKey: async () => new Uint8Array(64),
      authRetryDeps: {
        refreshAccessToken: async () => false,
        getAccessToken: async () => 'token-1'
      },
      hasUnmergedRemoteState: () => false,
      onNotCovered: vi.fn(),
      onPushed: vi.fn(),
      onError
    })
    const oversized = new Uint8Array(MAX_CRDT_UPDATE_PAYLOAD_CHARS)

    // #when it is pushed
    const result = push('note-1', oversized, { unmerged: true })

    // #then it rejects at once with a non-retryable body-limit 413
    await expect(result).rejects.toBeInstanceOf(SyncServerError)
    expect(onError).toHaveBeenCalledTimes(1)
    const err = onError.mock.calls[0][1] as SyncServerError
    expect(err.statusCode).toBe(413)
    expect(classifyError(err).category).toBe('note_too_large')
    expect(fetchMock).not.toHaveBeenCalled()
  }, 1000)
})

describe('createCrdtSnapshotPush records the push before it sends (#5371)', () => {
  it.each([
    { route: 'snapshot', unmerged: false },
    { route: 'update', unmerged: true }
  ])('marks the note sent before a $route request whose reply is lost', async ({ unmerged }) => {
    // #given a request that fails after it left (the server may have stored it)
    const order: string[] = []
    routes.request = async () => {
      order.push('request')
      throw new SyncServerError('bad request', 400)
    }
    const push = createCrdtSnapshotPush({
      getAccessToken: async () => 'token-1',
      getVaultKey: async () => new Uint8Array(32),
      getSigningKey: async () => new Uint8Array(64),
      authRetryDeps: {
        refreshAccessToken: async () => false,
        getAccessToken: async () => 'token-1'
      },
      hasUnmergedRemoteState: () => false,
      onNotCovered: vi.fn(),
      onPushed: vi.fn(),
      onSending: (noteId) => order.push(`sent ${noteId}`),
      onError: vi.fn()
    })

    // #when it is pushed
    await push('note-1', new Uint8Array([1, 2, 3]), { unmerged }).catch(() => {})

    // #then the push was recorded before the first request left
    expect(order[0]).toBe('sent note-1')
    expect(order).toContain('request')
    routes.request = null
  })
})
