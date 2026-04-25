import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

// The global setup in tests/setup-dom.ts auto-mocks '@/lib/ipc/invoke' so most
// hook tests can keep mocking through window.api. Phase F's regression test
// for the onboarding persistence path needs the *real* invoke wrapper so we
// can prove the fix actually routes through settings_get / settings_set
// against a stubbed Tauri core.
vi.unmock('@/lib/ipc/invoke')

vi.mock('@tauri-apps/api/core', () => {
  const store = new Map<string, string>()

  function readKey(args: unknown): string {
    const payload = (args as { input?: { key?: string } } | undefined)?.input
    return payload?.key ?? ''
  }

  function readValue(args: unknown): string {
    const payload = (args as { input?: { value?: string } } | undefined)?.input
    return payload?.value ?? ''
  }

  return {
    invoke: vi.fn(async (cmd: string, args: unknown) => {
      switch (cmd) {
        case 'settings_set':
          store.set(readKey(args), readValue(args))
          return undefined
        case 'settings_get':
          return store.get(readKey(args)) ?? null
        case 'settings_list':
          return Array.from(store.entries()).map(([key, value]) => ({
            key,
            value,
            modifiedAt: '2026-04-26T00:00:00.000Z'
          }))
        default:
          throw new Error(`unmocked tauri invoke: ${cmd}`)
      }
    }),
    __resetStore: () => {
      store.clear()
    }
  }
})

import * as TauriCore from '@tauri-apps/api/core'
import { useGeneralSettings } from './use-general-settings'

const tauriCoreMock = TauriCore as unknown as { __resetStore?: () => void }
const tauriInvokeFn = TauriCore.invoke as unknown as {
  mock: { calls: [string, unknown][] }
}

function calledCommands(): string[] {
  return tauriInvokeFn.mock.calls.map(([cmd]) => cmd)
}

describe('useGeneralSettings (Phase F regression)', () => {
  beforeEach(() => {
    tauriCoreMock.__resetStore?.()
    vi.clearAllMocks()
  })

  it('routes load+save through the real settings_get/settings_set commands', async () => {
    const { result } = renderHook(() => useGeneralSettings())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.updateSettings({ onboardingCompleted: true })
    })

    expect(calledCommands()).toContain('settings_get')
    expect(calledCommands()).toContain('settings_set')
    // No legacy domain-specific commands should be invoked through real Tauri.
    expect(calledCommands()).not.toContain('settings_get_general_settings')
    expect(calledCommands()).not.toContain('settings_set_general_settings')
  })

  it('persists onboardingCompleted through the real settings_get/set path', async () => {
    const first = renderHook(() => useGeneralSettings())
    await waitFor(() => expect(first.result.current.isLoading).toBe(false))
    expect(first.result.current.settings.onboardingCompleted).toBe(false)

    await act(async () => {
      const ok = await first.result.current.updateSettings({ onboardingCompleted: true })
      expect(ok).toBe(true)
    })
    expect(first.result.current.settings.onboardingCompleted).toBe(true)

    first.unmount()

    const second = renderHook(() => useGeneralSettings())
    await waitFor(() => expect(second.result.current.isLoading).toBe(false))
    expect(second.result.current.settings.onboardingCompleted).toBe(true)
  })

  it('round-trips a partial appearance update without losing prior fields', async () => {
    const first = renderHook(() => useGeneralSettings())
    await waitFor(() => expect(first.result.current.isLoading).toBe(false))

    await act(async () => {
      const ok = await first.result.current.updateSettings({ accentColor: '#abcdef' })
      expect(ok).toBe(true)
    })
    await act(async () => {
      const ok = await first.result.current.updateSettings({ fontFamily: 'inter' })
      expect(ok).toBe(true)
    })

    first.unmount()

    const second = renderHook(() => useGeneralSettings())
    await waitFor(() => expect(second.result.current.isLoading).toBe(false))
    expect(second.result.current.settings.accentColor).toBe('#abcdef')
    expect(second.result.current.settings.fontFamily).toBe('inter')
    expect(second.result.current.settings.theme).toBe('system')
  })
})
