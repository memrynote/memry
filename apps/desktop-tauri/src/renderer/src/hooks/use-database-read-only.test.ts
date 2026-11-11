import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

const getHealth = vi.hoisted(() => vi.fn())
const ready = vi.hoisted(() => ({ fire: () => {} }))

vi.mock('../../../generated/bindings', () => ({
  commands: { crdtGetHealth: getHealth },
  events: { crdtProviderReadyEvent: {} }
}))

vi.mock('@/services/tauri-event', () => ({
  subscribeToEvent: (_event: unknown, callback: () => void, onListening?: () => void) => {
    ready.fire = callback
    onListening?.()
    return () => {}
  }
}))

import { useDatabaseReadOnly } from './use-database-read-only'

describe('useDatabaseReadOnly', () => {
  // The vault's open can finish after the page mounts: the answer at mount is the host's
  // default, and the editor's ready event brings the real one.
  it('turns read-only when a later ask finds the database read-only', async () => {
    getHealth.mockResolvedValueOnce({ persistent: true, inMemorySessions: 0 })
    const { result } = renderHook(() => useDatabaseReadOnly())
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(1))
    expect(result.current).toBe(false)

    getHealth.mockResolvedValueOnce({ persistent: false, inMemorySessions: 1 })
    act(() => ready.fire())

    await waitFor(() => expect(result.current).toBe(true))
  })
})
