/**
 * Vault switcher — opening from the ⌘⇧O shortcut.
 *
 * The shortcut drives the sidebar's own picker, so these tests cover the wiring
 * around it: opening, expanding a collapsed sidebar, Escape closing without a
 * vault change, and handing focus back where it came from.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import React from 'react'

const mocks = vi.hoisted(() => ({
  switchVault: vi.fn(),
  selectVault: vi.fn(),
  removeVault: vi.fn().mockResolvedValue(undefined),
  openSettings: vi.fn(),
  refresh: vi.fn(),
  setSidebarOpen: vi.fn(),
  setOpenMobile: vi.fn(),
  sidebarOpen: true,
  isMobile: false
}))

/**
 * Radix's popover, reduced to the behaviour under test: it renders its content
 * only while open, and Escape asks the owner to close.
 */
vi.mock('@/components/ui/picker', async () => {
  const PickerContext = React.createContext<(value: string) => void>(() => {})
  const OpenContext = React.createContext<{ open: boolean; onOpenChange: (o: boolean) => void }>({
    open: false,
    onOpenChange: () => {}
  })
  function Picker({
    children,
    onValueChange,
    open,
    onOpenChange
  }: {
    children: ReactNode
    onValueChange: (value: string) => void
    open: boolean
    onOpenChange: (open: boolean) => void
  }) {
    return (
      <OpenContext.Provider value={{ open, onOpenChange }}>
        <PickerContext.Provider value={onValueChange}>{children}</PickerContext.Provider>
      </OpenContext.Provider>
    )
  }
  Picker.Trigger = ({ children }: { children: ReactNode }) => <>{children}</>
  /**
   * Radix dispatches a cancelable event on the content container before it
   * auto-focuses, which is the seam the component uses to open on the active
   * vault instead of the first row. Reproduce exactly that: dispatch once on
   * open, and honour `preventDefault`.
   */
  Picker.Content = ({
    children,
    onOpenAutoFocus
  }: {
    children: ReactNode
    onOpenAutoFocus?: (event: Event) => void
  }) => {
    const { open, onOpenChange } = React.useContext(OpenContext)
    const ref = React.useRef<HTMLDivElement>(null)

    React.useEffect(() => {
      const content = ref.current
      if (!open || !content || !onOpenAutoFocus) return
      const listener = onOpenAutoFocus as EventListener
      content.addEventListener('autoFocusOnMount', listener)
      content.dispatchEvent(new CustomEvent('autoFocusOnMount', { cancelable: true }))
      content.removeEventListener('autoFocusOnMount', listener)
    }, [open, onOpenAutoFocus])

    if (!open) return null
    return (
      <div
        ref={ref}
        data-testid="vault-picker"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onOpenChange(false)
        }}
      >
        {children}
      </div>
    )
  }
  Picker.List = ({ children }: { children: ReactNode }) => (
    <div data-slot="picker-list">{children}</div>
  )
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
  // Same string the real module exports; the component uses it to pick rows.
  return { Picker, PICKER_ROW_SELECTOR: '[data-slot="picker-list"] button:not([disabled])' }
})

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars?.name ? `${key}:${vars.name}` : key)
  })
}))
vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    status: { path: '/vaults/Active' },
    isLoading: false,
    selectVault: mocks.selectVault,
    switchVault: mocks.switchVault
  }),
  useVaultList: () => ({
    vaults: [
      { path: '/vaults/Active', name: 'Active', vaultUuid: 'uuid-active' },
      { path: '/vaults/Old', name: 'Old', vaultUuid: 'uuid-old' }
    ],
    removeVault: mocks.removeVault
  })
}))
vi.mock('@/hooks/use-account-vaults', () => ({
  useAccountVaults: () => ({ accountVaults: [], refresh: mocks.refresh })
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
  useSidebar: () => ({
    isMobile: mocks.isMobile,
    open: mocks.sidebarOpen,
    setOpen: mocks.setSidebarOpen,
    setOpenMobile: mocks.setOpenMobile
  })
}))
vi.mock('@/components/download-vault-dialog', () => ({
  DownloadVaultDialog: () => null
}))

import { VaultSwitcher } from './vault-switcher'
import { requestVaultSwitcherOpen } from '@/lib/vault-switcher-open'

describe('VaultSwitcher shortcut opening', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sidebarOpen = true
    mocks.isMobile = false
    document.body.innerHTML = ''
  })

  it('stays closed until something asks it to open', () => {
    render(<VaultSwitcher />)
    expect(screen.queryByTestId('vault-picker')).not.toBeInTheDocument()
  })

  it('opens on an open request and lists the vaults, current one still selected', () => {
    render(<VaultSwitcher />)

    act(() => requestVaultSwitcherOpen())

    const picker = screen.getByTestId('vault-picker')
    expect(within(picker).getByText('Active')).toBeInTheDocument()
    expect(within(picker).getByText('Old')).toBeInTheDocument()
    expect(mocks.switchVault).not.toHaveBeenCalled()
  })

  it('expands a collapsed sidebar so the picker has an anchor, then restores it', () => {
    mocks.sidebarOpen = false
    render(<VaultSwitcher />)

    act(() => requestVaultSwitcherOpen())
    expect(mocks.setSidebarOpen).toHaveBeenCalledWith(true)

    fireEvent.keyDown(screen.getByTestId('vault-picker'), { key: 'Escape' })
    expect(mocks.setSidebarOpen).toHaveBeenLastCalledWith(false)
  })

  it('leaves an already-open sidebar alone', () => {
    render(<VaultSwitcher />)

    act(() => requestVaultSwitcherOpen())

    expect(mocks.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('opens the mobile sidebar instead of the desktop one', () => {
    mocks.isMobile = true
    mocks.sidebarOpen = false
    render(<VaultSwitcher />)

    act(() => requestVaultSwitcherOpen())

    expect(mocks.setOpenMobile).toHaveBeenCalledWith(true)
    expect(mocks.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('closes on Escape without switching the vault', () => {
    render(<VaultSwitcher />)
    act(() => requestVaultSwitcherOpen())

    fireEvent.keyDown(screen.getByTestId('vault-picker'), { key: 'Escape' })

    expect(screen.queryByTestId('vault-picker')).not.toBeInTheDocument()
    expect(mocks.switchVault).not.toHaveBeenCalled()
  })

  it('restores focus to wherever the shortcut was pressed', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    render(<VaultSwitcher />)
    act(() => requestVaultSwitcherOpen())

    // Stand in for the picker taking focus, the way Radix does once it opens.
    const inside = within(screen.getByTestId('vault-picker'))
      .getByText('Old')
      .closest('button') as HTMLButtonElement
    inside.focus()
    expect(document.activeElement).not.toBe(opener)

    fireEvent.keyDown(screen.getByTestId('vault-picker'), { key: 'Escape' })

    expect(document.activeElement).toBe(opener)
  })

  it('switches the vault when one is picked', () => {
    render(<VaultSwitcher />)
    act(() => requestVaultSwitcherOpen())

    fireEvent.click(screen.getByText('Old'))

    expect(mocks.switchVault).toHaveBeenCalledWith('/vaults/Old')
  })

  it('opens focused on the active vault, so the arrow keys start where the user is', () => {
    render(<VaultSwitcher />)

    act(() => requestVaultSwitcherOpen())

    const activeRow = within(screen.getByTestId('vault-picker'))
      .getByText('Active')
      .closest('button')
    expect(document.activeElement).toBe(activeRow)
  })

  it('switches the vault on Enter over a focused row', async () => {
    render(<VaultSwitcher />)
    act(() => requestVaultSwitcherOpen())

    // Arrow-key movement between rows lives in `ui/picker/picker-content.tsx`;
    // what matters here is that landing on a row and pressing Enter switches.
    const row = within(screen.getByTestId('vault-picker'))
      .getByText('Old')
      .closest('button') as HTMLButtonElement
    row.focus()
    await userEvent.keyboard('{Enter}')

    expect(mocks.switchVault).toHaveBeenCalledWith('/vaults/Old')
  })

  it('stops listening once unmounted', () => {
    const { unmount } = render(<VaultSwitcher />)
    unmount()

    expect(() => act(() => requestVaultSwitcherOpen())).not.toThrow()
  })
})
