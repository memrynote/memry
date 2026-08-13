import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NotesTree, type NotesTreeActions } from './notes-tree'
import { isRevealed } from '@tests/utils/reveal'

const mocks = vi.hoisted(() => ({
  data: null as any,
  actions: null as any,
  lastDeps: null as any,
  virtualized: false,
  treeActions: {
    collapseAll: vi.fn(),
    expandAll: vi.fn(),
    expandNode: vi.fn(),
    expandNodes: vi.fn()
  },
  virtualActions: {
    collapseAll: vi.fn(),
    expandAll: vi.fn(),
    expandNode: vi.fn()
  },
  scrollIntoView: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count === undefined ? key : `${key}:${values.count}`
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (_err: unknown, fallback: string) => fallback
}))

vi.mock('@/lib/virtualized-tree-utils', () => ({
  shouldVirtualize: () => mocks.virtualized
}))

vi.mock('@/hooks/use-note-tree-data', () => ({
  useNoteTreeData: () => mocks.data
}))

vi.mock('@/hooks/use-note-tree-actions', () => ({
  useNoteTreeActions: (deps: unknown) => {
    mocks.lastDeps = deps
    return mocks.actions
  }
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenuItem: ({ children, onClick, variant }: any) => (
    <button type="button" data-variant={variant} onClick={onClick}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />
}))

vi.mock('@/components/kibo-ui/tree', () => ({
  TreeProvider: ({ children, selectedIds, draggable, onSelectionChange, onMove }: any) => (
    <div data-testid="tree-provider" data-draggable={String(draggable)}>
      <span data-testid="selected-count">{selectedIds.length}</span>
      <button type="button" onClick={() => onSelectionChange(['root'])}>
        select root
      </button>
      <button type="button" onClick={() => onMove('root', 'folder-Work', 0)}>
        move root
      </button>
      {children}
    </div>
  ),
  TreeView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TreeNode: ({ children, nodeId, hasChildren, acceptsDropInside }: any) => (
    <div
      data-tree-node-id={nodeId}
      data-has-children={String(hasChildren)}
      data-accepts-drop-inside={String(acceptsDropInside)}
    >
      {children}
    </div>
  ),
  TreeNodeContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TreeNodeTrigger: ({ children, contextMenuContent }: any) => (
    <div>
      <div data-testid="context-menu">{contextMenuContent}</div>
      <div>{children}</div>
    </div>
  ),
  TreeIcon: ({ icon }: { icon: ReactNode }) => <span data-testid="tree-icon">{icon}</span>,
  TreeLabel: ({ children, className: _className }: any) => <span>{children}</span>
}))

vi.mock('@/components/note-tree-internal', () => ({
  TreeFolderIcon: ({ icon, hasChildren, onIconChange, pickerOpen, onPickerOpenChange }: any) => (
    <span data-testid="folder-icon" data-picker-open={String(pickerOpen)}>
      <span>{icon ?? 'folder'}</span>
      <span>{hasChildren ? 'has children' : 'empty folder'}</span>
      <button type="button" onClick={() => onIconChange('rocket')}>
        set folder icon
      </button>
      <button type="button" onClick={() => onPickerOpenChange(true)}>
        open icon picker
      </button>
      <button type="button" onClick={() => onPickerOpenChange(false)}>
        close icon picker
      </button>
    </span>
  ),
  RevealHandler: ({ pendingRevealNoteId, onReveal, onClear }: any) => (
    <span>
      <span data-testid="pending-reveal">{pendingRevealNoteId ?? ''}</span>
      <button type="button" onClick={() => onReveal(pendingRevealNoteId ?? 'root')}>
        reveal pending
      </button>
      <button type="button" onClick={onClear}>
        clear reveal
      </button>
    </span>
  ),
  FolderRevealHandler: () => <span data-testid="folder-reveal" />,
  TreeActionsExposer: ({ actionsRef }: any) => {
    actionsRef.current = mocks.treeActions
    return <span data-testid="tree-actions-exposer" />
  }
}))

vi.mock('@/components/note-tree-dialogs', () => ({
  NoteTreeDeleteDialog: ({ open, onOpenChange, onConfirm }: any) => (
    <div data-testid="delete-dialog" data-open={String(open)}>
      <button type="button" onClick={() => onOpenChange(false)}>
        close delete
      </button>
      <button type="button" onClick={() => onConfirm()}>
        confirm delete
      </button>
    </div>
  ),
  NoteTreeTemplateSelector: ({ isOpen, onClose, onSelect }: any) => (
    <div data-testid="template-selector" data-open={String(isOpen)}>
      <button type="button" onClick={onClose}>
        close template selector
      </button>
      <button type="button" onClick={() => onSelect('Daily')}>
        select template
      </button>
    </div>
  )
}))

vi.mock('@/components/note-tree-states', () => ({
  NotesTreeSkeleton: () => <div>loading tree</div>,
  NotesTreeEmpty: ({ onCreateNote, isCreating }: any) => (
    <button type="button" disabled={isCreating} onClick={() => onCreateNote()}>
      empty create
    </button>
  ),
  NotesTreeError: ({ error }: { error: string }) => <div>{error}</div>,
  NotesTreeTruncationNotice: ({ hiddenCount, isLoadingMore, onLoadMore }: any) => (
    <button
      type="button"
      data-testid="truncation-notice"
      disabled={isLoadingMore}
      onClick={onLoadMore}
    >
      hidden:{hiddenCount}
    </button>
  )
}))

vi.mock('@/components/virtualized-notes-tree', () => ({
  VirtualizedNotesTree: ({ actionsRef, ...props }: any) => {
    actionsRef.current = mocks.virtualActions
    const note = mocks.data.notes[0]
    return (
      <div data-testid="virtual-tree" data-drag-disabled={String(props.isDragDisabled)}>
        <button type="button" onClick={() => props.onSelectionChange(['root'])}>
          virtual select
        </button>
        <button type="button" onClick={() => props.onMove('root', 'folder-Work', 0)}>
          virtual move
        </button>
        <button type="button" onClick={props.onBulkDelete}>
          virtual bulk delete
        </button>
        <button type="button" onClick={() => props.onRenameNote(note)}>
          virtual rename note
        </button>
        <button type="button" onClick={() => props.onDeleteNote(note)}>
          virtual delete note
        </button>
        <button type="button" onClick={() => props.onOpenExternal(note)}>
          virtual external
        </button>
        <button type="button" onClick={() => props.onRevealInFinder(note)}>
          virtual reveal finder
        </button>
        <button type="button" onClick={() => props.onDeleteFolder('Work')}>
          virtual delete folder
        </button>
        <button type="button" onClick={() => props.onCreateNote('Work')}>
          virtual create note
        </button>
        <button type="button" onClick={() => props.onCreateFolder('Work')}>
          virtual create folder
        </button>
        <button type="button" onClick={() => props.onRenameFolder('Work')}>
          virtual rename folder
        </button>
        <button type="button" onClick={() => props.onSetFolderTemplate('Work')}>
          virtual set template
        </button>
        <button type="button" onClick={() => props.onClearFolderTemplate('Work')}>
          virtual clear template
        </button>
        <button type="button" onClick={() => props.onSetFolderIcon('Work', 'rocket')}>
          virtual set icon
        </button>
      </div>
    )
  }
}))

const rootNote = {
  id: 'root',
  path: 'notes/Root.md',
  title: 'Root',
  emoji: null,
  localOnly: true
} as any

const nestedNote = {
  id: 'nested',
  path: 'notes/Work/Nested.md',
  title: 'Nested',
  emoji: null
} as any

const createData = () => ({
  isLoading: false,
  error: null,
  notes: [rootNote, nestedNote],
  folders: [{ path: 'Work', icon: 'star' }],
  noteMap: new Map([
    ['root', rootNote],
    ['nested', nestedNote]
  ]),
  tree: {
    folders: [
      {
        path: 'Work',
        name: 'Work',
        icon: 'star',
        children: [
          {
            path: 'Work/Nested',
            name: 'Nested',
            icon: null,
            children: [],
            notes: []
          }
        ],
        notes: [nestedNote]
      }
    ],
    rootNotes: [rootNote]
  },
  notePositions: {},
  setNotePositions: vi.fn(),
  folderTemplateNames: new Map([['Work', 'Daily']]),
  setFolderTemplateNames: vi.fn(),
  createFolder: vi.fn(),
  refreshFolders: vi.fn(),
  setFolderIcon: vi.fn(),
  mutations: {},
  computeTargetFolder: vi.fn((ids: string[]) => `target:${ids.join(',')}`),
  hiddenNoteCount: 0,
  isLoadingMore: false,
  loadMore: vi.fn()
})

const createActions = (overrides: Record<string, unknown> = {}) => ({
  handleCreateNote: vi.fn(),
  handleCreateFolder: vi.fn(),
  handleSelectionChange: vi.fn(),
  handleBulkDelete: vi.fn(),
  handleMove: vi.fn(),
  handleRenameClick: vi.fn(),
  handleOpenExternal: vi.fn(),
  handleRevealInFinder: vi.fn(),
  handleDeleteClick: vi.fn(),
  handleRenameInputChange: vi.fn(),
  handleRenameSubmit: vi.fn(),
  handleRenameCancel: vi.fn(),
  handleCreateNoteInFolder: vi.fn(),
  handleCreateSubfolder: vi.fn(),
  handleSetFolderTemplate: vi.fn(),
  handleClearFolderTemplate: vi.fn(),
  setIconPickerFolderPath: vi.fn(),
  setIconPickerNoteId: vi.fn(),
  handleRenameFolderClick: vi.fn(),
  handleDeleteFolderClick: vi.fn(),
  handleOpenFolderView: vi.fn(),
  setFolderRenameValue: vi.fn(),
  handleFolderRenameSubmit: vi.fn(),
  handleFolderRenameCancel: vi.fn(),
  setIsDeleteDialogOpen: vi.fn(),
  handleDeleteConfirm: vi.fn(),
  handleFolderTemplateSelect: vi.fn(),
  renamingNoteId: null,
  renamingFolderPath: null,
  renameValue: 'Root renamed',
  folderRenameValue: 'Work renamed',
  isRenaming: false,
  isFolderRenaming: false,
  isMoving: false,
  isCreating: false,
  isDeleteDialogOpen: true,
  notesToDelete: [rootNote],
  foldersToDelete: ['Work'],
  isDeleting: false,
  folderToConfigureTemplate: 'Work',
  iconPickerFolderPath: 'Work',
  ...overrides
})

describe('NotesTree isolated coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.data = createData()
    mocks.actions = createActions()
    mocks.lastDeps = null
    mocks.virtualized = false
    Element.prototype.scrollIntoView = mocks.scrollIntoView
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
  })

  it('drives non-virtual actions, folder menus, reveal, and imperative handles', async () => {
    vi.useFakeTimers()
    const ref = createRef<NotesTreeActions>()
    const onTargetFolderChange = vi.fn()

    render(<NotesTree ref={ref} onTargetFolderChange={onTargetFolderChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'select root' }))
    expect(mocks.actions.handleSelectionChange).toHaveBeenCalledWith(['root'])
    expect(onTargetFolderChange).toHaveBeenCalledWith('target:root')

    fireEvent.click(screen.getByRole('button', { name: 'move root' }))
    expect(mocks.actions.handleMove).toHaveBeenCalledWith('root', 'folder-Work', 0)

    const clickAll = (name: RegExp | string) => {
      screen.getAllByRole('button', { name }).forEach((button) => fireEvent.click(button))
    }

    clickAll(/tree.actions.rename/)
    clickAll(/tree.actions.openExternal/)
    clickAll(/tree.actions.revealInFinder/)
    clickAll(/button.delete/)
    expect(mocks.actions.handleRenameClick).toHaveBeenCalledWith(rootNote)
    expect(mocks.actions.handleOpenExternal).toHaveBeenCalledWith(rootNote)
    expect(mocks.actions.handleRevealInFinder).toHaveBeenCalledWith(rootNote)
    expect(mocks.actions.handleDeleteClick).toHaveBeenCalledWith(rootNote)

    clickAll(/tree.actions.newNote/)
    clickAll(/tree.actions.newFolder/)
    clickAll(/tree.actions.setDefaultTemplate/)
    clickAll(/tree.actions.clearDefaultTemplate/)
    clickAll(/tree.actions.setIcon/)
    clickAll(/tree.actions.removeIcon/)
    expect(mocks.actions.handleCreateNoteInFolder).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleCreateSubfolder).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleSetFolderTemplate).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleClearFolderTemplate).toHaveBeenCalledWith('Work')
    expect(mocks.actions.setIconPickerFolderPath).toHaveBeenCalledWith('Work')
    expect(mocks.data.setFolderIcon).toHaveBeenCalledWith('Work', null)
    expect(mocks.actions.handleRenameFolderClick).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleDeleteFolderClick).toHaveBeenCalledWith('Work')

    clickAll('tree.aria.openFolderView')
    fireEvent.click(screen.getAllByRole('button', { name: 'set folder icon' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'open icon picker' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'close icon picker' })[0])
    expect(mocks.actions.handleOpenFolderView).toHaveBeenCalledWith('Work', 'star')
    expect(mocks.data.setFolderIcon).toHaveBeenCalledWith('Work', 'rocket')
    expect(mocks.actions.setIconPickerFolderPath).toHaveBeenCalledWith(null)

    ref.current?.collapseAll()
    ref.current?.expandAll()
    expect(mocks.treeActions.collapseAll).toHaveBeenCalled()
    expect(mocks.treeActions.expandNodes).toHaveBeenCalledWith([
      'folder-Work',
      'folder-Work/Nested'
    ])

    mocks.lastDeps.expandFolderPath('Work/Nested')
    expect(mocks.treeActions.expandNode).toHaveBeenCalledWith('folder-Work')
    expect(mocks.treeActions.expandNode).toHaveBeenCalledWith('folder-Work/Nested')

    act(() => {
      window.dispatchEvent(new CustomEvent('reveal-in-sidebar', { detail: { entityId: 'root' } }))
    })
    await waitFor(() =>
      expect(localStorage.getItem('sidebar-section-collections-expanded')).toBe('true')
    )
    fireEvent.click(screen.getByRole('button', { name: 'reveal pending' }))
    act(() => vi.advanceTimersByTime(100))
    expect(mocks.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    act(() => vi.advanceTimersByTime(2000))

    fireEvent.click(screen.getByRole('button', { name: 'confirm delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'close delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'select template' }))
    fireEvent.click(screen.getByRole('button', { name: 'close template selector' }))
    expect(mocks.actions.handleDeleteConfirm).toHaveBeenCalled()
    expect(mocks.actions.setIsDeleteDialogOpen).toHaveBeenCalledWith(false)
    expect(mocks.actions.handleFolderTemplateSelect).toHaveBeenCalledWith('Daily')
    expect(mocks.actions.handleFolderTemplateSelect).toHaveBeenCalledWith(null)

    vi.useRealTimers()
  })

  it('keeps a reveal for a note the tree has not loaded yet', () => {
    // A note created a moment ago reaches the sidebar only after the list query
    // refetches. Checking `noteMap` here used to drop the request outright,
    // which is what made a brand-new note impossible to reveal.
    render(<NotesTree />)

    act(() => {
      window.dispatchEvent(
        new CustomEvent('reveal-in-sidebar', { detail: { entityId: 'note-just-created' } })
      )
    })

    expect(screen.getByTestId('pending-reveal')).toHaveTextContent('note-just-created')
  })

  it('reveals a folder row action on keyboard focus, not only on hover', () => {
    // The "open folder view" button is in the tab order but painted at
    // `opacity-0` until hover, so a keyboard user landed on a control that was
    // not on screen (WCAG 2.4.7).
    render(<NotesTree />)

    const [openFolderView] = screen.getAllByRole('button', {
      name: 'tree.aria.openFolderView'
    })
    const reveal = openFolderView.parentElement
    expect(reveal).not.toBeNull()

    // Only a bug if the control is reachable by Tab in the first place.
    expect(openFolderView.tabIndex).toBeGreaterThanOrEqual(0)
    expect(isRevealed(reveal!)).toBe(false)

    act(() => openFolderView.focus())

    expect(openFolderView).toHaveFocus()
    expect(isRevealed(reveal!)).toBe(true)
  })

  it('covers inline note and folder rename controls', () => {
    mocks.actions = createActions({
      renamingNoteId: 'root',
      renamingFolderPath: 'Work'
    })

    render(<NotesTree />)

    const noteInput = screen.getByDisplayValue('Root renamed')
    fireEvent.change(noteInput, { target: { value: 'Root v2' } })
    fireEvent.keyDown(noteInput, { key: 'Enter' })
    fireEvent.keyDown(noteInput, { key: 'Escape' })
    fireEvent.blur(noteInput)
    fireEvent.click(noteInput)
    expect(mocks.actions.handleRenameInputChange).toHaveBeenCalledWith('root', 'Root v2')
    expect(mocks.actions.handleRenameSubmit).toHaveBeenCalledWith('root', 'notes/Root.md')
    expect(mocks.actions.handleRenameCancel).toHaveBeenCalledWith('root')

    const folderInput = screen.getByDisplayValue('Work renamed')
    fireEvent.change(folderInput, { target: { value: 'Work v2' } })
    fireEvent.keyDown(folderInput, { key: 'Enter' })
    fireEvent.keyDown(folderInput, { key: 'Escape' })
    fireEvent.blur(folderInput)
    fireEvent.click(folderInput)
    expect(mocks.actions.setFolderRenameValue).toHaveBeenCalledWith('Work v2')
    expect(mocks.actions.handleFolderRenameSubmit).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleFolderRenameCancel).toHaveBeenCalled()
  })

  it('drives the virtualized tree callback surface', () => {
    mocks.virtualized = true
    mocks.actions = createActions({ renamingNoteId: 'root', isMoving: true })
    const ref = createRef<NotesTreeActions>()

    render(<NotesTree ref={ref} />)

    expect(screen.getByTestId('virtual-tree')).toHaveAttribute('data-drag-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'virtual select' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual move' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual bulk delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual rename note' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual delete note' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual external' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual reveal finder' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual delete folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual create note' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual create folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual rename folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual set template' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual clear template' }))
    fireEvent.click(screen.getByRole('button', { name: 'virtual set icon' }))

    expect(mocks.actions.handleSelectionChange).toHaveBeenCalledWith(['root'])
    expect(mocks.actions.handleMove).toHaveBeenCalledWith('root', 'folder-Work', 0)
    expect(mocks.actions.handleBulkDelete).toHaveBeenCalled()
    expect(mocks.actions.handleRenameClick).toHaveBeenCalledWith(rootNote)
    expect(mocks.actions.handleDeleteClick).toHaveBeenCalledWith(rootNote)
    expect(mocks.actions.handleOpenExternal).toHaveBeenCalledWith(rootNote)
    expect(mocks.actions.handleRevealInFinder).toHaveBeenCalledWith(rootNote)
    expect(mocks.actions.handleDeleteFolderClick).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleCreateNoteInFolder).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleCreateSubfolder).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleRenameFolderClick).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleSetFolderTemplate).toHaveBeenCalledWith('Work')
    expect(mocks.actions.handleClearFolderTemplate).toHaveBeenCalledWith('Work')
    expect(mocks.data.setFolderIcon).toHaveBeenCalledWith('Work', 'rocket')

    ref.current?.collapseAll()
    ref.current?.expandAll()
    mocks.lastDeps.expandFolderPath('Work/Nested')
    expect(mocks.virtualActions.collapseAll).toHaveBeenCalled()
    expect(mocks.virtualActions.expandAll).toHaveBeenCalled()
    expect(mocks.virtualActions.expandNode).toHaveBeenCalledWith('folder-Work/Nested')
  })

  it('surfaces the truncation footer only when notes are missing from the page', () => {
    const { unmount } = render(<NotesTree />)
    expect(screen.queryByTestId('truncation-notice')).toBeNull()
    unmount()

    mocks.data = { ...createData(), hiddenNoteCount: 500 }
    render(<NotesTree />)

    const notice = screen.getByTestId('truncation-notice')
    expect(notice).toHaveTextContent('hidden:500')
    fireEvent.click(notice)
    expect(mocks.data.loadMore).toHaveBeenCalled()
  })
})
