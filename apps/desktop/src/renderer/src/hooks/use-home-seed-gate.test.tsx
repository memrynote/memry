import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useHomeSeedGate } from './use-home-seed-gate'

const ctx = vi.hoisted(() => ({
  authStatus: 'authenticated' as string,
  syncStatus: 'idle' as string,
  lastSyncAt: null as number | null
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: ctx.authStatus } })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({ state: { status: ctx.syncStatus, lastSyncAt: ctx.lastSyncAt } })
}))

beforeEach(() => {
  ctx.authStatus = 'authenticated'
  ctx.syncStatus = 'idle'
  ctx.lastSyncAt = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useHomeSeedGate', () => {
  it('allows seeding immediately when there is no account — nothing will ever arrive', () => {
    ctx.authStatus = 'unauthenticated'
    expect(renderHook(() => useHomeSeedGate()).result.current).toBe(true)
  })

  it('allows seeding immediately on the free plan, which never produces a lastSyncAt', () => {
    ctx.syncStatus = 'local_only'
    expect(renderHook(() => useHomeSeedGate()).result.current).toBe(true)
  })

  it('blocks seeding while authenticated with no completed pull', () => {
    // `status: 'idle'` is deliberately NOT a pass — main returns it when the
    // engine has not started, indistinguishable from "fully synced".
    expect(renderHook(() => useHomeSeedGate()).result.current).toBe(false)
  })

  it('allows seeding once a pull has completed', () => {
    ctx.lastSyncAt = 1_760_000_000_000
    expect(renderHook(() => useHomeSeedGate()).result.current).toBe(true)
  })

  it('opens the gate after the grace period so an unreachable server never leaves Home blank', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useHomeSeedGate())
    expect(result.current).toBe(false)

    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    expect(result.current).toBe(true)
  })
})
