import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import type { AppleNotesFoldersResult } from '@memry/contracts/import-channels'
import { AppleNotesFolderPanel, type AppleNotesPanelState } from './apple-notes-folder-panel'

const TREE: AppleNotesFoldersResult = {
  accounts: [
    {
      name: 'iCloud',
      folders: [
        {
          id: 'f-work',
          title: 'Work',
          noteCount: 0,
          totalNoteCount: 3,
          children: [
            { id: 'f-clients', title: 'Clients', noteCount: 3, totalNoteCount: 3, children: [] }
          ]
        },
        { id: 'f-personal', title: 'Personal', noteCount: 2, totalNoteCount: 2, children: [] }
      ]
    }
  ],
  unfiledNoteCount: 1
}

describe('AppleNotesFolderPanel', () => {
  let i18n: I18nInstance
  let folders: ReturnType<typeof vi.fn>

  beforeAll(async () => {
    i18n = await createRendererI18n({ locale: 'en' })
  })

  beforeEach(() => {
    folders = vi.fn(() => Promise.resolve(TREE))
    ;(window as unknown as { api: unknown }).api = { import: { appleNotes: { folders } } }
  })

  const renderPanel = (onStateChange: (state: AppleNotesPanelState) => void = () => {}) =>
    render(
      <I18nextProvider i18n={i18n}>
        <AppleNotesFolderPanel
          sourcePath="/Users/k/Library/Group Containers/group.com.apple.notes"
          disabled={false}
          onStateChange={onStateChange}
        />
      </I18nextProvider>
    )

  const checkboxFor = (label: string): HTMLElement => {
    const row = screen.getByText(label).closest('label')
    if (!row) throw new Error(`no row for ${label}`)
    const box = row.querySelector('[role="checkbox"]')
    if (!box) throw new Error(`no checkbox for ${label}`)
    return box as HTMLElement
  }

  it('renders the tree with counts and preselects everything', async () => {
    const states: AppleNotesPanelState[] = []
    renderPanel((state) => states.push(state))

    await screen.findByText('Work')
    expect(folders).toHaveBeenCalledWith({
      sourcePath: '/Users/k/Library/Group Containers/group.com.apple.notes'
    })
    expect(screen.getByText('Clients')).toBeInTheDocument()
    expect(screen.getByText('Personal')).toBeInTheDocument()
    // Notes outside any folder are their own selectable row.
    expect(screen.getByText('Notes without a folder')).toBeInTheDocument()
    // A folder whose subtree holds more than the folder itself shows both.
    expect(screen.getByText('0 (3)')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()

    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.ready).toBe(true)
      expect(last.options.folderIds?.slice().sort()).toEqual(['f-clients', 'f-personal', 'f-work'])
      expect(last.options.includeUnfiledNotes).toBe(true)
    })
  })

  it('cascades a parent toggle to its children and reports the narrowed selection', async () => {
    const states: AppleNotesPanelState[] = []
    renderPanel((state) => states.push(state))
    await screen.findByText('Work')

    fireEvent.click(checkboxFor('Work'))

    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.options.folderIds?.slice().sort()).toEqual(['f-personal'])
    })
    expect(checkboxFor('Clients')).toHaveAttribute('data-state', 'unchecked')
  })

  it('shows a partially selected parent as indeterminate', async () => {
    renderPanel()
    await screen.findByText('Work')

    fireEvent.click(checkboxFor('Clients'))

    await waitFor(() => expect(checkboxFor('Work')).toHaveAttribute('data-state', 'indeterminate'))
    expect(checkboxFor('Work')).toHaveAttribute('aria-checked', 'mixed')
  })

  it('is not ready once every folder is cleared', async () => {
    const states: AppleNotesPanelState[] = []
    renderPanel((state) => states.push(state))
    await screen.findByText('Work')

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))

    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.ready).toBe(false)
      expect(last.options.folderIds).toEqual([])
      expect(last.options.includeUnfiledNotes).toBe(false)
    })
  })

  it('stays ready with no selection when the scan fails, so a full import still runs', async () => {
    folders.mockRejectedValue(new Error('Full Disk Access needed'))
    const states: AppleNotesPanelState[] = []
    renderPanel((state) => states.push(state))

    await screen.findByText('Full Disk Access needed')
    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.ready).toBe(true)
      // Empty options → the importer imports everything, as before the picker.
      expect(last.options).toEqual({})
    })
  })
})
