import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { ImportDialog } from './import-dialog'
import { DEFAULT_IMPORT_ICON } from '@/lib/import-catalog'
import type { ImporterItem } from '@/hooks/use-importers'

const notionItem: ImporterItem = {
  id: 'notion',
  name: 'Notion',
  descriptionKey: 'import.sources.notion',
  fileSpec: { label: 'Notion HTML export', extensions: ['zip'], allowMultiple: true },
  supportsPreview: false,
  icon: DEFAULT_IMPORT_ICON
}

// Markdown accepts either loose files or a whole export folder. Electron cannot
// offer both in one native panel, so the dialog renders a second button.
const markdownItem: ImporterItem = {
  id: 'markdown',
  name: 'Markdown',
  descriptionKey: 'import.sources.markdown',
  fileSpec: {
    label: 'Markdown files',
    extensions: ['md', 'markdown'],
    allowMultiple: true,
    allowDirectory: true
  },
  supportsPreview: false,
  icon: DEFAULT_IMPORT_ICON
}

describe('ImportDialog i18n', () => {
  let i18n: I18nInstance
  let pickFiles: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    pickFiles = vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] }))
    ;(window as unknown as { api: unknown }).api = {
      onImportProgress: () => () => {},
      import: {
        pickFiles,
        start: () => {},
        cancel: () => {},
        preview: () => {},
        list: () => {}
      }
    }
  })

  const renderDialog = (item: ImporterItem) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <ImportDialog item={item} open onOpenChange={() => {}} />
        </I18nextProvider>
      </QueryClientProvider>
    )

  it('interpolates the ICU title and description (no literal braces)', () => {
    renderDialog(notionItem)

    expect(screen.getByText('Import from Notion')).toBeInTheDocument()
    expect(screen.queryByText(/\{\{?name\}?\}/)).toBeNull()
  })

  it('offers a folder button only when the importer accepts a directory too', () => {
    const { unmount } = renderDialog(notionItem)
    expect(screen.queryByRole('button', { name: 'Choose folder…' })).toBeNull()
    unmount()

    renderDialog(markdownItem)
    expect(screen.getByRole('button', { name: 'Choose file…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeInTheDocument()
    expect(screen.getByText(/exports often keep media in a shared one/)).toBeInTheDocument()
  })

  it('asks the native panel for a directory only from the folder button', async () => {
    renderDialog(markdownItem)

    fireEvent.click(screen.getByRole('button', { name: 'Choose file…' }))
    await waitFor(() => expect(pickFiles).toHaveBeenCalledTimes(1))
    expect(pickFiles.mock.calls[0][0].directory).toBeFalsy()

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))
    await waitFor(() => expect(pickFiles).toHaveBeenCalledTimes(2))
    expect(pickFiles.mock.calls[1][0].directory).toBe(true)
  })

  it('shows the picked selection and enables the start button', async () => {
    pickFiles.mockResolvedValue({ canceled: false, filePaths: ['/export/Notes'] })
    renderDialog(markdownItem)

    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }))

    await waitFor(() => expect(screen.getByText('1 file selected')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Start import' })).toBeEnabled()
  })
})
