import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadVaultDialog } from './download-vault-dialog'
import { registerPendingSave, unregisterPendingSave } from '@/lib/save-registry'
import { getVaultSwitchState, resetVaultSwitchState } from '@/lib/vault-switch-state'
import type { AccountVaultInfo } from '../../../preload/index.d'

const linking = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>)
vi.mock('@/services/linking-service', () => ({ linkingService: linking }))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

const vault: AccountVaultInfo = {
  vaultUuid: 'uuid-b',
  name: 'Beta',
  itemCount: 42,
  createdAt: 1000,
  localPath: null,
  suggestedPath: '/home/user/Memry/beta'
}

describe('DownloadVaultDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(linking, {
      pickVaultFolder: vi.fn().mockResolvedValue({ path: '/picked/parent' })
    })
    window.api.vault = {
      ...window.api.vault,
      downloadRemote: vi.fn().mockResolvedValue({ success: true, vault: { path: '/x' } })
    }
  })

  it('renders nothing without a vault', () => {
    const { container } = render(<DownloadVaultDialog vault={null} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the suggested destination path', () => {
    render(<DownloadVaultDialog vault={vault} onClose={vi.fn()} />)
    expect(screen.getByText('/home/user/Memry/beta')).toBeInTheDocument()
  })

  it('updates the displayed path after choosing a new parent folder', async () => {
    render(<DownloadVaultDialog vault={vault} onClose={vi.fn()} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'phaseF.componentsVaultSwitcher.changeLocation' })
    )

    expect(await screen.findByText('/picked/parent/beta')).toBeInTheDocument()
  })

  it('downloads with the default location and closes on success', async () => {
    const onClose = vi.fn()
    render(<DownloadVaultDialog vault={vault} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'phaseF.componentsVaultSwitcher.download' }))

    await waitFor(() =>
      expect(window.api.vault.downloadRemote).toHaveBeenCalledWith('uuid-b', undefined)
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('downloads into the picked parent folder', async () => {
    render(<DownloadVaultDialog vault={vault} onClose={vi.fn()} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'phaseF.componentsVaultSwitcher.changeLocation' })
    )
    await screen.findByText('/picked/parent/beta')

    fireEvent.click(screen.getByRole('button', { name: 'phaseF.componentsVaultSwitcher.download' }))

    await waitFor(() =>
      expect(window.api.vault.downloadRemote).toHaveBeenCalledWith('uuid-b', '/picked/parent')
    )
  })

  // The download closes the open vault: edits still in their debounce belong to it, and the
  // in-between screen must hold, as for any switch.
  it('writes pending edits and starts a switch before the download closes the vault', async () => {
    resetVaultSwitchState()
    const order: string[] = []
    registerPendingSave('note-1', () => {
      order.push('flush')
    })
    window.api.vault.downloadRemote = vi.fn().mockImplementation(async () => {
      order.push(`download while switching to ${getVaultSwitchState().pending?.path}`)
      return { success: true, vault: { path: '/home/user/Memry/beta' } }
    })
    render(<DownloadVaultDialog vault={vault} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'phaseF.componentsVaultSwitcher.download' }))

    await waitFor(() => expect(order).toHaveLength(2))
    unregisterPendingSave('note-1')
    expect(order).toEqual(['flush', 'download while switching to /home/user/Memry/beta'])
    expect(getVaultSwitchState().pending).toBeNull()
  })

  // A stale suggestion can name the open vault's folder; main then makes another one. A switch to
  // the open path would not mark the open vault as left, so none starts.
  it('starts no switch when the suggested folder is the open vault', async () => {
    resetVaultSwitchState()
    window.api.vault.getStatus = vi
      .fn()
      .mockResolvedValue({ isOpen: true, path: '/home/user/Memry/beta' })
    const pending: unknown[] = []
    window.api.vault.downloadRemote = vi.fn().mockImplementation(async () => {
      pending.push(getVaultSwitchState().pending)
      return { success: true, vault: { path: '/home/user/Memry/beta-2' } }
    })
    const onClose = vi.fn()
    render(<DownloadVaultDialog vault={vault} onClose={onClose} />)
    await waitFor(() => expect(window.api.vault.getStatus).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))

    fireEvent.click(screen.getByRole('button', { name: 'phaseF.componentsVaultSwitcher.download' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(pending).toEqual([null])
  })

  it('shows the error and stays open when the download fails', async () => {
    const onClose = vi.fn()
    window.api.vault.downloadRemote = vi
      .fn()
      .mockResolvedValue({ success: false, vault: null, error: 'disk full' })
    render(<DownloadVaultDialog vault={vault} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'phaseF.componentsVaultSwitcher.download' }))

    await screen.findByText('disk full')
    expect(onClose).not.toHaveBeenCalled()
  })
})
