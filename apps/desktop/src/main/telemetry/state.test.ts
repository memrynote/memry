import { describe, expect, it, vi } from 'vitest'

const { storeGetMock, getSyncEngineMock } = vi.hoisted(() => ({
  storeGetMock: vi.fn(),
  getSyncEngineMock: vi.fn()
}))

vi.mock('../store', () => ({
  store: {
    get: storeGetMock
  }
}))

vi.mock('../sync/runtime', () => ({
  getSyncEngine: getSyncEngineMock
}))

import { getTelemetryAuthState, getTelemetrySyncState } from './state'

describe('telemetry state providers', () => {
  it('reports signed_in when the local sync store has an email', () => {
    storeGetMock.mockReturnValue({ email: 'user@example.com' })

    expect(getTelemetryAuthState()).toBe('signed_in')
  })

  it('reports anonymous when no local sync account is stored', () => {
    storeGetMock.mockReturnValue({})

    expect(getTelemetryAuthState()).toBe('anonymous')
  })

  it('reports enabled when a sync engine is active', () => {
    getSyncEngineMock.mockReturnValue({})

    expect(getTelemetrySyncState()).toBe('enabled')
  })

  it('reports disabled when no sync engine is active', () => {
    getSyncEngineMock.mockReturnValue(null)

    expect(getTelemetrySyncState()).toBe('disabled')
  })
})
