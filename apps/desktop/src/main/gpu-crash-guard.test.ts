import { describe, expect, it, vi } from 'vitest'
import type { GpuGuardMarker } from './gpu-crash-guard'

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '2026.702.2'),
    getPath: vi.fn((name: string) => `/userdata/${name}`)
  }
}))

vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('node:fs', () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() }))
vi.mock('./lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { shouldDisableHwAccel } from './gpu-crash-guard'

function marker(overrides: Partial<GpuGuardMarker> = {}): GpuGuardMarker {
  return { disabledForGpu: true, version: '2026.702.2', ...overrides }
}

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
