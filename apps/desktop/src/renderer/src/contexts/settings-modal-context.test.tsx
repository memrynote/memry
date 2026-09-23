import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

import { SettingsModalProvider, useSettingsModal } from './settings-modal-context'

function wrapper({ children }: { children: ReactNode }) {
  return <SettingsModalProvider>{children}</SettingsModalProvider>
}

describe('settings modal targets', () => {
  it('opens Vault focused on the activity log for vault:activity', () => {
    const { result } = renderHook(() => useSettingsModal(), { wrapper })

    act(() => result.current.open('vault:activity'))

    expect(result.current.isOpen).toBe(true)
    expect(result.current.activeSection).toBe('vault')
    expect(result.current.focusTarget).toBe('vault-activity')
    const firstRequest = result.current.focusRequestId

    act(() => result.current.open('vault:activity'))
    expect(result.current.focusRequestId).toBeGreaterThan(firstRequest)
  })

  it('opens a plain section with no focus target', () => {
    const { result } = renderHook(() => useSettingsModal(), { wrapper })

    act(() => result.current.open('vault'))

    expect(result.current.activeSection).toBe('vault')
    expect(result.current.focusTarget).toBeNull()
  })
})
