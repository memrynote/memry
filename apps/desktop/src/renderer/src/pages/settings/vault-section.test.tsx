import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { VaultSettings } from './vault-section'

vi.mock('@/hooks/use-storage-usage', () => ({
  useStorageUsage: () => ({
    data: null,
    loading: false,
    refresh: vi.fn()
  })
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

describe('VaultSettings importer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.api.vault.getStatus = vi.fn().mockResolvedValue({
      isOpen: true,
      path: '/vault',
      isIndexing: false,
      indexProgress: 100,
      error: null
    })
    window.api.notes.showImportDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ['/exports/source']
    })
    window.api.notes.importFiles = vi.fn().mockResolvedValue({
      success: true,
      imported: 3,
      failed: 0,
      errors: [],
      importedFiles: []
    })
  })

  it('imports Obsidian and Notion into the notes root', async () => {
    render(<VaultSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Import Obsidian Vault' }))

    await waitFor(() => expect(window.api.notes.showImportDialog).toHaveBeenCalledWith('obsidian'))
    expect(window.api.notes.importFiles).toHaveBeenCalledWith(['/exports/source'], '', 'obsidian')
    expect(toast.success).toHaveBeenCalledWith('Imported 3 items from Obsidian')

    fireEvent.click(screen.getByRole('button', { name: 'Import Notion Export' }))

    await waitFor(() => expect(window.api.notes.showImportDialog).toHaveBeenCalledWith('notion'))
    expect(window.api.notes.importFiles).toHaveBeenCalledWith(['/exports/source'], '', 'notion')
  })

  it('does not import when source selection is canceled', async () => {
    window.api.notes.showImportDialog = vi.fn().mockResolvedValueOnce({
      canceled: true,
      filePaths: []
    })

    render(<VaultSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Import Obsidian Vault' }))

    await waitFor(() => expect(window.api.notes.showImportDialog).toHaveBeenCalledWith('obsidian'))
    expect(window.api.notes.importFiles).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows partial and failure feedback for importer results', async () => {
    window.api.notes.importFiles = vi.fn().mockResolvedValueOnce({
      success: false,
      imported: 1,
      failed: 1,
      errors: ['Failed to import Bad.md: permission denied'],
      importedFiles: []
    })

    render(<VaultSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Import Notion Export' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to import 1 item from Notion', {
        description: 'Failed to import Bad.md: permission denied'
      })
    )
    expect(toast.success).toHaveBeenCalledWith('Imported 1 item from Notion')
  })

  it('shows importer errors from IPC failures', async () => {
    window.api.notes.showImportDialog = vi.fn().mockRejectedValueOnce(new Error('Dialog failed'))

    render(<VaultSettings />)

    fireEvent.click(screen.getByRole('button', { name: 'Import Notion Export' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Dialog failed'))
  })
})
