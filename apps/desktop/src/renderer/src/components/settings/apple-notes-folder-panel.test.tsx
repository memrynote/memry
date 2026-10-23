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
      id: 'acc-icloud',
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
  unfiledNoteCount: 1,
  lockedNoteCount: 0
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

    expect(checkboxFor('Work')).toHaveAttribute('data-state', 'checked')
    expect(checkboxFor('Personal')).toHaveAttribute('data-state', 'checked')

    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.ready).toBe(true)
      // Everything ticked hands off no options at all, so the run keeps the
      // unfiltered path: naming every folder would drop the ones the importer
      // cannot match by identifier.
      expect(last.options).toEqual({})
    })
  })

  it('goes back to no options when a narrowed selection is restored to everything', async () => {
    const states: AppleNotesPanelState[] = []
    renderPanel((state) => states.push(state))
    await screen.findByText('Work')

    fireEvent.click(checkboxFor('Personal'))
    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.options.folderIds?.slice().sort()).toEqual(['f-clients', 'f-work'])
      expect(last.options.includeUnfiledNotes).toBe(true)
    })

    fireEvent.click(checkboxFor('Personal'))
    await waitFor(() => {
      expect(states[states.length - 1].options).toEqual({})
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

    await waitFor(() => {
      expect(checkboxFor('Work')).toHaveAttribute('data-state', 'indeterminate')
    })
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

  it('surfaces a denied scan and hands off no selection, so a full import still runs', async () => {
    // A denied scan resolves as a failure envelope instead of rejecting; an
    // unchecked one used to render a TypeError and hand off “unfiled notes
    // only”, importing almost nothing.
    folders.mockResolvedValue({
      success: false,
      error: 'Memry could not read the Apple Notes data. Grant Full Disk Access.'
    })
    const states: AppleNotesPanelState[] = []
    renderPanel((state) => states.push(state))

    await screen.findByText(/Full Disk Access/)
    expect(screen.queryByText(/flatMap|undefined/)).not.toBeInTheDocument()
    await waitFor(() => {
      const last = states[states.length - 1]
      expect(last.ready).toBe(true)
      // Empty options → the importer imports everything, as before the picker.
      expect(last.options).toEqual({})
      expect(last.options.folderIds).toBeUndefined()
    })
  })

  describe('locked notes', () => {
    let checkUnlock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      folders.mockResolvedValue({ ...TREE, lockedNoteCount: 3 })
      checkUnlock = vi.fn(() => Promise.resolve({ unlocked: 3, total: 3 }))
      ;(window as unknown as { api: unknown }).api = {
        import: { appleNotes: { folders, checkUnlock } }
      }
    })

    const enterPassword = async (value: string): Promise<void> => {
      fireEvent.change(await screen.findByLabelText('Notes password'), { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: 'Check' }))
    }

    it('offers no password field when nothing is locked', async () => {
      folders.mockResolvedValue(TREE)
      renderPanel()
      await screen.findByText('Work')
      expect(screen.queryByLabelText('Notes password')).not.toBeInTheDocument()
    })

    it('hands the password to the import only after it unlocks notes', async () => {
      const states: AppleNotesPanelState[] = []
      renderPanel((state) => states.push(state))
      await screen.findByText('Work')
      expect(states[states.length - 1].options.notesPassword).toBeUndefined()

      await enterPassword('hunter2')

      await screen.findByText('Unlocks all 3 locked notes.')
      expect(checkUnlock).toHaveBeenCalledWith({
        sourcePath: '/Users/k/Library/Group Containers/group.com.apple.notes',
        password: 'hunter2'
      })
      await waitFor(() => {
        expect(states[states.length - 1].options).toEqual({ notesPassword: 'hunter2' })
      })
    })

    it('keeps a wrong password out of the import options and says so', async () => {
      checkUnlock.mockResolvedValue({ unlocked: 0, total: 3 })
      const states: AppleNotesPanelState[] = []
      renderPanel((state) => states.push(state))
      await screen.findByText('Work')

      await enterPassword('nope')

      await screen.findByText('That password does not unlock any locked note.')
      expect(states.every((state) => state.options.notesPassword === undefined)).toBe(true)
    })

    it('warns when the password only unlocks some notes', async () => {
      checkUnlock.mockResolvedValue({ unlocked: 2, total: 3 })
      renderPanel()
      await screen.findByText('Work')

      await enterPassword('older')

      await screen.findByText(/Unlocks 2 of 3 locked notes/)
    })

    it('drops the password from the options as soon as it is edited', async () => {
      const states: AppleNotesPanelState[] = []
      renderPanel((state) => states.push(state))
      await screen.findByText('Work')
      await enterPassword('hunter2')
      await waitFor(() => {
        expect(states[states.length - 1].options.notesPassword).toBe('hunter2')
      })

      fireEvent.change(screen.getByLabelText('Notes password'), { target: { value: 'hunter' } })

      await waitFor(() => {
        expect(states[states.length - 1].options.notesPassword).toBeUndefined()
      })
    })
  })
})
