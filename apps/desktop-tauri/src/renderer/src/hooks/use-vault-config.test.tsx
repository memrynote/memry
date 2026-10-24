import type React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { useVaultConfig } from './use-vault-config'
import { notesKeys } from './use-notes-query'

const config: VaultConfig = {
  excludePatterns: [],
  defaultNoteFolder: '',
  journalFolder: 'Daily',
  journalDateFormat: 'YYYY-MM-DD',
  attachmentsFolder: 'attachments'
}

function renderConfig() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, ...renderHook(() => useVaultConfig(), { wrapper }) }
}

describe('useVaultConfig', () => {
  it('takes a pushed config change and refetches the folder list with it', async () => {
    vi.mocked(window.api.vault.getConfig).mockResolvedValue(config)
    let push: (next: VaultConfig) => void = () => {}
    vi.mocked(window.api.onVaultConfigChanged).mockImplementation((callback) => {
      push = callback
      return () => {}
    })

    const { result, queryClient } = renderConfig()
    await waitFor(() => expect(result.current?.journalFolder).toBe('Daily'))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    act(() => push({ ...config, journalFolder: 'Diary', journalShowInSidebar: true }))

    await waitFor(() => expect(result.current?.journalFolder).toBe('Diary'))
    expect(invalidate).toHaveBeenCalledWith({ queryKey: notesKeys.folders() })
  })

  it('refetches only when the open vault changes, not on every status beat', async () => {
    vi.mocked(window.api.vault.getConfig).mockResolvedValue(config)
    let status: (next: { path: string | null }) => void = () => {}
    vi.mocked(window.api.onVaultStatusChanged).mockImplementation((callback) => {
      status = callback as typeof status
      return () => {}
    })

    renderConfig()
    await waitFor(() => expect(window.api.vault.getConfig).toHaveBeenCalledTimes(1))

    act(() => status({ path: '/vault/a' }))
    await waitFor(() => expect(window.api.vault.getConfig).toHaveBeenCalledTimes(2))
    act(() => status({ path: '/vault/a' }))
    act(() => status({ path: '/vault/a' }))
    expect(window.api.vault.getConfig).toHaveBeenCalledTimes(2)
  })
})
