import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMockApi } from '@tests/utils/render'
import { useVault, useVaultList } from './use-vault'
import { tabStateStorageKey } from '@/contexts/tabs/persistence'
import { VaultScopeProvider } from '@/contexts/vault-scope'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import {
  beginVaultSwitch,
  endVaultSwitch,
  getVaultSwitchState,
  holdVaultReveal,
  resetVaultSwitchState
} from '@/lib/vault-switch-state'
import type { ReactNode } from 'react'

function vaultApi() {
  return getMockApi() as {
    vault: {
      getStatus: ReturnType<typeof vi.fn>
      getConfig: ReturnType<typeof vi.fn>
      select: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      switch: ReturnType<typeof vi.fn>
      updateConfig: ReturnType<typeof vi.fn>
      reindex: ReturnType<typeof vi.fn>
      getAll: ReturnType<typeof vi.fn>
      remove: ReturnType<typeof vi.fn>
    }
    onVaultStatusChanged: ReturnType<typeof vi.fn>
    onVaultIndexProgress: ReturnType<typeof vi.fn>
    onVaultError: ReturnType<typeof vi.fn>
    onVaultIndexRecovered: ReturnType<typeof vi.fn>
  }
}

describe('useVault', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    const api = vaultApi()
    api.vault.getStatus.mockResolvedValue({
      isOpen: true,
      path: '/vault',
      isIndexing: false,
      indexProgress: 0,
      error: null
    })
    api.vault.getConfig.mockResolvedValue({ journalFolder: 'Journal' })
    api.vault.select.mockResolvedValue({ success: true, vault: { path: '/next' } })
    api.vault.close.mockResolvedValue(undefined)
    api.vault.switch.mockResolvedValue({ success: true, vault: { path: '/other' } })
    api.vault.updateConfig.mockResolvedValue({ journalFolder: 'Daily' })
    api.vault.reindex.mockResolvedValue(undefined)
    api.vault.getAll.mockResolvedValue({
      vaults: [{ path: '/vault', name: 'Vault' }],
      currentVault: '/vault'
    })
    api.vault.remove.mockResolvedValue(undefined)
    api.onVaultStatusChanged.mockReturnValue(() => {})
    api.onVaultIndexProgress.mockReturnValue(() => {})
    api.onVaultError.mockReturnValue(() => {})
    api.onVaultIndexRecovered.mockReturnValue(() => {})
  })

  it('loads initial status/config and responds to vault events', async () => {
    const api = vaultApi()
    let statusHandler: (status: {
      isOpen: boolean
      path: string
      error?: string
    }) => void = () => {}
    let errorHandler: (error: string) => void = () => {}
    api.onVaultStatusChanged.mockImplementation((handler) => {
      statusHandler = handler
      return () => {}
    })
    api.onVaultError.mockImplementation((handler) => {
      errorHandler = handler
      return () => {}
    })

    const { result } = renderHook(() => useVault())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isOpen).toBe(true)
    expect(result.current.vaultPath).toBe('/vault')
    expect(result.current.config).toEqual({ journalFolder: 'Journal' })

    act(() => statusHandler({ isOpen: false, path: '', error: 'closed' }))
    expect(result.current.isOpen).toBe(false)
    expect(result.current.error).toBe('closed')

    act(() => errorHandler('index failed'))
    expect(result.current.error).toBe('index failed')
  })

  it('selects, switches, closes, updates config, reindexes, and clears error state', async () => {
    const api = vaultApi()
    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.selectVault('/chosen')
    })
    expect(api.vault.select).toHaveBeenCalledWith('/chosen')
    expect(result.current.config).toEqual({ journalFolder: 'Journal' })

    api.vault.switch.mockResolvedValueOnce({
      success: false,
      vault: null,
      error: 'cannot switch'
    })
    await act(async () => {
      await result.current.switchVault('/missing')
    })
    expect(result.current.error).toBe('cannot switch')

    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()

    await act(async () => {
      await result.current.updateConfig({ journalFolder: 'Daily' })
    })
    expect(result.current.config).toEqual({ journalFolder: 'Daily' })

    await act(async () => {
      await result.current.reindex()
      await result.current.closeVault()
    })
    expect(api.vault.reindex).toHaveBeenCalled()
    expect(api.vault.close).toHaveBeenCalled()
    expect(result.current.config).toBeNull()
  })

  it('surfaces initial load and select errors as hook state', async () => {
    const api = vaultApi()
    api.vault.getStatus.mockRejectedValueOnce(new Error('status unavailable'))

    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.error).toBe('status unavailable')

    api.vault.select.mockRejectedValueOnce(new Error('select exploded'))
    await act(async () => {
      const response = await result.current.selectVault('/bad')
      expect(response).toEqual({ success: false, vault: null, error: 'select exploded' })
    })
    expect(result.current.error).toBe('select exploded')
  })

  it('stores and clears index recovery info after the timeout', async () => {
    vi.useFakeTimers()
    const api = vaultApi()
    let recoveredHandler: (event: { recovered: number }) => void = () => {}
    api.onVaultIndexRecovered.mockImplementation((handler) => {
      recoveredHandler = handler
      return () => {}
    })

    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    act(() => recoveredHandler({ recovered: 3 }))
    expect(result.current.recoveryInfo).toEqual({ recovered: 3 })

    act(() => result.current.clearRecoveryInfo())
    expect(result.current.recoveryInfo).toBeNull()

    act(() => recoveredHandler({ recovered: 5 }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(result.current.recoveryInfo).toBeNull()
  })
})

describe('useVault during a vault switch', () => {
  type Status = { isOpen: boolean; path: string | null }
  let statusHandler: (status: Status) => void = () => {}

  beforeEach(() => {
    vi.clearAllMocks()
    resetVaultSwitchState()
    const api = vaultApi()
    api.vault.getStatus.mockResolvedValue({ isOpen: true, path: '/a', error: null })
    api.vault.getConfig.mockResolvedValue({})
    api.onVaultStatusChanged.mockImplementation((handler) => {
      statusHandler = handler
      return () => {}
    })
    api.onVaultIndexProgress.mockReturnValue(() => {})
    api.onVaultError.mockReturnValue(() => {})
    api.onVaultIndexRecovered.mockReturnValue(() => {})
  })

  it('holds the closed gap back while the switch runs', async () => {
    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.vaultPath).toBe('/a'))

    act(() => beginVaultSwitch({ path: '/b', name: 'B' }, 'next'))
    act(() => statusHandler({ isOpen: false, path: null }))
    expect(result.current.vaultPath).toBe('/a')
    expect(result.current.isOpen).toBe(true)

    act(() => statusHandler({ isOpen: true, path: '/b' }))
    expect(result.current.vaultPath).toBe('/b')
    act(() => endVaultSwitch(true))
    expect(result.current.vaultPath).toBe('/b')
  })

  it('reveals the incoming vault only once the pager releases its hold', async () => {
    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.vaultPath).toBe('/a'))

    let release: () => void = () => {}
    act(() => {
      release = holdVaultReveal()
      beginVaultSwitch({ path: '/b', name: 'B' }, 'next')
    })
    act(() => statusHandler({ isOpen: false, path: null }))
    act(() => statusHandler({ isOpen: true, path: '/b' }))
    // A fast switch finished while the settle is still playing.
    expect(result.current.vaultPath).toBe('/a')

    act(() => release())
    expect(result.current.vaultPath).toBe('/b')
  })

  it('surfaces the closed state when the switch fails', async () => {
    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.vaultPath).toBe('/a'))

    act(() => beginVaultSwitch({ path: '/b', name: 'B' }, 'next'))
    act(() => statusHandler({ isOpen: false, path: null }))
    expect(result.current.isOpen).toBe(true)

    act(() => endVaultSwitch(false))
    expect(result.current.isOpen).toBe(false)
  })

  it('keeps a workspace on its own vault after the user leaves it', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VaultScopeProvider vaultPath="/a">{children}</VaultScopeProvider>
    )
    const { result } = renderHook(() => useVault(), { wrapper })
    await waitFor(() => expect(result.current.vaultPath).toBe('/a'))

    act(() => statusHandler({ isOpen: true, path: '/b' }))
    expect(result.current.vaultPath).toBe('/a')
  })

  it('draws the open vault on the first render of a workspace mounted mid-switch', async () => {
    // App's instance has already applied /b; the workspace for /b mounts next.
    const app = renderHook(() => useVault())
    await waitFor(() => expect(app.result.current.vaultPath).toBe('/a'))
    act(() => statusHandler({ isOpen: true, path: '/b' }))

    const firstRenders: Array<string | null> = []
    const wrapper = ({ children }: { children: ReactNode }) => (
      <VaultScopeProvider vaultPath="/b">{children}</VaultScopeProvider>
    )
    const { result } = renderHook(
      () => {
        const vault = useVault()
        firstRenders.push(vault.vaultPath)
        return vault
      },
      { wrapper }
    )

    expect(firstRenders[0]).toBe('/b')
    expect(result.current.isLoading).toBe(false)
  })

  it("does not seed a workspace with another vault's status", async () => {
    const app = renderHook(() => useVault())
    await waitFor(() => expect(app.result.current.vaultPath).toBe('/a'))

    const wrapper = ({ children }: { children: ReactNode }) => (
      <VaultScopeProvider vaultPath="/b">{children}</VaultScopeProvider>
    )
    const { result } = renderHook(() => useVault(), { wrapper })

    expect(result.current.vaultPath).toBeNull()
  })

  it('refuses a second switch while one is pending and leaves it untouched', async () => {
    const api = vaultApi()
    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.vaultPath).toBe('/a'))

    act(() => beginVaultSwitch({ path: '/b', name: 'B' }, 'next'))
    const before = getVaultSwitchState()
    let response: Awaited<ReturnType<typeof result.current.switchVault>> | undefined
    await act(async () => {
      response = await result.current.switchVault('/c')
    })

    expect(response).toEqual({ success: false, vault: null, error: expect.any(String) })
    expect(api.vault.switch).not.toHaveBeenCalled()
    expect(getVaultSwitchState()).toBe(before)
    expect(getVaultSwitchState().pending?.path).toBe('/b')
  })

  it('writes pending edits before main closes the vault', async () => {
    const api = vaultApi()
    const order: string[] = []
    registerPendingSave('note-1', () => {
      order.push('flush')
    })
    api.vault.switch.mockImplementation(async () => {
      order.push('switch')
      return { success: true, vault: { path: '/b' } }
    })

    const { result } = renderHook(() => useVault())
    await waitFor(() => expect(result.current.vaultPath).toBe('/a'))
    await act(async () => {
      await result.current.switchVault('/b')
    })

    unregisterPendingSave('note-1')
    expect(order).toEqual(['flush', 'switch'])
  })
})

describe('useVaultList', () => {
  it('seeds a later instance with the list an earlier one loaded', async () => {
    const first = renderHook(() => useVaultList())
    await waitFor(() => expect(first.result.current.isLoading).toBe(false))

    const { result } = renderHook(() => useVaultList())

    expect(result.current.isLoading).toBe(false)
    expect(result.current.vaults).toEqual([{ path: '/vault', name: 'Vault' }])
  })

  it('loads, refreshes, and removes known vaults', async () => {
    const api = vaultApi()
    const { result } = renderHook(() => useVaultList())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.vaults).toEqual([{ path: '/vault', name: 'Vault' }])
    expect(result.current.currentVault).toBe('/vault')

    api.vault.getAll.mockResolvedValueOnce({
      vaults: [{ path: '/other', name: 'Other' }],
      currentVault: '/other'
    })
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.vaults).toEqual([{ path: '/other', name: 'Other' }])

    // A removed vault's tabs go with it: nothing will ever read them again, and
    // they would sit on the origin's quota beside the vaults still in use.
    localStorage.setItem(tabStateStorageKey('/other'), '{}')
    localStorage.setItem(tabStateStorageKey('/vault'), '{}')

    await act(async () => {
      await result.current.removeVault('/other')
    })
    expect(api.vault.remove).toHaveBeenCalledWith('/other')
    expect(localStorage.getItem(tabStateStorageKey('/other'))).toBeNull()
    expect(localStorage.getItem(tabStateStorageKey('/vault'))).toBe('{}')
  })
})
