import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMockApi } from '@tests/utils/render'
import { useVault, useVaultList } from './use-vault'
import { tabStateStorageKey } from '@/contexts/tabs/persistence'

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

describe('useVaultList', () => {
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
