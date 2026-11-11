import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const getHealth = vi.hoisted(() => vi.fn())
const fired = vi.hoisted(() => ({ ready: () => {}, reset: () => {} }))
const readyEvent = vi.hoisted(() => ({ name: 'ready' }))
const resetEvent = vi.hoisted(() => ({ name: 'reset' }))

vi.mock('../../../generated/bindings', () => ({
  commands: { crdtGetHealth: getHealth },
  events: { crdtProviderReadyEvent: readyEvent, crdtProviderResetEvent: resetEvent }
}))

vi.mock('@/services/tauri-event', () => ({
  subscribeToEvent: (event: unknown, callback: () => void, onListening?: () => void) => {
    if (event === readyEvent) fired.ready = callback
    if (event === resetEvent) fired.reset = callback
    onListening?.()
    return () => {}
  }
}))

import { useDatabaseReadOnly } from './use-database-read-only'

const health = (persistent: boolean) => ({ persistent, inMemorySessions: persistent ? 0 : 1 })

/** A health ask the test answers when it chooses. */
function deferredHealth(): { answer: (persistent: boolean) => Promise<void> } {
  let resolve: (value: ReturnType<typeof health>) => void = () => {}
  getHealth.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
  return {
    answer: async (persistent) => {
      await act(async () => resolve(health(persistent)))
    }
  }
}

describe('useDatabaseReadOnly', () => {
  // The vault's open can finish after the page mounts: the answer at mount is the host's
  // default, and the editor's ready event brings the real one.
  it('turns read-only when a later ask finds the database read-only', async () => {
    getHealth.mockResolvedValueOnce(health(true))
    const { result } = renderHook(() => useDatabaseReadOnly())
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(1))
    expect(result.current).toBe(false)

    getHealth.mockResolvedValueOnce(health(false))
    act(() => fired.ready())

    await waitFor(() => expect(result.current).toBe(true))
  })

  // #4271: the mount's ask about the old vault answers after the ready event's ask about the
  // newly opened one.
  it('drops an answer that arrives after a newer one', async () => {
    getHealth.mockReset()
    const atMount = deferredHealth()
    const { result } = renderHook(() => useDatabaseReadOnly())
    const afterReady = deferredHealth()
    act(() => fired.ready())

    await afterReady.answer(true)
    await atMount.answer(false)

    expect(result.current).toBe(false)
  })

  // #4271: the vault closed, so its answer says nothing about the next one, and an ask in flight
  // when it closed answers about the closed vault.
  it('forgets the answer when the vault closes', async () => {
    getHealth.mockReset()
    getHealth.mockResolvedValueOnce(health(false))
    const { result } = renderHook(() => useDatabaseReadOnly())
    await waitFor(() => expect(result.current).toBe(true))

    const inFlight = deferredHealth()
    act(() => fired.ready())
    act(() => fired.reset())
    expect(result.current).toBe(false)

    await inFlight.answer(false)
    expect(result.current).toBe(false)
  })
})
