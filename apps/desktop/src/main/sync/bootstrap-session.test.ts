import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  abandonBootstrapSession,
  closeBootstrapSession,
  onBootstrapElevationChange,
  openBootstrapSession
} from './bootstrap-session'
import {
  clearBootstrapSessionState,
  getBootstrapElevationFactor,
  getBootstrapTokenHeaders
} from './bootstrap-session-state'
import { DownloadPacer, DownloadQueue } from './download-queue'
import {
  CRDT_SWEEP_CHUNK_INTERVAL_MS,
  CRDT_SWEEP_CHUNK_NOTES,
  CRDT_SWEEP_MS_PER_SNAPSHOT_GET,
  crdtSweepChunkDelayMs
} from './engine/sync-context'

vi.mock('./http-client', () => ({
  postToServer: vi.fn(),
  getFromServer: vi.fn()
}))

import { postToServer } from './http-client'

const postMock = vi.mocked(postToServer)

const OPEN_RESPONSE = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  session: {
    token: 'tok-open',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ttlSeconds: 3600
  },
  manifest: { items: [], serverTime: Math.floor(Date.now() / 1000) },
  tailCursor: 42,
  packs: [],
  ...overrides
})

beforeEach(() => {
  clearBootstrapSessionState()
  postMock.mockReset()
})

afterEach(() => {
  abandonBootstrapSession()
})

// ============================================================================
// Manager lifecycle: open / renew / close / fallback
// ============================================================================

describe('bootstrap session manager', () => {
  const getAccessToken = vi.fn().mockResolvedValue('access-jwt')

  it('opens a session, exposes the header + factor, and notifies listeners', async () => {
    // #given
    postMock.mockResolvedValueOnce(OPEN_RESPONSE())
    const seen: number[] = []
    onBootstrapElevationChange((factor) => seen.push(factor))

    // #when
    const result = await openBootstrapSession(getAccessToken)

    // #then
    expect(result).not.toBeNull()
    expect(result?.tailCursor).toBe(42)
    expect(getBootstrapTokenHeaders()['X-Memry-Bootstrap-Token']).toBe('tok-open')
    expect(getBootstrapElevationFactor()).toBe(5)
    expect(seen.at(-1)).toBe(5)

    // The open call itself carried no bootstrap header (there was nothing yet).
    expect(postMock).toHaveBeenCalledWith('/sync/bootstrap', undefined, 'access-jwt')
  })

  it('falls back silently when the server does not know the route', async () => {
    // #given — old server answers 404 → SyncServerError
    postMock.mockRejectedValueOnce(new Error('404'))

    // #when
    const result = await openBootstrapSession(getAccessToken)

    // #then — no throw, no state, steady-state factor
    expect(result).toBeNull()
    expect(getBootstrapTokenHeaders()).toEqual({})
    expect(getBootstrapElevationFactor()).toBe(1)
  })

  it('falls back silently on a malformed response', async () => {
    // #given
    postMock.mockResolvedValueOnce({ unexpected: true })

    // #when / #then
    expect(await openBootstrapSession(getAccessToken)).toBeNull()
    expect(getBootstrapElevationFactor()).toBe(1)
  })

  it('closes immediately locally (pacing reverts before any network round trip)', async () => {
    // #given
    postMock.mockResolvedValueOnce(OPEN_RESPONSE())
    await openBootstrapSession(getAccessToken)
    const seen: number[] = []
    onBootstrapElevationChange((factor) => seen.push(factor))

    // #when — the close POST is made to fail; local state must still be gone
    postMock.mockRejectedValueOnce(new Error('network down'))
    await closeBootstrapSession('completed')

    // #then
    expect(getBootstrapTokenHeaders()).toEqual({})
    expect(getBootstrapElevationFactor()).toBe(1)
    expect(seen.at(-1)).toBe(1)
  })

  it('renews before expiry and keeps elevation across the swap', async () => {
    // #given
    vi.useFakeTimers()
    try {
      const expires = Math.floor(Date.now() / 1000) + 3600
      postMock
        .mockResolvedValueOnce(
          OPEN_RESPONSE({ session: { token: 'tok-1', expiresAt: expires, ttlSeconds: 3600 } })
        )
        .mockResolvedValueOnce({
          session: { token: 'tok-2', expiresAt: expires + 3600, ttlSeconds: 3600 }
        })
      await openBootstrapSession(getAccessToken)

      // #when — renew fires ~5 min before expiry
      await vi.advanceTimersByTimeAsync((3600 - 300) * 1000)

      // #then — new token live, factor unchanged, renew used the OLD token's slot
      expect(getBootstrapTokenHeaders()['X-Memry-Bootstrap-Token']).toBe('tok-2')
      expect(getBootstrapElevationFactor()).toBe(5)
      expect(postMock).toHaveBeenLastCalledWith('/sync/bootstrap/renew', {}, 'access-jwt')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reverts pacing when renewal fails (expired/revoked token)', async () => {
    // #given
    vi.useFakeTimers()
    try {
      const expires = Math.floor(Date.now() / 1000) + 3600
      postMock
        .mockResolvedValueOnce(
          OPEN_RESPONSE({ session: { token: 'tok-1', expiresAt: expires, ttlSeconds: 3600 } })
        )
        .mockRejectedValueOnce(new Error('401'))
      await openBootstrapSession(getAccessToken)
      expect(getBootstrapElevationFactor()).toBe(5)

      // #when
      await vi.advanceTimersByTimeAsync((3600 - 300) * 1000)

      // #then — closed locally the moment renewal fails
      expect(getBootstrapElevationFactor()).toBe(1)
      expect(getBootstrapTokenHeaders()).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })
})

// ============================================================================
// Pacer elevation + revert (#1837)
// ============================================================================

describe('DownloadPacer elevation', () => {
  it('raises the ceiling under a live session and reverts on close', async () => {
    // #given — a pacer paced at 3/min against a base ceiling of 3
    const pacer = new DownloadPacer(3, 60_000)
    expect(pacer.effectiveMaxRequests).toBe(3)

    // #when — a bootstrap session grants 5x
    pacer.setMultiplier(5)

    // #then — fifteen requests pass without waiting
    expect(pacer.effectiveMaxRequests).toBe(15)
    for (let i = 0; i < 15; i++) await pacer.acquire()

    // #when — the session closes; the multiplier clamps back to the base
    pacer.setMultiplier(1)
    expect(pacer.effectiveMaxRequests).toBe(3)

    // #and a broken factor can only slow to the base, never below it
    pacer.setMultiplier(Number.NaN)
    expect(pacer.effectiveMaxRequests).toBe(3)
    pacer.setMultiplier(0.2)
    expect(pacer.effectiveMaxRequests).toBe(3)
  })

  it('applies through the queue so queued transfers pick it up', () => {
    // #given
    const queue = new DownloadQueue((async () => ({
      filePath: '/tmp/x'
    })) as unknown as ConstructorParameters<typeof DownloadQueue>[0])
    expect(queue.pending).toBe(0)

    // #when / #then — no throw, and the queue accepts elevation commands
    queue.setPaceMultiplier(5)
    queue.setPaceMultiplier(1)
  })
})

// ============================================================================
// Sweep pacing elevation (#1837)
// ============================================================================

describe('crdtSweepChunkDelayMs elevation', () => {
  const coldCost = {
    snapshotGets: CRDT_SWEEP_CHUNK_NOTES,
    batchPosts: 4
  }

  it('divides the charged delay by the granted factor', () => {
    // #given — the cold-chunk charge is snapshot-get bound at 20 s
    expect(crdtSweepChunkDelayMs(coldCost)).toBe(
      CRDT_SWEEP_CHUNK_NOTES * CRDT_SWEEP_MS_PER_SNAPSHOT_GET
    )

    // #when — a 5x bootstrap window is granted
    const elevated = crdtSweepChunkDelayMs(coldCost, 5)

    // #then — exactly one fifth, still integer ms
    expect(elevated).toBe(Math.ceil((CRDT_SWEEP_CHUNK_NOTES * CRDT_SWEEP_MS_PER_SNAPSHOT_GET) / 5))
    expect(elevated).toBeLessThan(crdtSweepChunkDelayMs(coldCost))
  })

  it('never drops below the elevated floor interval and reverts at factor 1', () => {
    // #given — the floor interval also divides (4 s / 5 = 800 ms)
    const warm = { snapshotGets: 0, batchPosts: 1 }
    expect(crdtSweepChunkDelayMs(warm, 5)).toBe(Math.ceil(CRDT_SWEEP_CHUNK_INTERVAL_MS / 5))

    // #when / #then — closing the session restores today's numbers exactly
    expect(crdtSweepChunkDelayMs(coldCost, 1)).toBe(crdtSweepChunkDelayMs(coldCost))
    // Broken factors clamp to 1 rather than poisoning the schedule.
    expect(crdtSweepChunkDelayMs(warm, Number.NaN)).toBe(CRDT_SWEEP_CHUNK_INTERVAL_MS)
    expect(crdtSweepChunkDelayMs(warm, -3)).toBe(CRDT_SWEEP_CHUNK_INTERVAL_MS)
  })
})
