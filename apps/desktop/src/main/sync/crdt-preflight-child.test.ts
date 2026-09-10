import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance
} from 'vitest'
import {
  PREFLIGHT_MARK_BINDING_LOADED,
  PREFLIGHT_MARK_STARTED,
  PREFLIGHT_MARK_STORE_OPS
} from '@memry/sync-client/crdt-preflight-protocol'

const mockWriteSync = vi.hoisted(() => vi.fn())
const mockRmSync = vi.hoisted(() => vi.fn())
const mockRmdirSync = vi.hoisted(() => vi.fn())
const mockUnlinkSync = vi.hoisted(() => vi.fn())
// `require` AND `require.resolve`: the child resolves the level adapter through
// y-leveldb's own resolution, so both halves of the createRequire result are used.
const mockRequire = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & { resolve: (id: string) => string }
  fn.resolve = () => '/fake/node_modules/y-leveldb/dist/y-leveldb.cjs'
  return fn
})

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
/** Directories the injected level adapter was actually constructed against. */
let levelConstructedWith: string[]
let levelOpen: Mock<() => Promise<void>>
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
    levelConstructedWith = []
    levelOpen = vi.fn(async () => undefined)
    mockWriteSync.mockReset().mockReturnValue(0)
    mockRequire.resolve = () => '/fake/node_modules/y-leveldb/dist/y-leveldb.cjs'
    mockRequire.mockReset().mockImplementation((id: string) => {
      // Stands in for `level`, whose only job here is to be constructed by
      // y-leveldb and opened by the child.
      if (id === 'level') {
        return {
          Level: class {
            constructor(dir: string) {
              levelConstructedWith.push(dir)
            }
            open = (): Promise<void> => levelOpen()
          }
        }
      }
      if (id !== 'y-leveldb') throw new Error(`unexpected require: ${id}`)
      return {
        LeveldbPersistence: class {
          constructor(dir: string, opts?: { Level?: new (dir: string, o: object) => unknown }) {
            constructedWith.push(dir)
            // Real y-leveldb constructs the adapter in its own constructor;
            // the child's diagnostic depends on that, so the fake does too.
            if (opts?.Level) new opts.Level(dir, {})
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

      expect(marks().slice(0, 2)).toEqual([
        `${PREFLIGHT_MARK_STARTED}\n`,
        `${PREFLIGHT_MARK_BINDING_LOADED}\n`
      ])
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

      expect(mockWriteSync.mock.calls.length).toBeGreaterThan(0)
      for (const [fd] of mockWriteSync.mock.calls) expect(fd).toBe(2)
    })

    // Production could only ever say "somewhere in the store": issue #1583 has
    // both stage markers out and five candidate operations behind them.
    it('announces every store operation, in order, before running it', async () => {
      await runChild()

      expect(marks()).toEqual([
        `${PREFLIGHT_MARK_STARTED}\n`,
        `${PREFLIGHT_MARK_BINDING_LOADED}\n`,
        `${PREFLIGHT_MARK_STORE_OPS.open}\n`,
        `${PREFLIGHT_MARK_STORE_OPS.write}\n`,
        `${PREFLIGHT_MARK_STORE_OPS.read}\n`,
        `${PREFLIGHT_MARK_STORE_OPS.clear}\n`,
        `${PREFLIGHT_MARK_STORE_OPS.close}\n`
      ])
    })

    it('stops at the operation that failed, so the last marker names the suspect', async () => {
      persistence.getYDoc.mockRejectedValue(new Error('IO error: torn LDB'))

      await runChild()

      // Read announced, clear never was: an abort unwinds nothing, so the only
      // attribution that survives is the one written before the call.
      expect(marks().at(-1)).toBe(`${PREFLIGHT_MARK_STORE_OPS.read}\n`)
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
      expect(marks().slice(0, 2)).toEqual([
        `${PREFLIGHT_MARK_STARTED}\n`,
        `${PREFLIGHT_MARK_BINDING_LOADED}\n`
      ])
      expect(errorSpy).toHaveBeenCalled()
    })

    it('exits non-zero when a read-back fails after a successful write', async () => {
      persistence.getYDoc.mockRejectedValue(new Error('IO error: torn LDB'))

      expect(await runChild()).toBe(1)
      expect(persistence.clearDocument).not.toHaveBeenCalled()
    })

    /**
     * The field failure this exists for (2026.909.1, Linux): every y-leveldb
     * call runs inside `_transact`, which catches, warns and resolves `null`,
     * so a store that could not be opened at all still walked past the write
     * and read markers and died on `TypeError: Cannot read properties of null
     * (reading 'destroy')`. The LevelDB error was never printed anywhere.
     */
    it('prints the LevelDB open error, root cause first, and stops at the open marker', async () => {
      levelOpen.mockRejectedValue(
        Object.assign(new Error('Database is not open'), {
          code: 'LEVEL_DATABASE_NOT_OPEN',
          cause: new Error(
            'IO error: lock /Users/ada/Library/Application Support/memry/crdt-store/LOCK: already held by process'
          )
        })
      )

      const code = await runChild()

      expect(code).toBe(1)
      expect(levelConstructedWith).toEqual([STORE_DIR])
      const openLine = marks().find((line) => line.includes('store open failed'))
      // The wrapper says only "Database is not open"; the cause is the line
      // that separates a held LOCK from a corrupt store, so it leads.
      expect(openLine).toContain('IO error: lock')
      expect(openLine).toContain('already held by process')
      expect(openLine).toContain('[LEVEL_DATABASE_NOT_OPEN] Database is not open')
      expect(openLine?.indexOf('IO error')).toBeLessThan(
        openLine?.indexOf('LEVEL_DATABASE_NOT_OPEN') ?? -1
      )
      // Nothing past the open was attempted — the store markers would otherwise
      // claim a write and a read that never really ran.
      expect(
        marks()
          .filter((line) => line.startsWith('@@'))
          .at(-1)
      ).toBe(`${PREFLIGHT_MARK_STORE_OPS.open}\n`)
      expect(persistence.storeUpdate).not.toHaveBeenCalled()
    })

    it('opens the store explicitly before the first y-leveldb call', async () => {
      await runChild()

      expect(levelOpen).toHaveBeenCalledTimes(1)
      expect(levelOpen.mock.invocationCallOrder[0]).toBeLessThan(
        persistence.storeUpdate.mock.invocationCallOrder[0]
      )
    })

    it('names the swallowed read instead of dereferencing null', async () => {
      persistence.getYDoc.mockResolvedValue(null)

      const code = await runChild()

      expect(code).toBe(1)
      const reported = errorSpy.mock.calls[0]?.[0]
      expect(reported).toBeInstanceOf(Error)
      expect(reported).not.toBeInstanceOf(TypeError)
      expect(String(reported)).toContain('store read returned null')
    })

    it('exits non-zero, without loading the binding, when no probe dir is passed', async () => {
      const code = await runChild(null)

      expect(code).toBe(1)
      expect(mockRequire).not.toHaveBeenCalled()
      expect(errorSpy.mock.calls[0]?.[0]).toBeInstanceOf(Error)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('missing probe directory')
    })
  })

  /**
   * The one test that loads the real y-leveldb and the real classic-level
   * binding. Everything above proves the child's wiring against fakes, which
   * cannot prove the two things that actually matter in the field: that
   * y-leveldb honours the injected `Level` adapter at all, and that a store
   * whose LOCK is held really does reject the explicit open with a message
   * naming the lock. Needs `pnpm --filter @memry/desktop rebuild:node`.
   */
  describe('against a real LevelDB store', () => {
    it('reports the held LOCK instead of dying on a null dereference', async () => {
      const { createRequire: realCreateRequire } =
        await vi.importActual<typeof import('module')>('module')
      const realRequire = realCreateRequire(import.meta.url)
      // Mirror the child's own two-step resolution: `level` comes from
      // y-leveldb's directory, not ours. It matters — the repo carries two
      // classic-level copies, and LevelDB's lock table lives inside a loaded
      // native binary, so a holder from the other copy would not conflict.
      const yLeveldbRequire = realCreateRequire(realRequire.resolve('y-leveldb'))
      mockRequire.resolve = (id: string) => realRequire.resolve(id)
      mockRequire.mockImplementation((id: string) =>
        id === 'level' ? yLeveldbRequire(id) : realRequire(id)
      )

      // Holding the LOCK here is what the previous app process does to the
      // next one when it never exits cleanly.
      const { Level } = yLeveldbRequire('level') as {
        Level: new (dir: string, opts: object) => { open(): Promise<void>; close(): Promise<void> }
      }
      const dir = await mkdtemp(join(tmpdir(), 'memry-preflight-lock-'))
      const holder = new Level(dir, {})
      await holder.open()

      try {
        expect(await runChild(dir)).toBe(1)

        const openLine = marks().find((line) => line.includes('store open failed'))
        expect(openLine).toBeDefined()
        expect(openLine).toContain('lock')
        expect(openLine).toContain('LOCK')
        // The masked failure: a TypeError from `loaded.destroy()` naming
        // neither the store nor the cause.
        expect(String(errorSpy.mock.calls[0]?.[0])).not.toContain('reading')
      } finally {
        await holder.close()
        await rm(dir, { recursive: true, force: true })
      }
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
