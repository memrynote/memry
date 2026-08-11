import { spawnSync } from 'node:child_process'

import type { BinaryStatus } from '@memry/contracts/ipc-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the real implementations but watch spawnSync: a synchronous probe is the
// regression this module exists to prevent.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

import {
  BINARY_DETECTION_TTL_MS,
  cacheBinaryDetection,
  locateBinary,
  runBinaryCommand
} from '../binary-detection'

const usable: BinaryStatus = {
  detected: true,
  version: '2.1.138',
  meetsMinimum: true,
  minimumRequired: '2.1.0',
  installHint: null
}
const missing: BinaryStatus = {
  detected: false,
  version: null,
  meetsMinimum: false,
  minimumRequired: '2.1.0',
  installHint: 'install it'
}

describe('runBinaryCommand', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockClear()
  })

  it('returns stdout for a successful command', async () => {
    const result = await runBinaryCommand(process.execPath, ['-e', 'process.stdout.write("ok")'])

    expect(result?.stdout).toBe('ok')
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('returns null for a non-zero exit', async () => {
    await expect(runBinaryCommand(process.execPath, ['-e', 'process.exit(1)'])).resolves.toBeNull()
  })

  it('returns null when the command cannot be spawned', async () => {
    await expect(runBinaryCommand('memry-no-such-binary-xyz', [])).resolves.toBeNull()
  })

  it('keeps the event loop turning while the command runs', async () => {
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 10)

    const result = await runBinaryCommand(process.execPath, [
      '-e',
      'setTimeout(() => process.stdout.write("slow"), 200)'
    ])
    clearInterval(timer)

    expect(result?.stdout).toBe('slow')
    // spawnSync would have blocked the loop for the full 200ms and left ticks at 0.
    expect(ticks).toBeGreaterThan(0)
  })
})

describe('locateBinary', () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockClear()
  })

  it('resolves an executable that is on PATH without spawnSync', async () => {
    const resolved = await locateBinary(process.platform === 'win32' ? 'node.exe' : 'node')

    expect(resolved).toBeTruthy()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('returns null for an executable that is not installed', async () => {
    await expect(locateBinary('memry-no-such-binary-xyz')).resolves.toBeNull()
  })
})

describe('cacheBinaryDetection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses a usable detection instead of re-probing', async () => {
    const probe = vi.fn(async () => usable)
    const detect = cacheBinaryDetection(probe)

    await detect()
    await detect()

    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('shares one probe between concurrent callers', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(async () => {
      await gate
      return usable
    })
    const detect = cacheBinaryDetection(probe)

    const both = Promise.all([detect(), detect()])
    release()
    const [first, second] = await both

    expect(probe).toHaveBeenCalledTimes(1)
    expect(first).toEqual(usable)
    expect(second).toEqual(usable)
  })

  it('never caches a miss, so installing the CLI mid-session is picked up', async () => {
    const probe = vi.fn(async () => missing)
    const detect = cacheBinaryDetection(probe)

    await detect()
    await detect()

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never caches a binary that is below the minimum version', async () => {
    const probe = vi.fn(async () => ({ ...usable, version: '1.5.0', meetsMinimum: false }))
    const detect = cacheBinaryDetection(probe)

    await detect()
    await detect()

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('re-probes once the cached detection expires', async () => {
    vi.useFakeTimers()
    const probe = vi.fn(async () => usable)
    const detect = cacheBinaryDetection(probe)

    await detect()
    vi.setSystemTime(Date.now() + BINARY_DETECTION_TTL_MS + 1)
    await detect()

    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not latch a rejected probe', async () => {
    const probe = vi.fn(async () => {
      throw new Error('probe blew up')
    })
    const detect = cacheBinaryDetection(probe)

    await expect(detect()).rejects.toThrow('probe blew up')
    await expect(detect()).rejects.toThrow('probe blew up')

    expect(probe).toHaveBeenCalledTimes(2)
  })
})
