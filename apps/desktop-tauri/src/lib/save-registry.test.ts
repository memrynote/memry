import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  registerPendingSave,
  unregisterPendingSave,
  flushAllPendingSaves,
  hasPendingSaves
} from './save-registry'

describe('save-registry', () => {
  beforeEach(() => {
    unregisterPendingSave('a')
    unregisterPendingSave('b')
    unregisterPendingSave('c')
  })

  it('starts with no pending saves', () => {
    expect(hasPendingSaves()).toBe(false)
  })

  it('registers and detects pending saves', () => {
    registerPendingSave('a', vi.fn())
    expect(hasPendingSaves()).toBe(true)
  })

  it('unregisters pending saves', () => {
    registerPendingSave('a', vi.fn())
    unregisterPendingSave('a')
    expect(hasPendingSaves()).toBe(false)
  })

  it('flushAll calls all registered flush fns', async () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    registerPendingSave('a', fn1)
    registerPendingSave('b', fn2)

    await flushAllPendingSaves()

    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).toHaveBeenCalledOnce()
  })

  it('flushAll resolves even if a flush fn throws', async () => {
    const fn1 = vi.fn().mockRejectedValue(new Error('disk full'))
    const fn2 = vi.fn()
    registerPendingSave('a', fn1)
    registerPendingSave('b', fn2)

    await flushAllPendingSaves()

    expect(fn1).toHaveBeenCalledOnce()
    expect(fn2).toHaveBeenCalledOnce()
  })

  it('flushAll is a no-op when nothing is registered', async () => {
    await expect(flushAllPendingSaves()).resolves.toBeUndefined()
  })

  it('later registration with same key overwrites previous', async () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    registerPendingSave('a', fn1)
    registerPendingSave('a', fn2)

    await flushAllPendingSaves()

    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).toHaveBeenCalledOnce()
  })
})
