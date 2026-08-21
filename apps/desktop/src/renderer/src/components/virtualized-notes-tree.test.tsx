import type React from 'react'
import { createRef } from 'react'
import { act, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  VirtualizedNotesTree,
  type VirtualizedTreeActions,
  type MoveOperation
} from './virtualized-notes-tree'
import type { TreeStructure } from '@/lib/virtualized-tree-utils'
import { isRevealed } from '@tests/utils/reveal'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  scrollToIndex: vi.fn(),
  openPagesInNewTab: true
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { openPagesInNewTab: mocks.openPagesInNewTab }
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    state: {
      tabGroups: { 'pane-1': { id: 'pane-1', tabs: [], activeTabId: null } },
      layout: { type: 'leaf', tabGroupId: 'pane-1' },
      activeGroupId: 'pane-1'
    }
  }),
  useTabActions: () => ({ openTab: mocks.openTab })
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 28,
        size: 28
      })),
    getTotalSize: () => count * 28,
    scrollToIndex: mocks.scrollToIndex
  })
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />
}))

vi.mock('@/components/folder-icon-button', () => ({
  FolderIconButton: ({
    icon,
    onToggleExpand,
    onIconChange
  }: {
    icon: string | null
    onToggleExpand: () => void
    onIconChange: (icon: string | null) => void
  }) => (
    <button
      type="button"
      aria-label="folder icon"
      onClick={(event) => {
        event.stopPropagation()
        onToggleExpand()
        onIconChange(icon ? null : 'folder')
      }}
    >
      {icon ?? 'folder'}
    </button>
  )
}))

vi.mock('@/components/icon-picker-button', () => ({
  IconPickerButton: ({
    children,
    hasIcon,
    onIconChange,
    ariaLabel
  }: {
    children: React.ReactNode
    hasIcon: boolean
    onIconChange: (icon: string | null) => void
    ariaLabel: string
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation()
        onIconChange(hasIcon ? null : 'icon:Star')
      }}
    >
      {children}
    </button>
  )
}))

const note = (id: string, path: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    title:
      path
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') ?? id,
    path,
    fileType: 'markdown',
    emoji: null,
    tags: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides
  }) as any

// Vault-relative, matching the folder paths in `tree` below — the same shape
// `buildTreeFromNotes` produces. A fabricated `notes/` prefix here is what let
// a reveal that stripped the first segment look correct in tests while it left
// the folder shut in the app.
const workNote = note('note-work', 'Work/Alpha.md', { emoji: '*' })
const rootNote = note('note-root', 'Root.pdf', { fileType: 'pdf' })

const tree: TreeStructure = {
  folders: [
    {
      name: 'Work',
      path: 'Work',
      icon: null,
      children: [],
      notes: [workNote]
    }
  ],
  rootNotes: [rootNote]
}

const iconTree: TreeStructure = {
  folders: [
    {
      name: 'Work',
      path: 'Work',
      icon: 'briefcase',
      children: [],
      notes: [workNote]
    }
  ],
  rootNotes: [rootNote]
}

const noteMap = new Map([
  [workNote.id, workNote],
  [rootNote.id, rootNote]
])

// A folder with nothing in it yet — the shape a user gets straight out of "New
// folder", and the one that used to refuse every drop.
const emptyFolderTree: TreeStructure = {
  folders: [
    { name: 'Work', path: 'Work', icon: null, children: [], notes: [workNote] },
    { name: 'Archive', path: 'Archive', icon: null, children: [], notes: [] }
  ],
  rootNotes: [rootNote]
}

const ROW_HEIGHT = 28

const stubRowRect = (row: HTMLElement) => {
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 100,
        bottom: ROW_HEIGHT,
        width: 100,
        height: ROW_HEIGHT,
        toJSON: () => ({})
      }) as DOMRect
  })
}

/**
 * jsdom's `DragEvent` drops mouse coordinates, so `fireEvent.dragOver(row, {
 * clientY })` hands the tree `undefined` — every geometry comparison then fails
 * and whatever the row falls back to wins, which is how a test can "pass" while
 * proving nothing about the drop bands. Set the coordinate on the event itself.
 */
const dragOverAt = (row: HTMLElement, clientY: number, dataTransfer: unknown) => {
  const event = createEvent.dragOver(row, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(row, event)
}

const renderTree = (overrides: Partial<React.ComponentProps<typeof VirtualizedNotesTree>> = {}) => {
  const props: React.ComponentProps<typeof VirtualizedNotesTree> = {
    tree,
    selectedIds: [],
    onSelectionChange: vi.fn(),
    noteMap,
    onMove: vi.fn(),
    onBulkDelete: vi.fn(),
    onRenameNote: vi.fn(),
    onDeleteNote: vi.fn(),
    onOpenExternal: vi.fn(),
    onRevealInFinder: vi.fn(),
    onCreateNote: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onSetFolderTemplate: vi.fn(),
    onClearFolderTemplate: vi.fn(),
    onSetFolderIcon: vi.fn(),
    onSetNoteIcon: vi.fn(),
    folderTemplateNames: new Map([['Work', 'Daily']]),
    ...overrides
  }

  render(<VirtualizedNotesTree {...props} />)
  return props
}

describe('VirtualizedNotesTree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openPagesInNewTab = true
    localStorage.clear()
    localStorage.setItem('sidebar-tree-expanded', JSON.stringify(['folder-Work']))
  })

  it('renders expanded folders, selects notes, and opens permanent tabs', async () => {
    const user = userEvent.setup()
    const props = renderTree()

    expect(screen.getByRole('tree')).toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    await user.click(screen.getByText('Alpha'))
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(['note-work'])
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityId: 'note-work',
        isPreview: false,
        type: 'note'
      })
    )

    fireEvent.doubleClick(screen.getByText('Alpha'))
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityId: 'note-work',
        isPreview: false,
        type: 'note'
      })
    )

    await user.click(screen.getByText('Root'))
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityId: 'note-root',
        isPreview: false,
        type: 'file'
      })
    )
  })

  // #1644 — the virtualized tree opens tabs itself, so it must honour the
  // preference the non-virtualized tree gets through useNoteTreeActions.
  it('asks the reducer to reuse the active tab when new-tab opening is off', async () => {
    mocks.openPagesInNewTab = false
    const user = userEvent.setup()
    renderTree()

    await user.click(screen.getByText('Alpha'))
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityId: 'note-work', type: 'note' }),
      { reuseActiveTab: true }
    )

    await user.click(screen.getByRole('button', { name: 'Open folder view' }))
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'folder', entityId: 'Work' }),
      { reuseActiveTab: true }
    )
  })

  // Middle-click is an explicit gesture: always a new background tab, even
  // with the preference set to reuse.
  it('middle-click opens rows in a background tab regardless of the preference', () => {
    mocks.openPagesInNewTab = false
    renderTree()

    fireEvent.mouseDown(screen.getByText('Alpha'), { button: 1 })
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityId: 'note-work', type: 'note' }),
      { forceNew: true, background: true }
    )

    fireEvent.mouseDown(screen.getByText('Work'), { button: 1 })
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'folder', entityId: 'Work' }),
      { forceNew: true, background: true }
    )
  })

  it('reveals a folder row action on keyboard focus, not only on hover', () => {
    // Same defect as the non-virtual tree: the button is in the tab order but
    // painted at `opacity-0` until hover (WCAG 2.4.7).
    renderTree()

    const openFolderView = screen.getByRole('button', { name: 'Open folder view' })
    const reveal = openFolderView.parentElement
    expect(reveal).not.toBeNull()

    expect(openFolderView.tabIndex).toBeGreaterThanOrEqual(0)
    expect(isRevealed(reveal!)).toBe(false)

    act(() => openFolderView.focus())

    expect(openFolderView).toHaveFocus()
    expect(isRevealed(reveal!)).toBe(true)
  })

  it('supports folder actions, imperative expansion, and bulk delete keyboard shortcuts', async () => {
    const user = userEvent.setup()
    const actionsRef = createRef<VirtualizedTreeActions | null>()
    const props = renderTree({ selectedIds: ['note-work', 'note-root'], actionsRef })

    await user.click(screen.getByRole('button', { name: /open folder view/i }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'folder',
        entityId: 'Work'
      })
    )

    await user.click(screen.getByRole('button', { name: 'folder icon' }))
    expect(props.onSetFolderIcon).toHaveBeenCalledWith('Work', 'folder')

    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Delete' })
    expect(props.onBulkDelete).toHaveBeenCalledTimes(1)

    act(() => actionsRef.current?.collapseAll())
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    act(() => actionsRef.current?.expandAll())
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('reveals a note by opening its folders and scrolling its row into view', async () => {
    const actionsRef = createRef<VirtualizedTreeActions | null>()
    renderTree({ actionsRef })

    act(() => actionsRef.current?.collapseAll())
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    act(() => actionsRef.current?.revealNote('note-work'))

    // The folder holding it is open, and the virtualizer — not scrollIntoView —
    // does the scrolling, because the row may not have been mounted at all.
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(mocks.scrollToIndex).toHaveBeenCalledWith(1, { align: 'center' })
  })

  it('does not scroll for a note the tree does not have', async () => {
    const actionsRef = createRef<VirtualizedTreeActions | null>()
    renderTree({ actionsRef })

    act(() => actionsRef.current?.revealNote('note-missing'))

    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(mocks.scrollToIndex).not.toHaveBeenCalled()
  })

  it('emits range selections and drag move operations', () => {
    const onMove = vi.fn<(operation: MoveOperation) => void>()
    const props = renderTree({ onMove })

    fireEvent.click(screen.getByText('Alpha'))
    fireEvent.click(screen.getByText('Root'), { shiftKey: true })
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(['note-work', 'note-root'])

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      // A real DataTransfer always exposes `types`; the tree reads it to tell an
      // internal reorder from a file dragged in from the OS.
      types: [] as string[],
      setData: vi.fn(),
      getData: vi.fn()
    }
    const source = screen.getByText('Alpha').closest('[role="treeitem"]') as HTMLElement
    const target = screen.getByText('Root').closest('[role="treeitem"]') as HTMLElement

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 30,
      width: 100,
      height: 30,
      toJSON: () => ({})
    } as DOMRect)

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { dataTransfer, clientY: 28 })
    fireEvent.drop(target, { dataTransfer })

    expect(onMove).toHaveBeenCalledWith({
      draggedId: 'note-work',
      targetId: 'note-root',
      position: 'after'
    })
  })

  it('runs folder and note keyboard plus context-menu actions', async () => {
    const user = userEvent.setup()
    const props = renderTree({ tree: iconTree, selectedIds: ['note-work'] })

    const folderRow = screen.getByText('Work').closest('[role="treeitem"]') as HTMLElement
    fireEvent.keyDown(folderRow, { key: ' ' })
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    fireEvent.keyDown(folderRow, { key: 'Enter' })
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    const noteRow = screen.getByText('Alpha').closest('[role="treeitem"]') as HTMLElement
    fireEvent.keyDown(noteRow, { key: 'Enter' })
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityId: 'note-work',
        isPreview: false
      })
    )

    await user.click(screen.getByRole('button', { name: 'New Note' }))
    expect(props.onCreateNote).toHaveBeenCalledWith('Work')

    await user.click(screen.getByRole('button', { name: 'New Folder' }))
    expect(props.onCreateFolder).toHaveBeenCalledWith('Work')

    await user.click(screen.getByRole('button', { name: /Set Default Template/ }))
    expect(props.onSetFolderTemplate).toHaveBeenCalledWith('Work')

    await user.click(screen.getByRole('button', { name: 'Clear Default Template' }))
    expect(props.onClearFolderTemplate).toHaveBeenCalledWith('Work')

    const removeIconButtons = screen.getAllByRole('button', { name: 'Remove Icon' })
    await user.click(removeIconButtons[0])
    expect(props.onSetFolderIcon).toHaveBeenCalledWith('Work', null)
    await user.click(removeIconButtons[1])
    expect(props.onSetNoteIcon).toHaveBeenCalledWith('note-work', null)

    const renameButtons = screen.getAllByRole('button', { name: 'Rename' })
    await user.click(renameButtons[0])
    expect(props.onRenameFolder).toHaveBeenCalledWith('Work')
    await user.click(renameButtons[1])
    expect(props.onRenameNote).toHaveBeenCalledWith(workNote)

    await user.click(screen.getAllByRole('button', { name: 'Open in External Editor' })[0])
    expect(props.onOpenExternal).toHaveBeenCalledWith(workNote)

    await user.click(screen.getAllByRole('button', { name: 'Reveal in Finder' })[0])
    expect(props.onRevealInFinder).toHaveBeenCalledWith(workNote)

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' })
    await user.click(deleteButtons[0])
    expect(props.onDeleteFolder).toHaveBeenCalledWith('Work')
    await user.click(deleteButtons[1])
    expect(props.onDeleteNote).toHaveBeenCalledWith(workNote)
  })

  it('changes a note icon from its inline icon button', async () => {
    const user = userEvent.setup()
    const props = renderTree({ tree: iconTree, selectedIds: ['note-work'] })

    const noteRow = screen.getByText('Alpha').closest('[role="treeitem"]') as HTMLElement
    // workNote has an emoji, so the icon button reports hasIcon and clears it on click
    await user.click(within(noteRow).getByRole('button', { name: 'Set Icon' }))
    expect(props.onSetNoteIcon).toHaveBeenCalledWith('note-work', null)
  })

  it('handles storage failures and disabled drag without moving items', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked')
    })
    const onMove = vi.fn<(operation: MoveOperation) => void>()
    const props = renderTree({ isDragDisabled: true, onMove })

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      // A real DataTransfer always exposes `types`; the tree reads it to tell an
      // internal reorder from a file dragged in from the OS.
      types: [] as string[],
      setData: vi.fn(),
      getData: vi.fn()
    }
    const source = screen.getByText('Work').closest('[role="treeitem"]') as HTMLElement
    const target = screen.getByText('Root').closest('[role="treeitem"]') as HTMLElement

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(target, { dataTransfer, clientY: 15 })
    fireEvent.drop(target, { dataTransfer })
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Backspace' })

    expect(dataTransfer.setData).not.toHaveBeenCalled()
    expect(onMove).not.toHaveBeenCalled()
    expect(props.onBulkDelete).not.toHaveBeenCalled()

    getItemSpy.mockRestore()
    setItemSpy.mockRestore()
  })

  it('drops a folder inside an empty folder, which has no children to infer it from', () => {
    const onMove = vi.fn<(operation: MoveOperation) => void>()
    renderTree({ tree: emptyFolderTree, onMove })

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      types: [] as string[],
      setData: vi.fn(),
      getData: vi.fn()
    }
    const source = screen.getByText('Work').closest('[role="treeitem"]') as HTMLElement
    const target = screen.getByText('Archive').closest('[role="treeitem"]') as HTMLElement
    stubRowRect(target)

    fireEvent.dragStart(source, { dataTransfer })
    dragOverAt(target, ROW_HEIGHT / 2, dataTransfer)
    fireEvent.drop(target, { dataTransfer })

    expect(onMove).toHaveBeenCalledWith({
      draggedId: 'folder-Work',
      targetId: 'folder-Archive',
      position: 'inside'
    })
  })

  it('keeps the reorder bands at the edges of a folder row and off a note row', () => {
    const onMove = vi.fn<(operation: MoveOperation) => void>()
    renderTree({ tree: emptyFolderTree, onMove })

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      types: [] as string[],
      setData: vi.fn(),
      getData: vi.fn()
    }
    const source = screen.getByText('Work').closest('[role="treeitem"]') as HTMLElement
    const folderTarget = screen.getByText('Archive').closest('[role="treeitem"]') as HTMLElement
    const noteTarget = screen.getByText('Root').closest('[role="treeitem"]') as HTMLElement
    stubRowRect(folderTarget)
    stubRowRect(noteTarget)

    fireEvent.dragStart(source, { dataTransfer })
    dragOverAt(folderTarget, 1, dataTransfer)
    fireEvent.drop(folderTarget, { dataTransfer })
    expect(onMove).toHaveBeenLastCalledWith({
      draggedId: 'folder-Work',
      targetId: 'folder-Archive',
      position: 'before'
    })

    fireEvent.dragStart(source, { dataTransfer })
    dragOverAt(folderTarget, ROW_HEIGHT - 1, dataTransfer)
    fireEvent.drop(folderTarget, { dataTransfer })
    expect(onMove).toHaveBeenLastCalledWith({
      draggedId: 'folder-Work',
      targetId: 'folder-Archive',
      position: 'after'
    })

    // A note takes no children, so its middle is a reorder, never an "inside".
    fireEvent.dragStart(source, { dataTransfer })
    dragOverAt(noteTarget, ROW_HEIGHT / 2, dataTransfer)
    fireEvent.drop(noteTarget, { dataTransfer })
    expect(onMove).toHaveBeenLastCalledWith({
      draggedId: 'folder-Work',
      targetId: 'note-root',
      position: 'after'
    })
  })

  it('handles external scroll, imperative node expansion, ctrl selection, and folder drop edges', () => {
    const observed: Element[] = []
    class ResizeObserverStub {
      observe = vi.fn((element: Element) => {
        observed.push(element)
      })
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const externalScroll = document.createElement('div')
    Object.defineProperty(externalScroll, 'scrollTop', { configurable: true, value: 12 })
    vi.spyOn(externalScroll, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 10,
      left: 0,
      right: 100,
      bottom: 110,
      width: 100,
      height: 100,
      toJSON: () => ({})
    } as DOMRect)

    const actionsRef = createRef<VirtualizedTreeActions | null>()
    const onMove = vi.fn<(operation: MoveOperation) => void>()
    const props = renderTree({
      actionsRef,
      onMove,
      selectedIds: ['note-work'],
      scrollContainerRef: { current: externalScroll }
    })

    expect(observed.length).toBeGreaterThan(0)

    act(() => actionsRef.current?.expandNodes([]))
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

    act(() => actionsRef.current?.expandNode('folder-Work'))
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Root'), { ctrlKey: true })
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(['note-work', 'note-root'])

    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      // A real DataTransfer always exposes `types`; the tree reads it to tell an
      // internal reorder from a file dragged in from the OS.
      types: [] as string[],
      setData: vi.fn(),
      getData: vi.fn()
    }
    const source = screen.getByText('Root').closest('[role="treeitem"]') as HTMLElement
    const folderTarget = screen.getByText('Work').closest('[role="treeitem"]') as HTMLElement
    let folderRect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 300,
      width: 100,
      height: 300,
      toJSON: () => ({})
    } as DOMRect
    Object.defineProperty(folderTarget, 'getBoundingClientRect', {
      configurable: true,
      value: () => folderRect
    })

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(folderTarget, { dataTransfer, clientY: 1 })
    fireEvent.drop(folderTarget, { dataTransfer })
    expect(onMove).toHaveBeenCalledWith({
      draggedId: 'note-root',
      targetId: 'folder-Work',
      position: 'inside'
    })

    fireEvent.dragStart(source, { dataTransfer })
    fireEvent.dragOver(folderTarget, { dataTransfer, clientY: 15 })
    fireEvent.dragLeave(folderTarget, { relatedTarget: document.body })
    fireEvent.dragEnd(source)

    rafSpy.mockRestore()
    cancelSpy.mockRestore()
  })
  describe('Finder-style arrow navigation', () => {
    const row = (label: string) =>
      screen.getByText(label).closest('[role="treeitem"]') as HTMLElement

    it('walks down and up the visible rows, selecting as it goes', () => {
      const props = renderTree()

      const work = row('Work')
      work.focus()

      fireEvent.keyDown(work, { key: 'ArrowDown' })
      expect(props.onSelectionChange).toHaveBeenLastCalledWith(['note-work'])
      expect(row('Alpha')).toHaveFocus()

      fireEvent.keyDown(row('Alpha'), { key: 'ArrowUp' })
      expect(props.onSelectionChange).toHaveBeenLastCalledWith(['folder-Work'])
      expect(row('Work')).toHaveFocus()
    })

    it('opens a closed folder with Right and closes it with Left', () => {
      localStorage.setItem('sidebar-tree-expanded', JSON.stringify([]))
      renderTree()

      expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

      fireEvent.keyDown(row('Work'), { key: 'ArrowRight' })
      expect(screen.getByText('Alpha')).toBeInTheDocument()

      // Second Right steps into the folder rather than reopening it.
      fireEvent.keyDown(row('Work'), { key: 'ArrowRight' })
      expect(row('Alpha')).toHaveFocus()

      fireEvent.keyDown(row('Work'), { key: 'ArrowLeft' })
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    })

    it('walks Left out of a child onto its folder', () => {
      const props = renderTree()

      fireEvent.keyDown(row('Alpha'), { key: 'ArrowLeft' })
      expect(props.onSelectionChange).toHaveBeenLastCalledWith(['folder-Work'])
      expect(row('Work')).toHaveFocus()
    })

    /**
     * The flow that reported this: right-click a row, dismiss the menu, then
     * press an arrow. Focus is on the row because the row claims it on
     * contextmenu — without that the keystroke reached the scroll container and
     * only scrolled the sidebar.
     */
    it('navigates from the row a right-click landed on', () => {
      const props = renderTree()

      fireEvent.contextMenu(row('Work'))
      expect(row('Work')).toHaveFocus()

      fireEvent.keyDown(row('Work'), { key: 'ArrowDown' })
      expect(props.onSelectionChange).toHaveBeenLastCalledWith(['note-work'])
    })

    it('falls back to the selection when the keystroke misses every row', () => {
      const props = renderTree({ selectedIds: ['folder-Work'] })

      fireEvent.keyDown(screen.getByRole('tree'), { key: 'ArrowDown' })
      expect(props.onSelectionChange).toHaveBeenLastCalledWith(['note-work'])
    })

    it('leaves the arrows to an inline rename input', () => {
      const props = renderTree({
        renamingFolderPath: 'Work',
        folderRenameValue: 'Work'
      })

      const input = screen.getByDisplayValue('Work')
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(props.onSelectionChange).not.toHaveBeenCalled()
    })

    it('ignores an arrow with no row to move to', () => {
      const props = renderTree()

      fireEvent.keyDown(row('Work'), { key: 'ArrowUp' })
      fireEvent.keyDown(row('Root'), { key: 'ArrowDown' })
      fireEvent.keyDown(row('Root'), { key: 'ArrowRight' })
      fireEvent.keyDown(row('Root'), { key: 'ArrowLeft' })
      expect(props.onSelectionChange).not.toHaveBeenCalled()
    })
  })
})
