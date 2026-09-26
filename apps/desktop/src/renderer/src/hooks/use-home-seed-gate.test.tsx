import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useHomeSeedGate } from './use-home-seed-gate'

const ctx = vi.hoisted(() => ({
  authStatus: 'authenticated' as string,
  syncStatus: 'idle' as string,
  lastSyncAt: null as number | null,
  initialSyncProgress: null as { phase: string; current: number; total: number } | null
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: ctx.authStatus } })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({
    state: {
      status: ctx.syncStatus,
      lastSyncAt: ctx.lastSyncAt,
      initialSyncProgress: ctx.initialSyncProgress
    }
  })
}))

beforeEach(() => {
  ctx.authStatus = 'authenticated'
  ctx.syncStatus = 'idle'
  ctx.lastSyncAt = null
  ctx.initialSyncProgress = null
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

  // A fresh device's first pull can run past the grace period: on staging it
  // applied 43 packs before the page carrying the account's boards.
  it('keeps the gate closed past the grace period while the first sync is still transferring', () => {
    vi.useFakeTimers()
    ctx.initialSyncProgress = { phase: 'packs', current: 12, total: 43 }
    const { result, rerender } = renderHook(() => useHomeSeedGate())

    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(result.current).toBe(false)

    ctx.initialSyncProgress = { phase: 'notes', current: 200, total: 400 }
    ctx.syncStatus = 'syncing'
    rerender()
    expect(result.current).toBe(false)

    ctx.initialSyncProgress = null
    ctx.syncStatus = 'offline'
    rerender()
    expect(result.current).toBe(true)
  })

  it('does not read an unresolved auth check as "no account"', () => {
    ctx.authStatus = 'checking'
    const { result, rerender } = renderHook(() => useHomeSeedGate())
    expect(result.current).toBe(false)

    ctx.authStatus = 'idle'
    rerender()
    expect(result.current).toBe(false)

    ctx.authStatus = 'unauthenticated'
    rerender()
    expect(result.current).toBe(true)
  })
})
