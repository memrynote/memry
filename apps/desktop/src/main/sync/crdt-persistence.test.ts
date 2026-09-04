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

// The real module reaches into the electron store for the vault root. Mask mode
// is what an install with no vault open gets anyway, and it is what makes the
// redacted message assertion below deterministic.
vi.mock('../telemetry/redact-options', () => ({
  getMainRedactOptions: () => ({})
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

  // The reason ships now (#1989) but only through redactText, and never in a
  // dimension: SafeDimensionValueSchema is a blocklist, not a guarantee.
  it('redacts the store path out of the reason it ships', async () => {
    mockPreflight.mockResolvedValue({
      ok: false,
      stage: 'store',
      transport: 'node',
      reason: 'LevelDB lock held at /Users/kaan/Library/Application Support/Memry/crdt-store'
    })

    expect(await openCrdtPersistence(STORE)).toBeNull()

    const event = reportedEvent()
    const { message } = event.error as { message: string }
    expect(message).toContain('~/Library/Application Support/Memry/crdt-store')
    expect(JSON.stringify(event)).not.toContain('/Users/kaan')
    expect(event.dimensions).toEqual({ transport: 'node' })
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

  it('probes an empty control directory before blaming the store data', async () => {
    mockExistsSync.mockReturnValue(true)
    mockPreflight
      .mockResolvedValueOnce(failed('store', 'utility'))
      .mockResolvedValueOnce({ ok: true, transport: 'utility' } as CrdtPreflightResult)

    await openCrdtPersistence(STORE)

    // The control runs against its own directory, never against the user's.
    expect(mockPreflight).toHaveBeenNthCalledWith(1, STORE)
    expect(mockPreflight).toHaveBeenNthCalledWith(2, `${STORE}.probe`)
    // A control that passes means the data IS at fault: quarantine it, and
    // never move it back — a fresh store is the recovery.
    expect(mockMoveStoreDir).toHaveBeenCalledTimes(1)
    expect(mockMoveStoreDir).toHaveBeenCalledWith(STORE, expect.stringContaining('.broken-'))
    // The control directory is cleared before use and after, so a machine that
    // takes this path every launch strands at most one directory.
    expect(mockRmSync).toHaveBeenCalledWith(`${STORE}.probe`, { recursive: true, force: true })
    expect(mockRmSync).not.toHaveBeenCalledWith(STORE, expect.anything())
  })

  // The whole Windows population in issue #1583: the binding access-violates
  // against an empty directory as readily as against the user's data, so the
  // store was moved aside, rm'd and moved back on every launch, forever, and
  // not one install ever came out of it with a working store.
  it('never touches the store when the empty control directory fails too', async () => {
    mockExistsSync.mockReturnValue(true)
    mockPreflight
      .mockResolvedValueOnce(failed('store', 'utility'))
      .mockResolvedValueOnce(failed('store', 'node'))

    expect(await openCrdtPersistence(STORE)).toBeNull()

    expect(mockPreflight).toHaveBeenCalledTimes(2)
    expect(mockMoveStoreDir).not.toHaveBeenCalled()
    expect(mockRmSync).not.toHaveBeenCalledWith(STORE, expect.anything())
    // Restaged, because 'store' claims the data is a suspect and it is not.
    expect(reportedEvent()).toMatchObject({
      errorCode: 'CRDT_PERSISTENCE_UNAVAILABLE:binding-in-use',
      dimensions: { transport: 'node' }
    })
  })

  // #1989: this event used to ship a stage and a transport and nothing else, so
  // its Error Tracking issue was titled `CRDT_PERSISTENCE_UNAVAILABLE:binding-in-use`
  // and held no reason, no exit code and no OS. It was the top win32 issue.
  it('ships the redacted preflight reason so the issue is debuggable', async () => {
    mockExistsSync.mockReturnValue(true)
    mockPreflight
      .mockResolvedValueOnce(failed('store', 'utility'))
      .mockResolvedValueOnce(failed('store', 'node'))

    expect(await openCrdtPersistence(STORE)).toBeNull()

    const { message } = reportedEvent().error as { message: string }
    expect(message).toContain('CRDT persistence unavailable at binding-in-use')
    expect(message).toContain('transport=node')
    expect(message).toContain('0xC0000005')
  })

  // This event is ~100% win32, where the store path is C:\\Users\\<name>\\... and
  // is masked by a DIFFERENT regex than the darwin case above. Pinning only the
  // darwin branch would leave the branch that always fires unguarded.
  it('redacts a Windows store path out of the reason', async () => {
    mockPreflight.mockResolvedValue({
      ok: false,
      stage: 'binding-in-use',
      transport: 'node',
      reason: 'access violation at C:\\Users\\Kaan\\AppData\\Roaming\\Memry\\crdt-store'
    })

    expect(await openCrdtPersistence(STORE)).toBeNull()

    const event = reportedEvent()
    expect(JSON.stringify(event)).not.toContain('Kaan')
  })

  // A reason is a native error string and has no length contract. Over 512 chars
  // the sync-server 400s the whole batch and the client drops it permanently.
  it('caps the message so an oversized reason cannot 400 the batch', async () => {
    mockPreflight.mockResolvedValue({
      ok: false,
      stage: 'binding-in-use',
      transport: 'node',
      reason: 'access violation reading location '.repeat(120)
    })

    expect(await openCrdtPersistence(STORE)).toBeNull()

    const { message } = reportedEvent().error as { message: string }
    expect(message).toHaveLength(512)
  })

  it('leaves the store alone when the control directory cannot be cleared', async () => {
    mockExistsSync.mockReturnValue(true)
    mockRmSync.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted')
    })
    mockPreflight.mockResolvedValue(failed('store', 'utility'))

    expect(await openCrdtPersistence(STORE)).toBeNull()

    // No clean control means no evidence, and evidence is the only thing that
    // may move a user's CRDT history.
    expect(mockPreflight).toHaveBeenCalledTimes(1)
    expect(mockMoveStoreDir).not.toHaveBeenCalled()
  })
})
