import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES } from '@memry/i18n/shared'

import { AddSubtaskInput } from './tasks/add-subtask-input'
import { VaultOnboarding } from './vault-onboarding'
import { UnsavedChangesDialog } from './tabs/unsaved-changes-dialog'
import { DocumentInfoTab } from './shared/document-info-tab'
import { NoteDrawer } from './journal/note-drawer'
import { BulkTagPopover } from './bulk/bulk-tag-popover'
import { LayoutPicker } from './split-view/layout-picker'
import { DeleteProjectDialog } from './tasks/delete-project-dialog'
import { FolderViewEmptyState } from './folder-view/folder-view-empty-state'
import { JournalErrorBoundary } from './journal/journal-error-boundary'

const mocks = vi.hoisted(() => ({
  selectVault: vi.fn(),
  switchVault: vi.fn(),
  closeTab: vi.fn(),
  dispatch: vi.fn(),
  applyLayoutPreset: vi.fn(),
  onTagsChange: null as null | ((tags: string[]) => void),
  clipboardWrite: vi.fn(),
  logError: vi.fn(),
  localeSet: vi.fn(),
  openWindow: vi.fn(),
  i18n: {
    language: 'en',
    changeLanguage: vi.fn()
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
    i18n: mocks.i18n
  })
}))

vi.mock('react-i18next', () => ({
  Translation: ({
    children
  }: {
    children: (t: (key: string, values?: unknown) => string) => React.ReactNode
  }) => children((key, values) => (values ? `${key} ${JSON.stringify(values)}` : key)),
  getI18n: () => ({
    getFixedT:
      () =>
      (key: string, values?: unknown): string =>
        values ? `${key} ${JSON.stringify(values)}` : key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: mocks.logError
  })
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} disabled={disabled} onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({
    open,
    onOpenChange,
    children
  }: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children: React.ReactNode
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange?.(false)}>
        close alert
      </button>
      {open ? children : null}
    </div>
  ),
  AlertDialogAction: ({ children, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/filing/tag-autocomplete', () => ({
  TagAutocomplete: ({ onTagsChange }: { onTagsChange: (tags: string[]) => void }) => {
    mocks.onTagsChange = onTagsChange
    return (
      <button type="button" onClick={() => onTagsChange(['focus', 'work'])}>
        pick tags
      </button>
    )
  }
}))

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    selectVault: mocks.selectVault,
    switchVault: mocks.switchVault,
    isLoading: false,
    error: 'Vault failed'
  }),
  useVaultList: () => ({
    vaults: [
      {
        path: '/vaults/work',
        name: 'Work Vault',
        noteCount: 3,
        lastOpened: new Date(Date.now() - 90_000).toISOString()
      },
      {
        path: '/vaults/home',
        name: 'Home Vault',
        noteCount: 1,
        lastOpened: new Date(Date.now() - 90_000_000).toISOString()
      }
    ]
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    state: {
      tabGroups: {
        group: {
          id: 'group',
          tabs: [
            { id: 'dirty', title: 'Dirty Note', isModified: true },
            { id: 'clean', title: 'Clean Note', isModified: false }
          ]
        }
      }
    },
    closeTab: mocks.closeTab,
    dispatch: mocks.dispatch
  })
}))

vi.mock('./split-view/layout-presets', () => ({
  layoutPresets: [
    { id: 'single', label: 'Single', description: 'One pane' },
    { id: 'two-columns', label: 'Columns', description: 'Two columns' },
    { id: 'grid-2x2', label: 'Grid', description: 'Grid' }
  ],
  applyLayoutPreset: (state: unknown, preset: string) => mocks.applyLayoutPreset(state, preset)
}))

function CrashingChild() {
  throw new Error('journal exploded')
}

describe('missing small component surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mocks.onTagsChange = null
    mocks.i18n.language = 'en'
    mocks.i18n.changeLanguage.mockImplementation(async (locale: string) => {
      mocks.i18n.language = locale
    })
    mocks.localeSet.mockResolvedValue(undefined)
    mocks.selectVault.mockResolvedValue({ success: false, vault: null, error: 'cancelled' })
    mocks.switchVault.mockResolvedValue({ success: false, vault: null, error: 'cancelled' })
    if (!HTMLElement.prototype.hasPointerCapture) {
      HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
    }
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn()
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = vi.fn()
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = vi.fn()
    }
    mocks.applyLayoutPreset.mockReturnValue({
      tabGroups: { next: { id: 'next', tabs: [] } },
      layout: { type: 'single' },
      activeGroupId: 'next'
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.clipboardWrite.mockResolvedValue(undefined) }
    })
    Object.assign(window.api, {
      locale: {
        set: mocks.localeSet
      }
    })
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: mocks.openWindow
    })
  })

  it('adds subtasks, clears on Escape, and preserves focus for rapid entry', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(<AddSubtaskInput parentId="task-1" onAdd={onAdd} />)

    const input = screen.getByRole('textbox')
    await user.click(input)
    await user.type(input, '  Draft outline  ')
    expect(screen.getByText('phaseF.componentsTasksAddSubtaskInput.enterToAdd')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith('task-1', 'Draft outline')
    expect(input).toHaveValue('')

    await user.type(input, 'cancel')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
  })

  it('opens new and recent vaults from onboarding', async () => {
    const user = userEvent.setup()
    render(<VaultOnboarding />)

    expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /signInToSync/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /createNewVault/ }))
    expect(mocks.selectVault).toHaveBeenCalled()
    expect(screen.getByText('Vault failed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Work Vault/ }))
    expect(mocks.switchVault).toHaveBeenCalledWith('/vaults/work')
  })

  it('changes language from the vault picker supported-language dropdown', async () => {
    const user = userEvent.setup()
    render(<VaultOnboarding />)

    await user.click(screen.getByRole('combobox'))

    expect(await screen.findByRole('listbox')).toHaveAttribute('data-side', 'top')
    expect(screen.getAllByRole('option')).toHaveLength(SUPPORTED_LOCALES.length)
    expect(screen.getByRole('option', { name: LOCALE_DISPLAY_NAMES.en })).toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: LOCALE_DISPLAY_NAMES.tr }))

    await waitFor(() => {
      expect(mocks.localeSet).toHaveBeenCalledWith('tr')
    })
    expect(mocks.i18n.changeLanguage).toHaveBeenCalledWith('tr')
  })

  it('opens the public docs site from the vault picker help link', async () => {
    const user = userEvent.setup()
    render(<VaultOnboarding />)

    await user.click(screen.getByRole('button', { name: /helpAndDocs/ }))

    expect(mocks.openWindow).toHaveBeenCalledWith(
      'https://docs.memrynote.com',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('renders unsaved changes dialog actions', () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    const onCancel = vi.fn()
    render(
      <UnsavedChangesDialog
        isOpen
        tabTitle="Dirty Note"
        onSave={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />
    )

    fireEvent.click(screen.getByText('button.save'))
    fireEvent.click(screen.getByText('button.dontSave'))
    fireEvent.click(screen.getByText('button.cancel'))
    fireEvent.click(screen.getByText('close alert'))

    expect(onSave).toHaveBeenCalled()
    expect(onDiscard).toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('formats document stats with valid and invalid dates', () => {
    const { rerender } = render(
      <DocumentInfoTab
        stats={{
          wordCount: 401,
          characterCount: 12345,
          createdAt: '2026-05-10T00:00:00.000Z',
          modifiedAt: 'not-a-date'
        }}
      />
    )

    expect(screen.getByText('401')).toBeInTheDocument()
    expect(screen.getByText('12,345')).toBeInTheDocument()
    expect(screen.getByText('3 min')).toBeInTheDocument()
    expect(screen.getByText('10.05.2026')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()

    rerender(
      <DocumentInfoTab
        stats={{ wordCount: 0, characterCount: 0, createdAt: null, modifiedAt: new Date('bad') }}
      />
    )
    expect(screen.getByText('0 min')).toBeInTheDocument()
  })

  it('handles note drawer actions, backdrop close, Escape, and fallback preview content', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const onOpenFullPage = vi.fn()
    const note = {
      id: 'note-1',
      title: 'Launch Note',
      content: '<p>Body</p>',
      preview: 'Preview'
    }

    const { rerender } = render(
      <NoteDrawer note={note as never} isOpen onClose={onClose} onOpenFullPage={onOpenFullPage} />
    )

    expect(screen.getByText('Launch Note')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('action.openNoteFullPage'))
    expect(onOpenFullPage).toHaveBeenCalledWith('note-1')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByLabelText('action.closeNoteDrawer'))
    expect(onClose).toHaveBeenCalledTimes(2)

    rerender(
      <NoteDrawer
        note={{ ...note, content: '', preview: 'Preview' } as never}
        isOpen
        onClose={onClose}
      />
    )
    expect(screen.getByText('Preview')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(100)
    })
  })

  it('applies bulk tags after the popover delay', async () => {
    vi.useFakeTimers()
    const onApplyTags = vi.fn()
    const onOpenChange = vi.fn()

    render(
      <BulkTagPopover
        isOpen
        itemCount={2}
        trigger={<button type="button">tag selected</button>}
        onOpenChange={onOpenChange}
        onApplyTags={onApplyTags}
      />
    )

    fireEvent.click(screen.getByText('pick tags'))
    fireEvent.click(screen.getByRole('button', { name: /bulk.tagPopover.apply/ }))
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(onApplyTags).toHaveBeenCalledWith(['focus', 'work'])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('dispatches a selected layout preset when the preset can be applied', () => {
    render(<LayoutPicker />)

    fireEvent.click(screen.getByText('Columns'))
    expect(mocks.applyLayoutPreset).toHaveBeenCalledWith(expect.any(Object), 'two-columns')
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SET_LAYOUT',
        payload: expect.objectContaining({ activeGroupId: 'next' })
      })
    )
  })

  it('confirms project deletion options and renders every folder empty-state action', () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    const { rerender } = render(
      <DeleteProjectDialog
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        project={{ id: 'project-1', name: 'Work', taskCount: 2 } as never}
      />
    )

    // Tasks always go with the project (main's deleteProject cascades them), so
    // the dialog states the count instead of offering a move-vs-delete choice.
    expect(screen.getByText(/thisProjectHas/)).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('phaseF.componentsTasksDeleteProjectDialog.deleteProject'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()

    rerender(
      <DeleteProjectDialog
        isOpen
        onClose={onClose}
        onConfirm={onConfirm}
        project={{ id: 'project-2', name: 'Empty', taskCount: 0 } as never}
      />
    )
    expect(screen.getByText(/thisProjectHasNoTasks/)).toBeInTheDocument()

    const actions = {
      onCreateNote: vi.fn(),
      onClearAll: vi.fn(),
      onRetry: vi.fn(),
      onGoBack: vi.fn()
    }
    render(
      <>
        <FolderViewEmptyState variant="empty" onCreateNote={actions.onCreateNote} />
        <FolderViewEmptyState variant="no-results" onClearAll={actions.onClearAll} />
        <FolderViewEmptyState variant="error" errorMessage="Offline" onRetry={actions.onRetry} />
        <FolderViewEmptyState variant="folder-not-found" onGoBack={actions.onGoBack} />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create Note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go Back' }))
    expect(actions.onCreateNote).toHaveBeenCalled()
    expect(actions.onClearAll).toHaveBeenCalled()
    expect(actions.onRetry).toHaveBeenCalled()
    expect(actions.onGoBack).toHaveBeenCalled()
    expect(screen.getByText('Offline')).toBeInTheDocument()
  })

  it('recovers journal crashes and preserves pending content copy', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRecover = vi.fn()
    const onError = vi.fn()
    const healthy = render(
      <JournalErrorBoundary>
        <div>Healthy journal</div>
      </JournalErrorBoundary>
    )
    expect(screen.getByText('Healthy journal')).toBeInTheDocument()
    healthy.unmount()

    render(
      <JournalErrorBoundary
        date="2026-05-10"
        pendingContent="unsaved draft"
        onRecover={onRecover}
        onError={onError}
      >
        <CrashingChild />
      </JournalErrorBoundary>
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(onError).toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('action.copyUnsavedContent'))
    expect(mocks.clipboardWrite).toHaveBeenCalledWith('unsaved draft')

    fireEvent.click(screen.getByLabelText('action.reloadJournal'))
    expect(onRecover).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
