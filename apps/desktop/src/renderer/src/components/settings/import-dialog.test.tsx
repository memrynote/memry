import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { ImportDialog } from './import-dialog'
import { DEFAULT_IMPORT_ICON } from '@/lib/import-catalog'
import type { ImportSummaryResult } from '@memry/contracts/import-channels'
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

// Two directory-picking importers that ask for different things: Apple Notes
// wants one specific container folder, NotePlan a whole vault.
const appleNotesItem: ImporterItem = {
  id: 'apple-notes',
  name: 'Apple Notes',
  descriptionKey: 'import.sources.apple-notes',
  fileSpec: {
    label: 'Apple Notes database',
    extensions: ['sqlite'],
    allowMultiple: false,
    directory: true,
    chooseLabelKey: 'import.dialog.chooseFolder',
    folderHintKey: 'import.dialog.folderHint'
  },
  supportsPreview: false,
  icon: DEFAULT_IMPORT_ICON
}

const notePlanItem: ImporterItem = {
  id: 'noteplan',
  name: 'NotePlan',
  descriptionKey: 'import.sources.noteplan',
  fileSpec: {
    label: 'NotePlan folder',
    extensions: [],
    allowMultiple: false,
    directory: true,
    folderHintKey: 'import.dialog.noteplanFolderHint'
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

  // Apple Notes was the only directory importer for a while, so its bespoke
  // copy ("Select Apple Notes folder…", the group.com.apple.notes hint) was
  // hardcoded for every directory pick — and surfaced verbatim under NotePlan.
  // The copy now travels with the importer.
  it('uses each directory importer’s own picker copy, never a sibling’s', () => {
    const { unmount } = renderDialog(appleNotesItem)
    expect(screen.getByRole('button', { name: 'Select Apple Notes folder…' })).toBeInTheDocument()
    expect(screen.getByText('group.com.apple.notes', { exact: false })).toBeInTheDocument()
    unmount()

    renderDialog(notePlanItem)
    expect(screen.queryByRole('button', { name: 'Select Apple Notes folder…' })).toBeNull()
    expect(screen.queryByText('group.com.apple.notes', { exact: false })).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeInTheDocument()
    // Match the hint specifically — the dialog description also says "NotePlan folder".
    expect(screen.getByText(/Calendar, Notes and @Archive/)).toBeInTheDocument()
  })

  it('renders no folder hint when a directory importer supplies none', () => {
    renderDialog({
      ...notePlanItem,
      fileSpec: { ...notePlanItem.fileSpec, folderHintKey: undefined }
    })
    expect(screen.queryByText('group.com.apple.notes', { exact: false })).toBeNull()
    expect(screen.queryByText(/Calendar, Notes and @Archive/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Choose folder…' })).toBeInTheDocument()
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

describe('ImportDialog folder picker (Apple Notes)', () => {
  let i18n: I18nInstance
  let start: ReturnType<typeof vi.fn>
  let folders: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    start = vi.fn(() =>
      Promise.resolve({
        success: true,
        summary: { imported: 1, attachments: 0, skipped: 0, failed: [] }
      })
    )
    folders = vi.fn(() =>
      Promise.resolve({
        accounts: [
          {
            name: 'iCloud',
            folders: [
              { id: 'f-work', title: 'Work', noteCount: 2, totalNoteCount: 2, children: [] },
              { id: 'f-personal', title: 'Personal', noteCount: 1, totalNoteCount: 1, children: [] }
            ]
          }
        ],
        unfiledNoteCount: 0
      })
    )
    ;(window as unknown as { api: unknown }).api = {
      onImportProgress: () => () => {},
      import: {
        pickFiles: vi.fn(() =>
          Promise.resolve({ canceled: false, filePaths: ['/Users/k/group.com.apple.notes'] })
        ),
        start,
        cancel: () => {},
        preview: () => {},
        list: () => {},
        appleNotes: { folders }
      }
    }
  })

  it('picks folders after the source folder and starts with the selection', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <ImportDialog item={appleNotesItem} open onOpenChange={() => {}} />
        </I18nextProvider>
      </QueryClientProvider>
    )

    // The folder tree only loads once the user has granted access to a source.
    expect(folders).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Select Apple Notes folder…' }))

    await screen.findByText('Work')
    expect(folders).toHaveBeenCalledWith({ sourcePath: '/Users/k/group.com.apple.notes' })

    // Drop one folder, keep the other.
    const personalRow = screen.getByText('Personal').closest('label')!
    fireEvent.click(personalRow.querySelector('[role="checkbox"]')!)

    const startButton = screen.getByText('Start import').closest('button')!
    await waitFor(() => expect(startButton).not.toBeDisabled())
    fireEvent.pointerDown(startButton)
    fireEvent.click(startButton)

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const payload = start.mock.calls[0][0]
    expect(payload.importerId).toBe('apple-notes')
    expect(payload.sourcePaths).toEqual(['/Users/k/group.com.apple.notes'])
    expect(payload.options.folderIds).toEqual(['f-work'])
  })
})

describe('ImportDialog summary — skipped reasons', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  const runWithSummary = async (summary: ImportSummaryResult) => {
    ;(window as unknown as { api: unknown }).api = {
      onImportProgress: () => () => {},
      import: {
        pickFiles: vi.fn(() =>
          Promise.resolve({ canceled: false, filePaths: ['/export/Notes.sqlite'] })
        ),
        start: vi.fn(() => Promise.resolve({ success: true, summary })),
        cancel: () => {},
        preview: () => {},
        list: () => {},
        // The Apple Notes folder panel scans the picked source; an empty tree
        // keeps these summary cases on the import-everything path.
        appleNotes: {
          folders: vi.fn(() => Promise.resolve({ accounts: [], unfiledNoteCount: 0 }))
        }
      }
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <ImportDialog item={appleNotesItem} open onOpenChange={() => {}} />
        </I18nextProvider>
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Select Apple Notes folder…' }))
    const startButton = await screen.findByRole('button', { name: 'Start import' })
    await waitFor(() => expect(startButton).toBeEnabled())
    fireEvent.click(startButton)
    await screen.findByText('Import complete')
  }

  it('explains a coded reason once, with the grouped count', async () => {
    await runWithSummary({
      imported: 4,
      attachments: 0,
      skipped: 3,
      failed: [],
      skippedReasons: [
        {
          reason: {
            code: 'appleNotes.lockedNote',
            message: 'Locked notes were not imported'
          },
          count: 3
        }
      ]
    })

    expect(screen.getByText('3 skipped')).toBeInTheDocument()
    expect(
      screen.getByText(
        '3 locked notes were not imported; Memry cannot read them without your Notes password.'
      )
    ).toBeInTheDocument()
  })

  it('wraps a plain-string reason so its count still shows', async () => {
    await runWithSummary({
      imported: 1,
      attachments: 0,
      skipped: 2,
      failed: [],
      skippedReasons: [{ reason: 'attachment file not found', count: 2 }]
    })

    expect(screen.getByText('2 items: attachment file not found')).toBeInTheDocument()
  })

  it('wraps a code this build cannot translate, keeping the count', async () => {
    await runWithSummary({
      imported: 1,
      attachments: 0,
      skipped: 5,
      failed: [],
      skippedReasons: [
        { reason: { code: 'future.code', message: 'Something newer skipped them' }, count: 5 }
      ]
    })

    expect(screen.getByText('5 items: Something newer skipped them')).toBeInTheDocument()
  })

  it('renders a summary from an older build that has no skippedReasons', async () => {
    await runWithSummary({ imported: 1, attachments: 0, skipped: 2, failed: [] })

    expect(screen.getByText('2 skipped')).toBeInTheDocument()
    expect(screen.queryByText(/2 items:/)).toBeNull()
  })
})

describe('ImportDialog account-based importer (OneNote)', () => {
  let i18n: I18nInstance
  let start: ReturnType<typeof vi.fn>

  const onenoteItem: ImporterItem = {
    id: 'onenote',
    name: 'OneNote',
    descriptionKey: 'import.sources.onenote',
    fileSpec: { label: 'Microsoft OneNote', extensions: [], allowMultiple: false },
    supportsPreview: false,
    accountBased: true,
    icon: DEFAULT_IMPORT_ICON
  }

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    start = vi.fn(() =>
      Promise.resolve({
        success: true,
        summary: { imported: 1, attachments: 0, skipped: 0, failed: [] }
      })
    )
    ;(window as unknown as { api: unknown }).api = {
      onImportProgress: () => () => {},
      import: {
        pickFiles: vi.fn(),
        start,
        cancel: () => {},
        preview: () => {},
        list: () => {},
        onenote: {
          status: vi.fn(() =>
            Promise.resolve({
              configured: true,
              connected: true,
              account: { name: 'Kaan', email: 'kaan@example.com' }
            })
          ),
          connect: vi.fn(),
          disconnect: vi.fn(),
          notebooks: vi.fn(() =>
            Promise.resolve({
              notebooks: [
                {
                  id: 'nb1',
                  displayName: 'Work',
                  sections: [{ id: 's1', displayName: 'Ideas' }],
                  sectionGroups: []
                }
              ]
            })
          )
        }
      }
    }
  })

  it('replaces the file picker with the OneNote panel and starts with options', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nextProvider i18n={i18n}>
          <ImportDialog item={onenoteItem} open onOpenChange={() => {}} />
        </I18nextProvider>
      </QueryClientProvider>
    )

    // No native file picker for an account-based importer.
    expect(screen.queryByText('Choose file…')).toBeNull()

    // Panel loads the tree and preselects; Start becomes enabled.
    await screen.findByText('Ideas')
    const startButton = screen.getByText('Start import').closest('button')!
    await waitFor(() => expect(startButton).not.toBeDisabled())

    fireEvent.pointerDown(startButton)
    fireEvent.click(startButton)

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    const payload = start.mock.calls[0][0]
    expect(payload.importerId).toBe('onenote')
    expect(payload.sourcePaths).toEqual([])
    expect(payload.options.sectionIds).toEqual(['s1'])
    expect(payload.options.skipPreviouslyImported).toBe(true)
    expect(payload.options.includeIncompatibleAttachments).toBe(false)
  })
})
