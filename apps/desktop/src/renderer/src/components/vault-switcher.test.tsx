import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import React from 'react'

const mocks = vi.hoisted(() => ({
  status: { path: '/vaults/Active' } as { path: string } | null,
  accountVaults: [
    { vaultUuid: 'uuid-cloud', name: 'Cloud', itemCount: 12, localPath: null, createdAt: null }
  ],
  switchVault: vi.fn(),
  selectVault: vi.fn(),
  openSettings: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/components/ui/picker', async () => {
  const PickerContext = React.createContext<(value: string) => void>(() => {})
  const OpenChangeContext = React.createContext<(open: boolean) => void>(() => {})
  function Picker({
    children,
    onValueChange,
    onOpenChange
  }: {
    children: ReactNode
    onValueChange: (value: string) => void
    onOpenChange: (open: boolean) => void
  }) {
    return (
      <OpenChangeContext.Provider value={onOpenChange}>
        <PickerContext.Provider value={onValueChange}>{children}</PickerContext.Provider>
      </OpenChangeContext.Provider>
    )
  }
  Picker.Trigger = ({ children }: { children: ReactNode }) => {
    const onOpenChange = React.useContext(OpenChangeContext)
    return (
      <div data-testid="picker-trigger" onClick={() => onOpenChange(true)}>
        {children}
      </div>
    )
  }
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
vi.mock('@/hooks/use-vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-vault')>()),
  useVault: () => ({
    status: mocks.status,
    isLoading: false,
    selectVault: mocks.selectVault,
    switchVault: mocks.switchVault
  })
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
  useSidebar: () => ({ isMobile: false, open: true, setOpen: vi.fn(), setOpenMobile: vi.fn() })
}))
vi.mock('@/components/download-vault-dialog', () => ({
  DownloadVaultDialog: () => null
}))

import { VaultSwitcher } from './vault-switcher'
import type { VaultInfo } from '../../../preload/index.d'

const vault = (name: string, extra: Partial<VaultInfo> = {}): VaultInfo => ({
  path: `/vaults/${name}`,
  name,
  noteCount: 0,
  taskCount: 0,
  lastOpened: '2026-09-01T00:00:00.000Z',
  isDefault: false,
  ...extra
})

const ACTIVE = vault('Active', { vaultUuid: 'uuid-active' })
const OLD = vault('Old', { vaultUuid: 'uuid-old' })

function serveVaults(...lists: VaultInfo[][]): void {
  const getAll = vi.mocked(window.api.vault.getAll)
  getAll.mockReset()
  for (const vaults of lists.slice(0, -1)) {
    getAll.mockResolvedValueOnce({ vaults, currentVault: ACTIVE.path })
  }
  getAll.mockResolvedValue({ vaults: lists[lists.length - 1], currentVault: ACTIVE.path })
}

describe('VaultSwitcher delete from account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serveVaults([ACTIVE, OLD])
  })

  it('offers delete on a local non-active vault', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(await screen.findByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))
    await waitFor(() => expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-old'))
  })

  it('drops a local vault from the list once it is deleted from the account', async () => {
    serveVaults([ACTIVE, OLD], [ACTIVE])
    render(<VaultSwitcher />)
    fireEvent.click(await screen.findByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))

    await waitFor(() => expect(screen.queryByText('Old')).not.toBeInTheDocument())
    expect(document.querySelector('[data-active-vault="true"]')).toHaveTextContent('Active')
  })

  it('reloads the list on open, so a vault removed elsewhere is gone', async () => {
    serveVaults([ACTIVE, OLD], [ACTIVE])
    render(<VaultSwitcher />)
    expect(await screen.findByText('Old')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('picker-trigger'))

    await waitFor(() => expect(screen.queryByText('Old')).not.toBeInTheDocument())
  })

  it('offers delete on a cloud-only vault', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(screen.getByLabelText('Delete Cloud from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))
    await waitFor(() =>
      expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-cloud')
    )
  })

  it('never offers delete on the active vault', async () => {
    render(<VaultSwitcher />)
    await screen.findByLabelText('Delete Old from account')
    expect(screen.queryByLabelText('Delete Active from account')).not.toBeInTheDocument()
  })

  it('keeps remove-from-list separate from delete', async () => {
    serveVaults([ACTIVE, OLD], [ACTIVE])
    render(<VaultSwitcher />)
    fireEvent.click(await screen.findByLabelText('Remove Old from list'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.remove2'))
    await waitFor(() => expect(screen.queryByText('Old')).not.toBeInTheDocument())
    expect(window.api.vault.remove).toHaveBeenCalledWith('/vaults/Old')
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })

  it('does not call the IPC when the confirm is cancelled', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(await screen.findByLabelText('Delete Old from account'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.cancel'))
    expect(window.api.vault.deleteFromAccount).not.toHaveBeenCalled()
  })
})

describe('VaultSwitcher missing vault folder', () => {
  const GONE = vault('Gone', { isMissing: true })

  beforeEach(() => {
    vi.clearAllMocks()
    serveVaults([ACTIVE, OLD, GONE])
  })

  it('marks a vault whose folder is missing and does not switch to it', async () => {
    render(<VaultSwitcher />)
    fireEvent.click(await screen.findByText('Gone'))

    expect(screen.getAllByText('phaseF.componentsVaultSwitcher.missing')).toHaveLength(1)
    expect(mocks.switchVault).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Old'))
    expect(mocks.switchVault).toHaveBeenCalledWith('/vaults/Old')
  })

  it('keeps a missing vault until the user forgets it', async () => {
    serveVaults([ACTIVE, OLD, GONE], [ACTIVE, OLD])
    render(<VaultSwitcher />)
    fireEvent.click(await screen.findByLabelText('Remove Gone from list'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.remove2'))

    await waitFor(() => expect(screen.queryByText('Gone')).not.toBeInTheDocument())
    expect(window.api.vault.remove).toHaveBeenCalledWith('/vaults/Gone')
  })

  it('forgets a missing vault from the keyboard', async () => {
    serveVaults([ACTIVE, OLD, GONE], [ACTIVE, OLD])
    render(<VaultSwitcher />)
    fireEvent.keyDown(await screen.findByLabelText('Remove Gone from list'), { key: 'Enter' })
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.remove2'))

    await waitFor(() => expect(screen.queryByText('Gone')).not.toBeInTheDocument())
    expect(mocks.switchVault).not.toHaveBeenCalled()
  })

  it('deletes a local vault from the account from the keyboard', async () => {
    render(<VaultSwitcher />)
    fireEvent.keyDown(await screen.findByLabelText('Delete Old from account'), { key: 'Enter' })
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.deleteVaultConfirm'))

    await waitFor(() => expect(window.api.vault.deleteFromAccount).toHaveBeenCalledWith('uuid-old'))
    expect(mocks.switchVault).not.toHaveBeenCalled()
  })
})
