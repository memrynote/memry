import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// Global setup in tests/setup-dom.ts auto-mocks '@/lib/ipc/invoke' so the rest
// of the renderer test suite can keep mocking through window.api. This file
// exercises the real invoke wrapper end-to-end against a stubbed Tauri core,
// so we unmock both module ids the wrapper may be registered under and then
// install a fake @tauri-apps/api/core that holds an in-memory KV store.
vi.unmock('@/lib/ipc/invoke')
vi.unmock('@/hooks/useSettings')

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
            modifiedAt: '2026-04-25T00:00:00.000Z'
          }))
        default:
          throw new Error(`unmocked tauri invoke: ${cmd}`)
      }
    })
  }
})

import { useSetSetting, useSetting, useSettings } from '@/hooks/useSettings'

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe('useSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('round-trips a value through the invoke boundary', async () => {
    const wrapper = makeWrapper()
    const { result } = renderHook(
      () => {
        const setSetting = useSetSetting()
        const getSetting = useSetting('theme')
        return { setSetting, getSetting }
      },
      { wrapper }
    )

    result.current.setSetting.mutate({ key: 'theme', value: 'dark' })
    await waitFor(() => expect(result.current.setSetting.isSuccess).toBe(true))
    await waitFor(() => expect(result.current.getSetting.data).toBe('dark'))
  })

  it('reflects updates in the list query after mutation', async () => {
    const wrapper = makeWrapper()
    const { result } = renderHook(
      () => {
        const setSetting = useSetSetting()
        const list = useSettings()
        return { setSetting, list }
      },
      { wrapper }
    )

    result.current.setSetting.mutate({ key: 'fontFamily', value: 'inter' })
    await waitFor(() => expect(result.current.setSetting.isSuccess).toBe(true))
    await waitFor(() => {
      const items = result.current.list.data ?? []
      expect(items.some((s) => s.key === 'fontFamily' && s.value === 'inter')).toBe(true)
    })
  })

  it('returns null for an unset key', async () => {
    const wrapper = makeWrapper()
    const { result } = renderHook(() => useSetting('nonexistent'), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
  })
})
