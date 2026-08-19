import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PREFLIGHT_MARK_BINDING_LOADED,
  PREFLIGHT_MARK_STARTED,
  PREFLIGHT_MARK_STORE_OPS
} from './crdt-preflight-protocol'

const mockFork = vi.hoisted(() => vi.fn())
const mockSpawn = vi.hoisted(() => vi.fn())

class MockChild extends EventEmitter {
  kill = vi.fn().mockReturnValue(true)
  stdout = null
  stderr = new EventEmitter()
  pid = 4321

  /** Emit a child stderr line, as the real child does for its stage markers. */
  say(line: string): void {
    this.stderr.emit('data', Buffer.from(`${line}\n`))
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/memry-preflight-test' },
  utilityProcess: {
    fork: (...args: unknown[]) => mockFork(...args)
  }
}))

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args)
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { runCrdtPreflight } from './crdt-preflight'

const STORE_DIR = '/tmp/memry-preflight-test/crdt-store'

describe('runCrdtPreflight', () => {
  let child: MockChild
  let nodeChild: MockChild

  beforeEach(() => {
    vi.clearAllMocks()
    child = new MockChild()
    nodeChild = new MockChild()
    mockFork.mockReturnValue(child)
    mockSpawn.mockReturnValue(nodeChild)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes when the child exits cleanly and probes the requested store dir', async () => {
    const pending = runCrdtPreflight(STORE_DIR)
    child.emit('exit', 0)

    await expect(pending).resolves.toEqual({ ok: true, transport: 'utility' })
    expect(mockFork).toHaveBeenCalledTimes(1)
    const [childPath, args] = mockFork.mock.calls[0] as [string, string[]]
    expect(childPath).toContain('crdt-preflight-child.js')
    expect(args[0]).toBe(STORE_DIR)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  /**
   * Drive the Chromium-free retry the parent now runs for store failures too.
   * The retry's verdict is the one that is returned, so it has to reproduce the
   * markers of the failure under test.
   */
  async function failNodeRetry(
    options: { code?: number; storeOps?: Array<keyof typeof PREFLIGHT_MARK_STORE_OPS> } = {}
  ): Promise<void> {
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())
    nodeChild.say(PREFLIGHT_MARK_STARTED)
    nodeChild.say(PREFLIGHT_MARK_BINDING_LOADED)
    for (const op of options.storeOps ?? []) nodeChild.say(PREFLIGHT_MARK_STORE_OPS[op])
    nodeChild.emit('exit', options.code ?? 134)
  }

  it('fails when the child dies with a non-zero code (native abort)', async () => {
    const pending = runCrdtPreflight(STORE_DIR)
    child.say(PREFLIGHT_MARK_STARTED)
    child.say(PREFLIGHT_MARK_BINDING_LOADED)
    child.emit('exit', 134)
    await failNodeRetry()

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('134')
  })

  it('kills the child and fails when it hangs past the timeout', async () => {
    vi.useFakeTimers()
    const pending = runCrdtPreflight(STORE_DIR)
    child.say(PREFLIGHT_MARK_STARTED)
    child.say(PREFLIGHT_MARK_BINDING_LOADED)

    await vi.advanceTimersByTimeAsync(11_000)
    expect(mockSpawn).toHaveBeenCalled()
    nodeChild.emit('exit', 134)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(child.kill).toHaveBeenCalled()
  })

  it('fails safely when neither child can even be forked', async () => {
    mockFork.mockImplementation(() => {
      throw new Error('utility fork failed')
    })
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn failed')
    })

    const result = await runCrdtPreflight(STORE_DIR)
    expect(result).toMatchObject({ ok: false, stage: 'bootstrap' })
    expect(result.reason).toContain('spawn failed')
  })

  it('forks a fresh child on every call so a quarantine retry re-probes', async () => {
    const first = runCrdtPreflight(STORE_DIR)
    child.say(PREFLIGHT_MARK_STARTED)
    child.say(PREFLIGHT_MARK_BINDING_LOADED)
    child.emit('exit', 134)
    await failNodeRetry()
    await first

    const second = runCrdtPreflight(STORE_DIR)
    child.emit('exit', 0)

    await expect(second).resolves.toEqual({ ok: true, transport: 'utility' })
    expect(mockFork).toHaveBeenCalledTimes(2)
  })

  // The child reports how far it got on stderr, because the exit code alone
  // cannot tell "the store aborted the binding" from "this machine cannot
  // start a utility process at all" (Windows 0xFFFF7003, crashpad init).
  describe('failure staging', () => {
    it('reports stage "store" when the binding loaded before the child died', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.say(PREFLIGHT_MARK_BINDING_LOADED)
      child.emit('exit', 134)
      await failNodeRetry()

      await expect(pending).resolves.toMatchObject({ ok: false, stage: 'store' })
    })

    // Production (issue #1583) could only ever say "somewhere in the store" —
    // opening, writing, reading back, clearing and closing all landed on the
    // same token, and each has a different cause.
    it('names the store operation that was in flight when the child died', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.say(PREFLIGHT_MARK_BINDING_LOADED)
      child.say(PREFLIGHT_MARK_STORE_OPS.open)
      child.say(PREFLIGHT_MARK_STORE_OPS.write)
      child.emit('exit', -1073741819)
      await failNodeRetry({ storeOps: ['open', 'write'] })

      // The LAST marker, not the first: each is written before its operation
      // runs, so the newest one names the operation that never came back.
      const result = await pending
      expect(result.stage).toBe('store')
      expect(result.storeOp).toBe('write')
    })

    it('leaves the store operation unset when the child died before announcing one', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.say(PREFLIGHT_MARK_BINDING_LOADED)
      child.emit('exit', -1073741819)
      await failNodeRetry()

      expect((await pending).storeOp).toBeUndefined()
    })

    it('reports stage "binding" when the child started but never loaded the binding', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.emit('exit', 1)

      await expect(pending).resolves.toMatchObject({ ok: false, stage: 'binding' })
      // A child that never opened the store is no verdict on the store, so
      // there is nothing for the plain-node retry to disambiguate.
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('renders the Windows exit code in hex so it is recognizable in logs', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.emit('exit', -36861)

      const result = await pending
      expect(result.reason).toContain('0xFFFF7003')
    })
  })

  // Production: on 9 Windows installs the utility child died in Chromium's
  // crashpad init (exit 0xFFFF7003) before any of our JS ran, so the store was
  // blamed and CRDT persistence stayed off for good. Retry the same probe with
  // no Chromium at all before giving up.
  describe('plain-node fallback when the utility child never starts', () => {
    it('retries under ELECTRON_RUN_AS_NODE and passes when that child survives', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.emit('exit', -36861)
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1))
      nodeChild.emit('exit', 0)

      // The transport is what the persistence layer reports: a verdict from
      // 'node' means the Chromium-free fallback was the one that decided.
      await expect(pending).resolves.toEqual({ ok: true, transport: 'node' })
      const [execPath, args, options] = mockSpawn.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string> }
      ]
      expect(execPath).toBe(process.execPath)
      expect(args[0]).toContain('crdt-preflight-child.js')
      expect(args[1]).toBe(STORE_DIR)
      expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    })

    it('keeps stage "bootstrap" when the fallback child cannot start either', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.emit('exit', -36861)
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1))
      nodeChild.emit('exit', -36861)

      // Stage bootstrap is what keeps the provider from quarantining a store
      // that was never even opened.
      await expect(pending).resolves.toMatchObject({ ok: false, stage: 'bootstrap' })
    })

    it("reports the fallback child's own stage when it does reach the store", async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.emit('exit', -36861)
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1))
      nodeChild.say(PREFLIGHT_MARK_STARTED)
      nodeChild.say(PREFLIGHT_MARK_BINDING_LOADED)
      nodeChild.emit('exit', 134)

      await expect(pending).resolves.toMatchObject({ ok: false, stage: 'store' })
    })
  })

  // On 2026.817.1 the utility child reached the store and access-violated there
  // on 19/19 win32 installs, and the fallback was gated on 'bootstrap' — so for
  // 7 of 8 installs it was dead code. Whether a Chromium-free child clears the
  // access violation is unknown and must be measured; that it now RUNS is the
  // part this pins.
  describe('plain-node fallback when the utility child dies inside the store', () => {
    it('retries a store-stage failure and takes the fallback verdict when it passes', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.say(PREFLIGHT_MARK_BINDING_LOADED)
      child.say(PREFLIGHT_MARK_STORE_OPS.open)
      child.emit('exit', -1073741819)

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1))
      expect((mockSpawn.mock.calls[0] as [string, string[]])[1][1]).toBe(STORE_DIR)
      nodeChild.emit('exit', 0)

      await expect(pending).resolves.toEqual({ ok: true, transport: 'node' })
    })

    it('reports the fallback transport when it access-violates too', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.say(PREFLIGHT_MARK_BINDING_LOADED)
      child.emit('exit', -1073741819)

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1))
      nodeChild.say(PREFLIGHT_MARK_STARTED)
      nodeChild.say(PREFLIGHT_MARK_BINDING_LOADED)
      nodeChild.say(PREFLIGHT_MARK_STORE_OPS.open)
      nodeChild.emit('exit', -1073741819)

      // 'node' is the field that says the binding is broken on this machine
      // rather than the utility process being unable to start.
      await expect(pending).resolves.toMatchObject({
        ok: false,
        stage: 'store',
        storeOp: 'open',
        transport: 'node'
      })
    })

    it('does not retry a binding-stage failure, which never opened the store', async () => {
      const pending = runCrdtPreflight(STORE_DIR)
      child.say(PREFLIGHT_MARK_STARTED)
      child.emit('exit', 1)

      await expect(pending).resolves.toMatchObject({ ok: false, stage: 'binding' })
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })
})
