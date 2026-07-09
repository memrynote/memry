import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFork = vi.hoisted(() => vi.fn())

class MockChild extends EventEmitter {
  kill = vi.fn().mockReturnValue(true)
  stdout = null
  stderr = new EventEmitter()
  pid = 4321
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/memry-preflight-test' },
  utilityProcess: {
    fork: (...args: unknown[]) => mockFork(...args)
  }
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { runCrdtPreflight, resetCrdtPreflightForTests } from './crdt-preflight'

describe('runCrdtPreflight', () => {
  let child: MockChild

  beforeEach(() => {
    vi.clearAllMocks()
    resetCrdtPreflightForTests()
    child = new MockChild()
    mockFork.mockReturnValue(child)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes when the child exits cleanly', async () => {
    const pending = runCrdtPreflight()
    child.emit('exit', 0)

    await expect(pending).resolves.toEqual({ ok: true })
    expect(mockFork).toHaveBeenCalledTimes(1)
    const [childPath, args] = mockFork.mock.calls[0] as [string, string[]]
    expect(childPath).toContain('crdt-preflight-child.js')
    expect(args[0]).toContain('crdt-store-preflight')
  })

  it('fails when the child dies with a non-zero code (native abort)', async () => {
    const pending = runCrdtPreflight()
    child.emit('exit', 134)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('134')
  })

  it('kills the child and fails when it hangs past the timeout', async () => {
    vi.useFakeTimers()
    const pending = runCrdtPreflight()

    await vi.advanceTimersByTimeAsync(11_000)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('timed out')
    expect(child.kill).toHaveBeenCalled()
  })

  it('fails safely when the child cannot even be forked', async () => {
    mockFork.mockImplementation(() => {
      throw new Error('spawn failed')
    })

    const result = await runCrdtPreflight()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('spawn failed')
  })

  it('runs the child once per process and caches the verdict', async () => {
    const first = runCrdtPreflight()
    child.emit('exit', 0)
    await first

    const second = await runCrdtPreflight()
    expect(second).toEqual({ ok: true })
    expect(mockFork).toHaveBeenCalledTimes(1)
  })
})
