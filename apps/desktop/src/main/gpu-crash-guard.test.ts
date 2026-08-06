import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GpuGuardMarker } from './gpu-crash-guard'

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    disableHardwareAcceleration: vi.fn(),
    getVersion: vi.fn(() => '2026.702.2'),
    getPath: vi.fn((name: string) => `/userdata/${name}`)
  }
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('node:fs', () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() }))
vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
// The real module pulls the telemetry runtime, whose electron import ('net')
// the mock above does not provide.
vi.mock('./telemetry/diagnostics', () => ({
  trackMainLog: vi.fn()
}))

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import {
  applyGpuCrashGuard,
  recordGpuCrash,
  shouldDisableHwAccel,
  shouldRecordGpuCrash
} from './gpu-crash-guard'

function marker(overrides: Partial<GpuGuardMarker> = {}): GpuGuardMarker {
  return { disabledForGpu: true, version: '2026.702.2', ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.app.isPackaged = true
})

describe('shouldDisableHwAccel', () => {
  it('disables when a crash was recorded for the current version', () => {
    expect(shouldDisableHwAccel(marker(), '2026.702.2')).toBe(true)
  })

  it('does not disable when there is no marker', () => {
    expect(shouldDisableHwAccel(null, '2026.702.2')).toBe(false)
  })

  it('does not disable when the marker is from an older version (retry on new build)', () => {
    expect(shouldDisableHwAccel(marker({ version: '2026.701.9' }), '2026.702.2')).toBe(false)
  })

  it('does not disable when the marker is not a disable directive', () => {
    expect(shouldDisableHwAccel(marker({ disabledForGpu: false }), '2026.702.2')).toBe(false)
  })
})

describe('shouldRecordGpuCrash', () => {
  it('records a GPU crash', () => {
    expect(shouldRecordGpuCrash({ type: 'GPU', reason: 'crashed' })).toBe(true)
  })

  it('records a GPU abnormal exit', () => {
    expect(shouldRecordGpuCrash({ type: 'GPU', reason: 'abnormal-exit' })).toBe(true)
  })

  it('records a GPU launch failure', () => {
    expect(shouldRecordGpuCrash({ type: 'GPU', reason: 'launch-failed' })).toBe(true)
  })

  it('ignores a GPU clean exit (normal shutdown)', () => {
    expect(shouldRecordGpuCrash({ type: 'GPU', reason: 'clean-exit' })).toBe(false)
  })

  it('ignores a GPU memory-eviction (OS memory-pressure kill, Electron 40+)', () => {
    expect(shouldRecordGpuCrash({ type: 'GPU', reason: 'memory-eviction' })).toBe(false)
  })

  it('ignores a non-GPU process crash', () => {
    expect(shouldRecordGpuCrash({ type: 'Utility', reason: 'crashed' })).toBe(false)
  })
})

describe('applyGpuCrashGuard', () => {
  it('is a no-op in development (unpackaged) and never reads a marker', () => {
    mocks.app.isPackaged = false
    applyGpuCrashGuard()
    expect(readFileSync).not.toHaveBeenCalled()
    expect(mocks.app.disableHardwareAcceleration).not.toHaveBeenCalled()
  })

  it('does nothing when there is no marker file', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    applyGpuCrashGuard()
    expect(mocks.app.disableHardwareAcceleration).not.toHaveBeenCalled()
    expect(rmSync).not.toHaveBeenCalled()
  })

  it('disables hardware acceleration when a crash was recorded for this version', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(marker()))
    applyGpuCrashGuard()
    expect(mocks.app.disableHardwareAcceleration).toHaveBeenCalledTimes(1)
    expect(rmSync).not.toHaveBeenCalled()
  })

  it('clears a stale marker from an older version and retries hardware acceleration', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(marker({ version: '2026.701.9' })))
    applyGpuCrashGuard()
    expect(mocks.app.disableHardwareAcceleration).not.toHaveBeenCalled()
    expect(rmSync).toHaveBeenCalledTimes(1)
  })
})

describe('recordGpuCrash', () => {
  it('is a no-op in development (unpackaged)', () => {
    mocks.app.isPackaged = false
    recordGpuCrash()
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it('writes a version-scoped disable marker', () => {
    recordGpuCrash()
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    const [, payload] = vi.mocked(writeFileSync).mock.calls[0]
    expect(JSON.parse(payload as string)).toEqual({ disabledForGpu: true, version: '2026.702.2' })
  })
})
