import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listener: undefined as ((event: { payload: { requestId: string } }) => void) | undefined,
  flushAllPendingSaves: vi.fn(),
  hasPendingSaves: vi.fn(),
  flushDone: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({
  commands: { flushDone: mocks.flushDone },
  events: {
    flushRequestedEvent: {
      listen: vi.fn((handler: (event: { payload: { requestId: string } }) => void) => {
        mocks.listener = handler
        return Promise.resolve(vi.fn())
      })
    }
  }
}))
vi.mock('@/lib/save-registry', () => ({
  flushAllPendingSaves: mocks.flushAllPendingSaves,
  hasPendingSaves: mocks.hasPendingSaves
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { useFlushOnQuit } from './use-flush-on-quit'

const flushed = async (): Promise<void> => {
  await vi.waitFor(() => expect(mocks.flushDone).toHaveBeenCalled())
}

describe('useFlushOnQuit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listener = undefined
    mocks.flushAllPendingSaves.mockResolvedValue(undefined)
    mocks.flushDone.mockResolvedValue(null)
    mocks.hasPendingSaves.mockReturnValue(false)
  })

  it('flushes pending saves and answers with the request id main issued', async () => {
    renderHook(() => useFlushOnQuit())
    await vi.waitFor(() => expect(mocks.listener).toBeDefined())
    mocks.listener?.({ payload: { requestId: 'flush-1' } })
    await flushed()
    expect(mocks.flushAllPendingSaves).toHaveBeenCalledTimes(1)
    expect(mocks.flushDone).toHaveBeenCalledWith('flush-1')
  })

  it('answers even when the flush fails, so main does not wait out its timeout', async () => {
    mocks.flushAllPendingSaves.mockRejectedValue(new Error('disk full'))
    renderHook(() => useFlushOnQuit())
    await vi.waitFor(() => expect(mocks.listener).toBeDefined())
    mocks.listener?.({ payload: { requestId: 'flush-2' } })
    await flushed()
    expect(mocks.flushDone).toHaveBeenCalledWith('flush-2')
  })

  it('flushes on beforeunload only when saves are pending', () => {
    const { unmount } = renderHook(() => useFlushOnQuit())
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.flushAllPendingSaves).not.toHaveBeenCalled()
    mocks.hasPendingSaves.mockReturnValue(true)
    window.dispatchEvent(new Event('beforeunload'))
    expect(mocks.flushAllPendingSaves).toHaveBeenCalledTimes(1)
    unmount()
  })
})
