/**
 * #3276: a note whose full state is over the non-pruning route's ceiling must
 * fail once, as a body-limit 413, so the runtime names the note to the user
 * and the provider keeps it pending. It used to throw a plain Error, which
 * `withRetry` retried four times and then dead-lettered with no visible error.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_CRDT_UPDATE_PAYLOAD_CHARS } from '@memry/sync-client/crdt-payload'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))

vi.mock('../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})
vi.mock('../crypto/index', () => ({ secureCleanup: vi.fn() }))
vi.mock('./crdt-encrypt', () => ({ encryptCrdtUpdate: (state: Uint8Array) => state }))

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
