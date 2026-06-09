import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadVaultDialog } from './download-vault-dialog'
import type { AccountVaultInfo } from '../../../preload/index.d'

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
    window.api.syncLinking = {
      ...window.api.syncLinking,
      pickVaultFolder: vi.fn().mockResolvedValue({ path: '/picked/parent' })
    }
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

    await screen.findByText('/picked/parent/beta')
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
