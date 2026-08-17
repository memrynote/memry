import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrdtPreflightResult } from './crdt-preflight'

const mockPreflight = vi.hoisted(() => vi.fn())
const mockMoveStoreDir = vi.hoisted(() => vi.fn())
const mockTrackMainEvent = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())
const mockRmSync = vi.hoisted(() => vi.fn())

vi.mock('./crdt-preflight', () => ({
  runCrdtPreflight: (...args: unknown[]) => mockPreflight(...args)
}))

vi.mock('./crdt-store-move', () => ({
  moveStoreDir: (...args: unknown[]) => mockMoveStoreDir(...args)
}))

vi.mock('../telemetry/track', () => ({
  trackMainEvent: (...args: unknown[]) => mockTrackMainEvent(...args)
}))

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// The real binding is never loaded here: every test below is about the verdict
// path that runs BEFORE it, and a store that passes preflight would then try to
// open LevelDB for real.
vi.mock('y-leveldb', () => ({
  LeveldbPersistence: class {
    storeUpdate = vi.fn().mockRejectedValue(new Error('binding unavailable in tests'))
    getYDoc = vi.fn()
    clearDocument = vi.fn()
    flushDocument = vi.fn()
    destroy = vi.fn()
  }
}))

import { openCrdtPersistence } from './crdt-persistence'

const STORE = '/tmp/memry-test/crdt-store'

const failed = (
  stage: CrdtPreflightResult['stage'],
  transport?: CrdtPreflightResult['transport']
): CrdtPreflightResult => ({
  ok: false,
  stage,
  transport,
  reason: `child exited with code 3221225477 (0xC0000005) at ${STORE}`
})

/** The single `app_error_seen` the call under test emitted. */
const reportedEvent = (): Record<string, unknown> => {
  const errorEvents = mockTrackMainEvent.mock.calls.filter(([name]) => name === 'app_error_seen')
  expect(errorEvents).toHaveLength(1)
  return errorEvents[0][1] as Record<string, unknown>
}

describe('openCrdtPersistence telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockMoveStoreDir.mockResolvedValue(true)
  })

  it('reports the failure point when the binding aborts opening the store', async () => {
    mockPreflight.mockResolvedValue(failed('store', 'node'))
    mockExistsSync.mockReturnValue(false) // nothing to quarantine

    expect(await openCrdtPersistence(STORE)).toBeNull()

    expect(reportedEvent()).toMatchObject({
      surface: 'app',
      action: 'init',
      source: 'crdt',
      result: 'failed',
      errorCode: 'CRDT_PERSISTENCE_UNAVAILABLE:store',
      dimensions: { transport: 'node' }
    })
  })

  it('distinguishes a child that never booted from one that reached the store', async () => {
    mockPreflight.mockResolvedValue(failed('bootstrap', 'utility'))

    expect(await openCrdtPersistence(STORE)).toBeNull()

    expect(reportedEvent()).toMatchObject({
      errorCode: 'CRDT_PERSISTENCE_UNAVAILABLE:bootstrap',
      dimensions: { transport: 'utility' }
    })
  })

  it('never ships the reason string, which can carry the store path', async () => {
    mockPreflight.mockResolvedValue(failed('store', 'node'))

    expect(await openCrdtPersistence(STORE)).toBeNull()

    // One dimension is the hard schema limit, and a path would be dropped by
    // the sanitizer anyway — but the assertion that matters is that no field
    // carries the reason at all.
    expect(JSON.stringify(reportedEvent())).not.toContain(STORE)
    expect(JSON.stringify(reportedEvent())).not.toContain('0xC0000005')
  })

  it('attributes a post-preflight failure to the probe, not to the preflight', async () => {
    // Preflight passes, so the binding loads for real — and the mocked store
    // rejects, which is the out-of-band-abort shape this path exists for.
    mockPreflight.mockResolvedValue({ ok: true, transport: 'utility' } as CrdtPreflightResult)

    expect(await openCrdtPersistence(STORE)).toBeNull()

    expect(reportedEvent()).toMatchObject({
      errorCode: 'CRDT_PERSISTENCE_UNAVAILABLE:probe'
    })
  })

  it('stays silent when the store opens, so the event counts breakage not crashes', async () => {
    // A preflight child that dies during Chromium bootstrap and then passes on
    // the node fallback is the recovered case: `Utility:crashed:CrdtPreflight`
    // fires, and this event must not.
    mockPreflight.mockResolvedValue({ ok: true, transport: 'node' } as CrdtPreflightResult)
    mockExistsSync.mockReturnValue(true)

    await openCrdtPersistence(STORE)

    // The probe still fails against the mocked binding above, so assert on the
    // preflight verdict rather than on silence overall.
    expect(reportedEvent()).not.toMatchObject({
      errorCode: 'CRDT_PERSISTENCE_UNAVAILABLE:store'
    })
  })

  it('re-probes a fresh directory before blaming the binding', async () => {
    mockExistsSync.mockReturnValue(true)
    mockPreflight
      .mockResolvedValueOnce(failed('store', 'utility'))
      .mockResolvedValueOnce(failed('store', 'node'))

    expect(await openCrdtPersistence(STORE)).toBeNull()

    expect(mockPreflight).toHaveBeenCalledTimes(2)
    // Quarantined, re-probed, then restored — the fresh directory the failed
    // re-probe left behind is cleared first, or the restore fails EPERM.
    expect(mockMoveStoreDir).toHaveBeenNthCalledWith(1, STORE, expect.stringContaining('.broken-'))
    expect(mockRmSync).toHaveBeenCalledWith(STORE, { recursive: true, force: true })
    expect(mockMoveStoreDir).toHaveBeenNthCalledWith(2, expect.stringContaining('.broken-'), STORE)
    expect(reportedEvent()).toMatchObject({
      errorCode: 'CRDT_PERSISTENCE_UNAVAILABLE:store',
      dimensions: { transport: 'node' }
    })
  })
})
