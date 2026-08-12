import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineQuickFile } from './inline-quick-file'
import { LinkPreview } from './inbox-detail/link-preview'
import {
  FolderRevealHandler,
  RevealHandler,
  TreeActionsExposer,
  TreeFolderIcon
} from './note-tree-internal'
import { QuickFileDropdown, getFilteredFolders } from './quick-file-dropdown'
import { TabBarAction } from './tabs/tab-bar-action'
import { TabContextMenu } from './tabs/tab-context-menu'
import { TabDragProvider } from './tabs/tab-drag-provider'
import type { Tab } from '@/contexts/tabs/types'

const mocks = vi.hoisted(() => ({
  closeAllTabs: vi.fn(),
  closeOtherTabs: vi.fn(),
  closeTab: vi.fn(),
  closeTabsToRight: vi.fn(),
  dispatch: vi.fn(),
  dragMonitor: null as null | Record<string, (event?: any) => void>,
  expandAll: vi.fn(),
  expandNode: vi.fn(),
  expandNodes: vi.fn(),
  collapseAll: vi.fn(),
  setActiveTab: vi.fn(),
  toggleExpanded: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@dnd-kit/core', () => ({
  DragOverlay: ({ children }: { children: ReactNode }) => (
    <div data-testid="drag-overlay">{children}</div>
  ),
  useDndMonitor: (callbacks: Record<string, (event?: any) => void>) => {
    mocks.dragMonitor = callbacks
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/kibo-ui/tree', () => ({
  useTree: () => ({
    expandedIds: new Set(['folder-work']),
    toggleExpanded: mocks.toggleExpanded,
    expandNode: mocks.expandNode,
    expandNodes: mocks.expandNodes,
    expandAll: mocks.expandAll,
    collapseAll: mocks.collapseAll
  })
}))

vi.mock('@/components/folder-icon-button', () => ({
  FolderIconButton: ({ isExpanded, hasChildren, onToggleExpand }: any) => (
    <button type="button" onClick={onToggleExpand}>
      folder {String(isExpanded)} {String(hasChildren)}
    </button>
  )
}))

vi.mock('@/components/note/note-breadcrumb', () => ({
  SIDEBAR_REVEAL_FOLDER_EVENT: 'memry:reveal-folder'
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => {
    const createTab = (overrides: Record<string, unknown> = {}) => ({
      id: 'tab-1',
      type: 'note',
      title: 'Tab',
      path: '/Notes/Tab',
      entityId: 'note-1',
      icon: 'file-text',
      emoji: undefined,
      isPinned: false,
      isPreview: false,
      isModified: false,
      isDeleted: false,
      createdAt: 1,
      lastAccessedAt: 1,
      ...overrides
    })
    return {
      state: {
        activeGroupId: 'group-1',
        tabGroups: {
          'group-1': {
            id: 'group-1',
            activeTabId: 'tab-1',
            tabs: [
              createTab({ id: 'tab-1', title: 'Pinned', isPinned: true, isModified: true }),
              createTab({ id: 'tab-2', title: 'Regular', isPreview: false }),
              createTab({ id: 'tab-3', title: 'Other' })
            ]
          },
          'group-2': {
            id: 'group-2',
            activeTabId: 'tab-4',
            tabs: [createTab({ id: 'tab-4', title: 'Target' })]
          }
        }
      },
      setActiveTab: mocks.setActiveTab,
      closeTab: mocks.closeTab,
      closeOtherTabs: mocks.closeOtherTabs,
      closeTabsToRight: mocks.closeTabsToRight,
      closeAllTabs: mocks.closeAllTabs,
      dispatch: mocks.dispatch
    }
  },
  useTabGroup: (groupId: string) => {
    const createTab = (overrides: Record<string, unknown> = {}) => ({
      id: 'tab-1',
      type: 'note',
      title: 'Tab',
      path: '/Notes/Tab',
      entityId: 'note-1',
      icon: 'file-text',
      emoji: undefined,
      isPinned: false,
      isPreview: false,
      isModified: false,
      isDeleted: false,
      createdAt: 1,
      lastAccessedAt: 1,
      ...overrides
    })
    return {
      id: groupId,
      activeTabId: 'tab-1',
      tabs:
        groupId === 'group-1'
          ? [
              createTab({ id: 'tab-1', title: 'Pinned', isPinned: true, isModified: true }),
              createTab({ id: 'tab-2', title: 'Regular', isPreview: false }),
              createTab({ id: 'tab-3', title: 'Other' })
            ]
          : []
    }
  },
  useTabSettings: () => ({ tabCloseButton: 'always' })
}))

function tab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    type: 'note',
    title: 'Tab',
    path: '/Notes/Tab',
    entityId: 'note-1',
    icon: 'file-text',
    emoji: undefined,
    isPinned: false,
    isPreview: false,
    isModified: false,
    isDeleted: false,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    ...overrides
  }
}

const folders = [
  { id: 'folder-1', name: 'Work', path: 'Work/Plans' },
  { id: 'folder-2', name: 'Home', path: 'Home' },
  { id: 'folder-3', name: 'Writing', path: 'Archive/Writing' }
] as any[]

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mocks.dragMonitor = null
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) }
  })
  window.api.showContextMenu = vi.fn().mockResolvedValue(null)
})

describe('cold renderer component smoke coverage', () => {
  it('drives inline quick file and dropdown keyboard paths', () => {
    const onQueryChange = vi.fn()
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    const onArrowDown = vi.fn()
    const onArrowUp = vi.fn()
    const onFolderSelect = vi.fn()

    render(
      <InlineQuickFile
        query="wo"
        onQueryChange={onQueryChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onArrowDown={onArrowDown}
        onArrowUp={onArrowUp}
        filteredFolders={folders}
        onFolderSelect={onFolderSelect}
      />
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'work' } })
    expect(onQueryChange).toHaveBeenCalledWith('work')
    fireEvent.keyDown(input, { key: '1' })
    expect(onFolderSelect).toHaveBeenCalledWith(folders[0])
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(onSubmit).toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
    expect(onArrowDown).toHaveBeenCalled()
    expect(onArrowUp).toHaveBeenCalled()

    const { rerender } = render(
      <QuickFileDropdown
        folders={folders}
        query="wr"
        highlightedIndex={0}
        onSelect={onFolderSelect}
      />
    )
    fireEvent.click(screen.getByRole('option', { name: /Archive\/Writing/ }))
    fireEvent.keyDown(screen.getByRole('option', { name: /Archive\/Writing/ }), { key: 'Enter' })
    expect(onFolderSelect).toHaveBeenCalledWith(folders[2])
    expect(getFilteredFolders(folders, 'home')).toEqual([folders[1]])

    rerender(
      <QuickFileDropdown
        folders={folders}
        query=""
        highlightedIndex={0}
        onSelect={onFolderSelect}
      />
    )
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    rerender(
      <QuickFileDropdown
        folders={folders}
        query="zzz"
        highlightedIndex={0}
        onSelect={onFolderSelect}
      />
    )
    expect(screen.getByText(/noFoldersMatch/)).toBeInTheDocument()
  })

  it('renders link preview image, fallback, and YouTube play states', () => {
    const item = {
      id: 'inbox-1',
      title: 'Video',
      content: 'Fallback excerpt',
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      thumbnailUrl: 'https://example.com/hero.png',
      metadata: { description: 'Description', favicon: 'https://example.com/favicon.ico' }
    } as any

    const { container, rerender } = render(<LinkPreview item={item} />)
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByText('Video')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTitle('Video')).toHaveAttribute(
      'src',
      expect.stringContaining('youtube-nocookie')
    )

    rerender(
      <LinkPreview
        item={{
          ...item,
          sourceUrl: 'https://example.com/article',
          thumbnailUrl: null,
          metadata: { logo: 'https://example.com/logo.png', excerpt: 'Excerpt' }
        }}
      />
    )
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/article')
  })

  it('bridges note tree icon, reveal, folder reveal, and action exposer helpers', async () => {
    vi.useFakeTimers()
    render(<TreeFolderIcon nodeId="folder-work" hasChildren />)
    fireEvent.click(screen.getByRole('button', { name: /folder true true/ }))
    expect(mocks.toggleExpanded).toHaveBeenCalledWith('folder-work')

    const onReveal = vi.fn()
    const onClear = vi.fn()
    const noteMap = new Map([['note-1', { path: '/Work/Plans/Alpha' }]])
    render(
      <RevealHandler
        pendingRevealNoteId="note-1"
        noteMap={noteMap}
        onReveal={onReveal}
        onClear={onClear}
      />
    )
    expect(mocks.expandNode).toHaveBeenCalledWith('folder-Work')
    expect(mocks.expandNode).toHaveBeenCalledWith('folder-Work/Plans')
    act(() => vi.advanceTimersByTime(50))
    expect(onReveal).toHaveBeenCalledWith('note-1')

    render(
      <RevealHandler
        pendingRevealNoteId="missing"
        noteMap={noteMap}
        onReveal={onReveal}
        onClear={onClear}
      />
    )
    expect(onClear).toHaveBeenCalled()

    const target = document.createElement('div')
    target.dataset.treeNodeId = 'folder-Work/Plans'
    document.body.append(target)
    render(<FolderRevealHandler />)
    window.dispatchEvent(
      new CustomEvent('memry:reveal-folder', { detail: { folderPath: 'Work/Plans' } })
    )
    act(() => vi.advanceTimersByTime(100))
    expect(target.scrollIntoView).toHaveBeenCalled()

    const ref = createRef<{
      collapseAll: () => void
      expandAll: () => void
      expandNode: (id: string) => void
      expandNodes: (ids: string[]) => void
    }>()
    const exposer = render(<TreeActionsExposer actionsRef={ref} />)
    ref.current?.collapseAll()
    ref.current?.expandAll()
    ref.current?.expandNode('folder-home')
    ref.current?.expandNodes(['folder-a'])
    expect(mocks.collapseAll).toHaveBeenCalled()
    expect(mocks.expandAll).toHaveBeenCalled()
    expect(mocks.expandNode).toHaveBeenCalledWith('folder-home')
    expect(mocks.expandNodes).toHaveBeenCalledWith(['folder-a'])
    exposer.unmount()
    expect(ref.current).toBeNull()
  })

  it('covers action button, context menu actions, and drag provider dispatches', async () => {
    const onClick = vi.fn()
    render(<TabBarAction icon={<span>*</span>} tooltip="Run" onClick={onClick} isActive />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(onClick).toHaveBeenCalled()

    const menuTab = tab({
      id: 'tab-2',
      title: 'Regular',
      path: '/Work/Regular',
      entityId: 'note-2'
    })
    const selectedIds = [
      'close',
      'close-others',
      'close-right',
      'close-all',
      'pin',
      'duplicate',
      'split-right',
      'split-down',
      'copy-path',
      'reveal'
    ]
    window.api.showContextMenu = vi.fn()
    for (const id of selectedIds) {
      vi.mocked(window.api.showContextMenu).mockResolvedValueOnce(id)
      render(
        <TabContextMenu tab={menuTab} groupId="group-1">
          <button type="button">tab menu {id}</button>
        </TabContextMenu>
      )
      fireEvent.contextMenu(screen.getByRole('button', { name: `tab menu ${id}` }))
      await waitFor(() => expect(window.api.showContextMenu).toHaveBeenCalled())
    }
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-2', 'group-1')
    expect(mocks.closeOtherTabs).toHaveBeenCalledWith('tab-2', 'group-1')
    expect(mocks.closeTabsToRight).toHaveBeenCalledWith('tab-2', 'group-1')
    expect(mocks.closeAllTabs).toHaveBeenCalledWith('group-1')
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'PIN_TAB',
      payload: { tabId: 'tab-2', groupId: 'group-1' }
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/Work/Regular')

    render(
      <TabDragProvider>
        <div>children</div>
      </TabDragProvider>
    )
    act(() =>
      mocks.dragMonitor?.onDragStart?.({
        active: { id: 'tab-2', data: { current: { type: 'tab', groupId: 'group-1' } } }
      })
    )
    expect(screen.getByTestId('drag-overlay')).toHaveTextContent('Regular')
    act(() =>
      mocks.dragMonitor?.onDragEnd?.({
        active: { id: 'tab-2', data: { current: { type: 'tab', groupId: 'group-1' } } },
        over: { id: 'tab-4', data: { current: { groupId: 'group-2' } } }
      })
    )
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'MOVE_TAB',
      payload: { tabId: 'tab-2', fromGroupId: 'group-1', toGroupId: 'group-2', toIndex: 1 }
    })
    act(() =>
      mocks.dragMonitor?.onDragEnd?.({
        active: { id: 'tab-2', data: { current: { type: 'tab', groupId: 'group-1' } } },
        over: { id: 'tab-3', data: { current: { groupId: 'group-1' } } }
      })
    )
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'REORDER_TABS',
      payload: { groupId: 'group-1', fromIndex: 1, toIndex: 2 }
    })
    act(() => mocks.dragMonitor?.onDragCancel?.())
  })
})
