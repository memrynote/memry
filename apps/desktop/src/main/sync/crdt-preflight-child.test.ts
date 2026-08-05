import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { PREFLIGHT_MARK_BINDING_LOADED, PREFLIGHT_MARK_STARTED } from './crdt-preflight-protocol'

const mockWriteSync = vi.hoisted(() => vi.fn())
const mockRmSync = vi.hoisted(() => vi.fn())
const mockRmdirSync = vi.hoisted(() => vi.fn())
const mockUnlinkSync = vi.hoisted(() => vi.fn())
const mockRequire = vi.hoisted(() => vi.fn())

// Only the entry points the child actually uses are swapped; everything else
// stays real so yjs keeps working. The delete-shaped calls are stubbed purely
// so the test can prove the child never reaches for them.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    writeSync: mockWriteSync,
    rmSync: mockRmSync,
    rmdirSync: mockRmdirSync,
    unlinkSync: mockUnlinkSync
  }
})

// y-leveldb is pulled in through createRequire, not a static import, so the
// binding is intercepted at the require boundary. Loading the real one here
// would dlopen classic-level in the test runner.
vi.mock('module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('module')>()
  return { ...actual, createRequire: () => mockRequire }
})

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const PROBE_DOC = '__memry_preflight__'
const STORE_DIR = '/Users/ada/Library/Application Support/memry/crdt-store'

interface FakePersistence {
  storeUpdate: ReturnType<typeof vi.fn>
  getYDoc: ReturnType<typeof vi.fn>
  clearDocument: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

let persistence: FakePersistence
let constructedWith: string[]
let loadedDoc: { destroy: ReturnType<typeof vi.fn> }
let exitSpy: MockInstance<(code?: number) => never>
let abortSpy: MockInstance<() => never>
let errorSpy: MockInstance

function makePersistence(): FakePersistence {
  loadedDoc = { destroy: vi.fn() }
  return {
    storeUpdate: vi.fn(async () => undefined),
    getYDoc: vi.fn(async () => loadedDoc),
    clearDocument: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined)
  }
}

/** Boot the child fresh — it runs `main()` at import time. `null` = no argv[2]. */
async function runChild(storeDir: string | null = STORE_DIR): Promise<number | undefined> {
  process.argv = storeDir === null ? ['node', 'child.js'] : ['node', 'child.js', storeDir]
  vi.resetModules()
  await import('./crdt-preflight-child')
  // Every path must terminate: the parent only has a 10s timeout to fall back
  // on, and a child that neither exits nor crashes stalls CRDT startup.
  await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled())
  return exitSpy.mock.calls[0]?.[0]
}

const marks = (): string[] =>
  mockWriteSync.mock.calls.filter(([fd]) => fd === 2).map(([, line]) => String(line))

describe('crdt-preflight-child', () => {
  const originalArgv = process.argv
  const originalNodeEnv = process.env.NODE_ENV
  const originalCrashFlag = process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH

  beforeEach(() => {
    persistence = makePersistence()
    constructedWith = []
    mockWriteSync.mockReset().mockReturnValue(0)
    mockRequire.mockReset().mockImplementation((id: string) => {
      if (id !== 'y-leveldb') throw new Error(`unexpected require: ${id}`)
      return {
        LeveldbPersistence: class {
          constructor(dir: string) {
            constructedWith.push(dir)
          }
          storeUpdate = persistence.storeUpdate
          getYDoc = persistence.getYDoc
          clearDocument = persistence.clearDocument
          destroy = persistence.destroy
        }
      }
    })

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    // Guard the runner: a real abort() would take the vitest worker with it.
    abortSpy = vi.spyOn(process, 'abort').mockImplementation((() => {
      throw new Error('process.abort() called')
    }) as never)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    delete process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH
  })

  afterEach(() => {
    process.argv = originalArgv
    process.env.NODE_ENV = originalNodeEnv
    if (originalCrashFlag === undefined) delete process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH
    else process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH = originalCrashFlag
    vi.restoreAllMocks()
  })

  describe('success path', () => {
    it('round-trips a probe doc through the real store and exits 0', async () => {
      const code = await runChild()

      expect(constructedWith).toEqual([STORE_DIR])
      expect(persistence.storeUpdate).toHaveBeenCalledTimes(1)
      const [docName, update] = persistence.storeUpdate.mock.calls[0]
      expect(docName).toBe(PROBE_DOC)
      expect(update).toBeInstanceOf(Uint8Array)
      expect((update as Uint8Array).byteLength).toBeGreaterThan(0)

      expect(persistence.getYDoc).toHaveBeenCalledWith(PROBE_DOC)
      expect(loadedDoc.destroy).toHaveBeenCalled()
      expect(code).toBe(0)
    })

    it('clears the probe doc and closes the store, releasing the LevelDB LOCK', async () => {
      // Without clearDocument the throwaway doc stays in the user's store
      // forever; without destroy the LOCK is still held when main opens the
      // same directory moments later.
      await runChild()

      expect(persistence.clearDocument).toHaveBeenCalledWith(PROBE_DOC)
      expect(persistence.destroy).toHaveBeenCalledTimes(1)
    })

    it('never deletes anything on disk — quarantine is the parent’s decision', async () => {
      await runChild()

      expect(mockRmSync).not.toHaveBeenCalled()
      expect(mockRmdirSync).not.toHaveBeenCalled()
      expect(mockUnlinkSync).not.toHaveBeenCalled()
    })

    it('probes the exact directory it was handed, including Windows paths', async () => {
      const windowsDir = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\memry\\crdt-store'

      await runChild(windowsDir)

      // No normalization, no re-derivation from app paths: the parent owns the
      // location, and probing a different directory would prove nothing.
      expect(constructedWith).toEqual([windowsDir])
    })
  })

  describe('stage markers', () => {
    it('writes "started" to fd 2 before the native binding is touched', async () => {
      await runChild()

      expect(marks()).toEqual([`${PREFLIGHT_MARK_STARTED}\n`, `${PREFLIGHT_MARK_BINDING_LOADED}\n`])
      // The ordering is the whole point of the staging protocol: a child that
      // dies before `started` never ran, which is no verdict on the store.
      expect(mockWriteSync.mock.invocationCallOrder[0]).toBeLessThan(
        mockRequire.mock.invocationCallOrder[0]
      )
    })

    it('emits markers with writeSync on fd 2, not through the async stream', async () => {
      // A native abort microseconds later would eat a buffered stream write —
      // exactly when the parent needs the marker.
      await runChild()

      expect(mockWriteSync).toHaveBeenCalledTimes(2)
      for (const [fd] of mockWriteSync.mock.calls) expect(fd).toBe(2)
    })
  })

  describe('failure paths', () => {
    it('exits non-zero without the binding marker when the binding fails to load', async () => {
      mockRequire.mockImplementation(() => {
        throw new Error('ERR_DLOPEN_FAILED: classic-level binding')
      })

      const code = await runChild()

      expect(code).toBe(1)
      expect(marks()).toEqual([`${PREFLIGHT_MARK_STARTED}\n`])
      // No binding marker => the parent stages this 'binding' and leaves the
      // store alone; it was never opened.
      expect(marks().join('')).not.toContain(PREFLIGHT_MARK_BINDING_LOADED)
      expect(errorSpy).toHaveBeenCalled()
    })

    it('exits non-zero with the binding marker already out when the store probe fails', async () => {
      persistence.storeUpdate.mockRejectedValue(new Error('IO error: MANIFEST corrupt'))

      const code = await runChild()

      expect(code).toBe(1)
      // Both markers out => the parent stages this 'store', the only stage
      // worth quarantining for.
      expect(marks()).toEqual([`${PREFLIGHT_MARK_STARTED}\n`, `${PREFLIGHT_MARK_BINDING_LOADED}\n`])
      expect(errorSpy).toHaveBeenCalled()
    })

    it('exits non-zero when a read-back fails after a successful write', async () => {
      persistence.getYDoc.mockRejectedValue(new Error('IO error: torn LDB'))

      expect(await runChild()).toBe(1)
      expect(persistence.clearDocument).not.toHaveBeenCalled()
    })

    it('exits non-zero, without loading the binding, when no probe dir is passed', async () => {
      const code = await runChild(null)

      expect(code).toBe(1)
      expect(mockRequire).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('missing probe directory')
    })
  })

  describe('crash injection', () => {
    it('aborts before the binding loads when the test harness asks for it', async () => {
      process.env.NODE_ENV = 'test'
      process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH = '1'

      await runChild()

      expect(abortSpy).toHaveBeenCalled()
      // The real abort never returns; nothing past it may run.
      expect(mockRequire).not.toHaveBeenCalled()
      expect(marks()).toEqual([`${PREFLIGHT_MARK_STARTED}\n`])
    })

    it('is inert in a shipped build even if the flag leaks into the environment', async () => {
      process.env.NODE_ENV = 'production'
      process.env.MEMRY_TEST_CRDT_PREFLIGHT_CRASH = '1'

      const code = await runChild()

      expect(abortSpy).not.toHaveBeenCalled()
      expect(code).toBe(0)
    })

    it('is inert under the test harness without the flag', async () => {
      process.env.NODE_ENV = 'test'

      const code = await runChild()

      expect(abortSpy).not.toHaveBeenCalled()
      expect(code).toBe(0)
    })
  })
})
