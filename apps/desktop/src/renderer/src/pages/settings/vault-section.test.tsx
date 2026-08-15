import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  accountVaults: [
    {
      vaultUuid: 'uuid-active',
      name: 'Active',
      itemCount: 3,
      localPath: '/vaults/Active',
      createdAt: null
    },
    { vaultUuid: 'uuid-old', name: 'Old', itemCount: 9, localPath: null, createdAt: null }
  ],
  refresh: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars?.name ? `${key}:${vars.name}` : key)
  })
}))
vi.mock('@/hooks/use-storage-usage', () => ({
  useStorageUsage: () => ({ data: null, loading: false, refresh: vi.fn() })
}))
vi.mock('@/hooks/use-account-vaults', () => ({
  useAccountVaults: () => ({ accountVaults: mocks.accountVaults, refresh: mocks.refresh })
}))

import { VaultSettings } from './vault-section'

describe('VaultSettings account vaults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api.vault.getStatus = vi.fn().mockResolvedValue({ path: '/vaults/Active' })
    const api = window.api as typeof window.api & {
      syncOps?: { getLargeNotes?: ReturnType<typeof vi.fn> }
    }
    api.syncOps = api.syncOps ?? {}
    api.syncOps.getLargeNotes = vi.fn().mockResolvedValue({ maxBytes: 3_826_189, notes: [] })
  })

  it('lists every vault in the account', async () => {
    render(<VaultSettings />)
    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Old')).toBeInTheDocument()
  })

  it('deletes a non-active vault after confirmation', async () => {
    render(<VaultSettings />)
    fireEvent.click(await screen.findByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('vault.accountVaults.deleteConfirm'))
    await waitFor(() => expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-old'))
  })

  it('disables delete for the active vault', async () => {
    render(<VaultSettings />)
    await screen.findByText('Active')
    expect(screen.getByLabelText('Delete Active from account')).toBeDisabled()
  })

  it('does not delete when cancelled', async () => {
    render(<VaultSettings />)
    fireEvent.click(await screen.findByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('button.cancel'))
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })

  it('loads the account vault list on mount', async () => {
    render(<VaultSettings />)
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled())
  })
})
