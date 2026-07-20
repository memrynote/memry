import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'

const mocks = vi.hoisted(() => ({
  status: { path: '/vaults/Active' } as { path: string } | null,
  vaults: [
    { path: '/vaults/Active', name: 'Active', vaultUuid: 'uuid-active' },
    { path: '/vaults/Old', name: 'Old', vaultUuid: 'uuid-old' }
  ],
  accountVaults: [
    { vaultUuid: 'uuid-cloud', name: 'Cloud', itemCount: 12, localPath: null, createdAt: null }
  ],
  removeVault: vi.fn().mockResolvedValue(undefined),
  switchVault: vi.fn(),
  selectVault: vi.fn(),
  openSettings: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/components/ui/picker', async () => {
  const PickerContext = React.createContext<(value: string) => void>(() => {})
  function Picker({
    children,
    onValueChange
  }: {
    children: ReactNode
    onValueChange: (value: string) => void
  }) {
    return <PickerContext.Provider value={onValueChange}>{children}</PickerContext.Provider>
  }
  Picker.Trigger = ({ children }: { children: ReactNode }) => <>{children}</>
  Picker.Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.List = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.Separator = () => <hr />
  Picker.Empty = ({ message }: { message: string }) => <div>{message}</div>
  Picker.Item = ({ value, label }: { value: string; label: string }) => {
    const onValueChange = React.useContext(PickerContext)
    return (
      <button type="button" onClick={() => onValueChange(value)}>
        {label}
      </button>
    )
  }
  return { Picker }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars?.name ? `${key}:${vars.name}` : key)
  })
}))
vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    status: mocks.status,
    isLoading: false,
    selectVault: mocks.selectVault,
    switchVault: mocks.switchVault
  }),
  useVaultList: () => ({ vaults: mocks.vaults, removeVault: mocks.removeVault })
}))
vi.mock('@/hooks/use-account-vaults', () => ({
  useAccountVaults: () => ({ accountVaults: mocks.accountVaults, refresh: mocks.refresh })
}))
vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettings })
}))
vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: { status: 'authenticated', email: 'k@example.com' } })
}))
vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  useSidebar: () => ({ isMobile: false })
}))
vi.mock('@/components/download-vault-dialog', () => ({
  DownloadVaultDialog: () => null
}))

import { VaultSwitcher } from './vault-switcher'

describe('VaultSwitcher delete from account', () => {
  beforeEach(() => vi.clearAllMocks())

  it('offers delete on a local non-active vault', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))
    await waitFor(() => expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-old'))
  })

  it('offers delete on a cloud-only vault', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Delete Cloud from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))
    await waitFor(() =>
      expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-cloud')
    )
  })

  it('never offers delete on the active vault', () => {
    render(<VaultSwitcher />)
    expect(screen.queryByLabelText('Delete Active from account')).not.toBeInTheDocument()
  })

  it('keeps remove-from-list separate from delete', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Remove Old from list'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.remove2'))
    await waitFor(() => expect(mocks.removeVault).toHaveBeenCalledWith('/vaults/Old'))
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })

  it('does not call the IPC when the confirm is cancelled', () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.cancel'))
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })
})
