import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FilterRow } from './folder-view/filter-row'
import { VaultSwitcher } from './vault-switcher'
import { TemplateSelector } from './note/template-selector'
import { OutlineEdge } from './note/outline-edge'
import { TaskCreationPopover } from './note/content-area/task-block/task-creation-popover'
import { useTaskBlockData } from './note/content-area/task-block/use-task-block-data'
import { TagAutocomplete, type TagAutocompleteRef } from './journal/extensions/tag/tag-autocomplete'
import {
  WikiLinkAutocomplete,
  type WikiLinkAutocompleteRef
} from './journal/extensions/wiki-link/wiki-link-autocomplete'
import { TaskGroup, StatusTaskGroup } from './tasks/task-group'
import { TodayTaskRow } from './tasks/today-task-row'
import { SubtaskRow } from './tasks/subtask-row'
import { ParentTaskRow } from './tasks/parent-task-row'
import { TabBarWithDrag } from './tabs/tab-bar-with-drag'
import { SidebarBookmarkList } from './sidebar/sidebar-bookmark-list'
import { useTreeDelete } from './hooks/use-tree-delete'
import type { Task } from '@/data/task-model'
import type { Project, Status } from '@/data/tasks-data'

const mocks = vi.hoisted(() => ({
  templates: [] as Array<Record<string, unknown>>,
  vaultStatus: { path: '/vaults/Main' } as Record<string, unknown> | null,
  vaults: [] as Array<Record<string, unknown>>,
  authState: { status: 'anonymous', email: null } as Record<string, unknown>,
  selectVault: vi.fn(),
  switchVault: vi.fn(),
  removeVault: vi.fn(),
  openSettings: vi.fn(),
  logout: vi.fn(),
  taskCreate: vi.fn(),
  taskGet: vi.fn(),
  taskListeners: {} as Record<string, (event: any) => void>,
  deleteFolder: vi.fn(),
  bookmarks: [] as Array<Record<string, unknown>>,
  bookmarksLoading: false,
  bookmarksError: null as Error | null,
  removeBookmark: vi.fn(),
  isActiveItem: vi.fn(),
  openTab: vi.fn(),
  activeTab: null as Record<string, unknown> | null,
  dayPanelOpen: false,
  dayPanelWidth: 320,
  dayPanelResizing: false,
  toggleDayPanel: vi.fn(),
  tabGroup: null as Record<string, any> | null,
  logger: { error: vi.fn() }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: {},
  horizontalListSortingStrategy: {}
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/hooks/use-templates', () => ({
  useTemplates: () => ({ templates: mocks.templates, isLoading: false })
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({
    projects: [
      { id: 'inbox', name: 'Inbox', isDefault: true, isArchived: false },
      { id: 'archive', name: 'Archive', isDefault: false, isArchived: true }
    ]
  })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    create: (...args: unknown[]) => mocks.taskCreate(...args),
    get: (...args: unknown[]) => mocks.taskGet(...args)
  },
  onTaskUpdated: (callback: (event: unknown) => void) => {
    mocks.taskListeners.updated = callback
    return vi.fn()
  },
  onTaskDeleted: (callback: (event: unknown) => void) => {
    mocks.taskListeners.deleted = callback
    return vi.fn()
  },
  onTaskCompleted: (callback: (event: unknown) => void) => {
    mocks.taskListeners.completed = callback
    return vi.fn()
  }
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    deleteFolder: (...args: unknown[]) => mocks.deleteFolder(...args)
  }
}))

vi.mock('@/hooks/use-bookmarks', () => ({
  useBookmarks: () => ({
    bookmarks: mocks.bookmarks,
    isLoading: mocks.bookmarksLoading,
    error: mocks.bookmarksError,
    removeBookmark: mocks.removeBookmark
  })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ isActiveItem: mocks.isActiveItem })
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({
    isOpen: mocks.dayPanelOpen,
    width: mocks.dayPanelWidth,
    isResizing: mocks.dayPanelResizing,
    toggle: mocks.toggleDayPanel
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabGroup: () => mocks.tabGroup,
  useTabActions: () => ({ openTab: mocks.openTab, splitView: vi.fn(() => 'side-pane') }),
  useTabs: () => ({
    openTab: mocks.openTab,
    getActiveTab: () => mocks.activeTab,
    state: {
      tabGroups: { 'pane-1': { id: 'pane-1', tabs: [], activeTabId: null } },
      layout: { type: 'leaf', tabGroupId: 'pane-1' },
      activeGroupId: 'pane-1'
    }
  })
}))

vi.mock('@/hooks/use-vault', () => ({
  useVault: () => ({
    status: mocks.vaultStatus,
    isLoading: false,
    selectVault: mocks.selectVault,
    switchVault: mocks.switchVault
  }),
  useVaultList: () => ({ vaults: mocks.vaults, removeVault: mocks.removeVault })
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettings })
}))

vi.mock('@/contexts/auth-context', () => ({
  useAuth: () => ({ state: mocks.authState, logout: mocks.logout })
}))

vi.mock('@/components/ui/sidebar', () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({ children, isActive: _isActive, tooltip: _tooltip, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SidebarMenuAction: ({ children, showOnHover: _showOnHover, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  useSidebar: () => ({ isMobile: false, state: 'collapsed' })
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: any }) => (
    <button type="button" onClick={(event) => onClick?.(event)}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/picker', async () => {
  const React = await import('react')
  const PickerContext = React.createContext<(value: string) => void>(() => {})

  function Picker({
    children,
    onValueChange
  }: {
    children: ReactNode
    onValueChange: (value: string) => void
  }) {
    return <PickerContext.Provider value={onValueChange}>{children}</PickerContext.Provider>
  }

  Picker.Trigger = ({ children }: { children: ReactNode }) => <>{children}</>
  Picker.Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.List = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.Separator = () => <hr />
  Picker.Empty = ({ message }: { message: string }) => <div>{message}</div>
  Picker.Item = ({ value, label, icon }: { value: string; label: string; icon?: ReactNode }) => {
    const onValueChange = React.useContext(PickerContext)
    return (
      <button type="button" onClick={() => onValueChange(value)}>
        {icon}
        {label}
      </button>
    )
  }

  return { Picker }
})

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogAction: ({
    children,
    onClick,
    disabled
  }: {
    children: ReactNode
    onClick?: (e: any) => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({
    children,
    onClick,
    disabled
  }: {
    children: ReactNode
    onClick?: (e: any) => void
    disabled?: boolean
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type = 'button',
    ...props
  }: {
    children?: ReactNode
    onClick?: () => void
    type?: 'button' | 'submit' | 'reset'
  }) => (
    <button type={type} onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({ onChange, value = '', placeholder, type = 'text', ...props }: any) => (
    <input
      aria-label={placeholder}
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      {...props}
    />
  )
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverAnchor: () => <span data-testid="popover-anchor" />,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<(value: string) => void>(() => {})

  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: ReactNode
    }) => (
      <SelectContext.Provider value={onValueChange}>
        <div data-testid={`select-${value}`}>{children}</div>
      </SelectContext.Provider>
    ),
    SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const onValueChange = React.useContext(SelectContext)
      return (
        <button type="button" onClick={() => onValueChange(value)}>
          {children}
        </button>
      )
    },
    SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SelectValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>
  }
})

vi.mock('@/components/tasks/date-picker-calendar', () => ({
  DatePickerCalendar: ({ onSelect }: { onSelect: (date: Date) => void }) => (
    <button type="button" onClick={() => onSelect(new Date('2026-05-10T00:00:00.000Z'))}>
      pick date
    </button>
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/selectable-list', () => ({
  SelectableListSection: ({
    children,
    title,
    count
  }: {
    children: ReactNode
    title: string
    count: number
  }) => (
    <section>
      <h3>
        {title} {count}
      </h3>
      {children}
    </section>
  ),
  SelectableListItem: ({ id, label }: { id: string; label: string }) => (
    <button type="button" data-template-id={id}>
      {label}
    </button>
  )
}))

vi.mock('@/components/ui/labeled-checkbox', () => ({
  LabeledCheckbox: ({
    checked,
    onCheckedChange,
    label,
    disabled
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    label: string
    disabled?: boolean
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.currentTarget.checked)}
      />
      {label}
    </label>
  )
}))

vi.mock('@/components/ui/primary-action-button', () => ({
  PrimaryActionButton: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))

vi.mock('@/components/tasks/drag-drop', () => ({
  SortableTaskRow: ({ task, onToggleComplete, onClick }: any) => (
    <button
      type="button"
      onClick={() => {
        onToggleComplete(task.id)
        onClick?.(task.id)
      }}
    >
      sortable {task.title}
    </button>
  )
}))

vi.mock('@/components/tasks/drag-drop/insertion-indicator', () => ({
  InsertionIndicator: ({ position }: { position: string }) => <div>indicator {position}</div>
}))

vi.mock('@/components/tasks/section-divider', () => ({
  SectionDivider: ({ label, count, variant }: any) => (
    <h2>
      {label} {count} {variant}
    </h2>
  )
}))

vi.mock('@/components/tasks/bulk-actions', () => ({
  SelectionCheckbox: ({ checked, onChange, ...props }: any) => (
    <input type="checkbox" checked={checked} onChange={onChange} {...props} />
  )
}))

vi.mock('@/components/tasks/expand-chevron', () => ({
  ExpandChevron: ({ onClick, hasSubtasks }: any) => (
    <button type="button" data-expand-button onClick={onClick}>
      expand {String(hasSubtasks)}
    </button>
  )
}))

vi.mock('@/components/tasks/inline-status-popover', () => ({
  InlineStatusPopover: ({ onStatusChange, onToggleComplete }: any) => (
    <button
      type="button"
      onClick={() => {
        onStatusChange('done')
        onToggleComplete()
      }}
    >
      status
    </button>
  )
}))

vi.mock('@/components/tasks/inline-priority-popover', () => ({
  InlinePriorityPopover: ({ onPriorityChange }: any) => (
    <button type="button" onClick={() => onPriorityChange('high')}>
      priority
    </button>
  )
}))

vi.mock('@/components/tasks/status-icon', () => ({
  StatusIcon: ({ type }: { type: string }) => <span>status {type}</span>,
  InteractiveStatusIcon: ({ onClick, type }: any) => (
    <button type="button" onClick={onClick}>
      subtask status {type}
    </button>
  )
}))

vi.mock('@/components/tasks/repeat-indicator', () => ({
  RepeatIndicator: () => <span>repeat</span>
}))

vi.mock('@/components/tasks/sortable-subtask-list', () => ({
  SortableSubtaskList: ({ subtasks }: any) => (
    <div>{subtasks.map((task: Task) => `sub ${task.title}`).join(',')}</div>
  )
}))

vi.mock('@/components/tasks/subtask-progress-indicator', () => ({
  SubtaskProgressIndicator: ({ completed, total }: any) => (
    <span>
      progress {completed}/{total}
    </span>
  )
}))

vi.mock('@/components/tasks/task-linked-note-indicator', () => ({
  TaskLinkedNoteIndicator: ({ task, onNoteClick }: any) => (
    <button type="button" onClick={() => onNoteClick?.(task.linkedNoteIds[0])}>
      linked
    </button>
  )
}))

vi.mock('@/components/tasks/task-icons', () => ({
  PriorityBars: ({ priority }: { priority: string }) => <span>bars {priority}</span>
}))

vi.mock('@/components/tasks/task-badges', () => ({
  TaskCheckbox: ({ onChange }: any) => (
    <button type="button" onClick={onChange}>
      check
    </button>
  ),
  InteractiveProjectBadge: ({ onProjectChange }: any) => (
    <button type="button" onClick={() => onProjectChange('project-2')}>
      project badge
    </button>
  ),
  InteractivePriorityBadge: ({ onPriorityChange }: any) => (
    <button type="button" onClick={() => onPriorityChange('urgent')}>
      priority badge
    </button>
  ),
  InteractiveDueDateBadge: ({ onDateChange }: any) => (
    <button type="button" onClick={() => onDateChange(null)}>
      date badge
    </button>
  )
}))

vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value }: { value: string }) => <span>{value}</span>
}))

vi.mock('./tabs/sortable-tab', () => ({
  SortableTab: ({ tab }: any) => <div data-tab-id={tab.id}>tab {tab.title}</div>
}))

vi.mock('./tabs/pinned-tab', () => ({
  PinnedTab: ({ tab }: any) => <div>pinned {tab.title}</div>
}))

vi.mock('./tabs/tab-bar-action', () => ({
  TabBarAction: ({ tooltip, onClick }: any) => (
    <button type="button" onClick={onClick}>
      {tooltip}
    </button>
  )
}))

vi.mock('./tabs/new-tab-menu', () => ({
  NewTabMenu: () => <button type="button">new tab</button>
}))

vi.mock('./tabs/tab-bar-context-menu', () => ({
  TabBarContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./tabs/tab-context-menu', () => ({
  TabContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

function status(overrides: Partial<Status> = {}): Status {
  return {
    id: 'todo',
    name: 'To Do',
    type: 'todo',
    color: '#999',
    order: 0,
    ...overrides
  }
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project',
    color: '#123',
    icon: 'folder',
    description: '',
    statuses: [
      status(),
      status({ id: 'doing', name: 'Doing', type: 'in_progress' }),
      status({ id: 'done', name: 'Done', type: 'done', color: '#0a0' })
    ],
    isDefault: false,
    isArchived: false,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    taskCount: 2,
    ...overrides
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    description: '',
    projectId: 'project-1',
    statusId: 'todo',
    priority: 'none',
    dueDate: null,
    dueTime: null,
    isRepeating: false,
    repeatConfig: null,
    linkedNoteIds: [],
    sourceNoteId: null,
    parentId: null,
    subtaskIds: [],
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    completedAt: null,
    archivedAt: null,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.scrollBy = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  mocks.templates = [
    { id: 'daily', name: 'Daily', description: 'Daily note', isBuiltIn: false, icon: 'sun' },
    { id: 'meeting', name: 'Meeting', description: 'Meeting note', isBuiltIn: true, icon: 'users' }
  ]
  mocks.vaultStatus = { path: '/vaults/Main' }
  mocks.vaults = [
    { name: 'Main', path: '/vaults/Main' },
    { name: 'Side', path: '/vaults/Side' }
  ]
  mocks.authState = { status: 'authenticated', email: 'kaan@example.com' }
  mocks.selectVault.mockResolvedValue(undefined)
  mocks.switchVault.mockResolvedValue(undefined)
  mocks.removeVault.mockResolvedValue(undefined)
  mocks.logout.mockResolvedValue(undefined)
  mocks.taskCreate.mockResolvedValue({
    success: true,
    task: { id: 'created-task', title: 'Created task' }
  })
  mocks.taskGet.mockResolvedValue(task({ id: 'task-block', title: 'Block task' }))
  mocks.taskListeners = {}
  mocks.deleteFolder.mockResolvedValue({ success: true })
  mocks.bookmarksLoading = false
  mocks.bookmarksError = null
  mocks.bookmarks = [
    {
      id: 'bookmark-1',
      itemId: 'note-1',
      itemType: 'note',
      itemTitle: 'Bookmarked note',
      itemExists: true,
      itemMeta: { path: '/notes/note-1', emoji: 'star' }
    },
    {
      id: 'bookmark-2',
      itemId: 'task-1',
      itemType: 'task',
      itemTitle: 'Bookmarked task',
      itemExists: true,
      itemMeta: {}
    },
    {
      id: 'bookmark-missing',
      itemId: 'gone',
      itemType: 'note',
      itemTitle: 'Gone',
      itemExists: false,
      itemMeta: {}
    }
  ]
  mocks.removeBookmark.mockResolvedValue({ success: true })
  mocks.isActiveItem.mockReturnValue(false)
  mocks.openTab.mockClear()
  mocks.activeTab = null
  mocks.dayPanelOpen = false
  mocks.dayPanelWidth = 320
  mocks.dayPanelResizing = false
  mocks.tabGroup = {
    id: 'group-1',
    activeTabId: 'tab-2',
    tabs: [
      { id: 'tab-1', title: 'Pinned', isPinned: true, type: 'note' },
      { id: 'tab-2', title: 'Regular', isPinned: false, type: 'tasks' }
    ]
  }
  mocks.logger.error.mockClear()
})

describe('cold major renderer components', () => {
  it('edits text, number, date, and value-less filter rows', () => {
    const onChange = vi.fn()
    const onRemove = vi.fn()

    const { rerender } = render(
      <FilterRow
        condition={{ id: 'c1', property: 'title', operator: 'contains', value: 'draft' }}
        availableProperties={[{ id: 'Score', name: 'Score', type: 'number' }]}
        onChange={onChange}
        onRemove={onRemove}
      />
    )

    fireEvent.change(
      screen.getByLabelText('phaseF.componentsFolderViewFilterRow.placeholderValue'),
      { target: { value: 'updated' } }
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ value: 'updated' }))

    fireEvent.click(screen.getByText('Score'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ property: 'Score', value: '' }))

    rerender(
      <FilterRow
        condition={{ id: 'c1', property: 'Score', operator: 'equals', value: 3 }}
        availableProperties={[{ id: 'Score', name: 'Score', type: 'number' }]}
        onChange={onChange}
        onRemove={onRemove}
      />
    )
    fireEvent.change(
      screen.getByLabelText('phaseF.componentsFolderViewFilterRow.placeholderValue'),
      {
        target: { value: '5' }
      }
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ value: 5 }))

    rerender(
      <FilterRow
        condition={{
          id: 'c1',
          property: 'created',
          operator: 'equals',
          value: '2026-05-09T00:00:00.000Z'
        }}
        availableProperties={[]}
        onChange={onChange}
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByText('pick date'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-10T00:00:00.000Z' })
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsFolderViewFilterRow.removeFilter'
      })
    )
    expect(onRemove).toHaveBeenCalled()
  })

  it('selects templates, searches, and resets on close', () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()
    const onSetFolderDefault = vi.fn()

    render(
      <TemplateSelector
        isOpen
        onClose={onClose}
        onSelect={onSelect}
        folderPath="Work"
        onSetFolderDefault={onSetFolderDefault}
      />
    )

    expect(screen.getByText('Daily')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('templateSelector.searchPlaceholder'), {
      target: { value: 'meeting' }
    })
    expect(screen.queryByText('Daily')).not.toBeInTheDocument()
    expect(screen.getByText('Meeting')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('templateSelector.setFolderDefault'))
    fireEvent.click(screen.getByText('templateSelector.createNote'))
    expect(onSelect).toHaveBeenCalledWith('blank')
    expect(onSetFolderDefault).toHaveBeenCalledWith('blank')

    fireEvent.click(screen.getByText('button.cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('switches vaults, opens a new vault, signs in, and removes vault list entries', async () => {
    const { rerender } = render(<VaultSwitcher />)

    fireEvent.click(screen.getByText('Side'))
    expect(mocks.switchVault).toHaveBeenCalledWith('/vaults/Side')

    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.openVault'))
    expect(mocks.selectVault).toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Remove Side from list'))
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.remove2'))
    await waitFor(() => expect(mocks.removeVault).toHaveBeenCalledWith('/vaults/Side'))

    mocks.authState = { status: 'anonymous', email: null }
    mocks.vaults = []
    rerender(<VaultSwitcher />)
    fireEvent.click(screen.getByText('phaseF.componentsVaultSwitcher.signInToSync'))
    expect(mocks.openSettings).toHaveBeenCalledWith('account')
    expect(screen.getByText('phaseF.componentsVaultSwitcher.noVaultsYet')).toBeInTheDocument()
  })

  it('renders task groups, parent rows, today rows, and subtask interactions', () => {
    const proj = project()
    const parent = task({
      id: 'parent',
      title: 'Parent',
      subtaskIds: ['child'],
      dueDate: new Date('2026-05-09T10:30:00.000Z'),
      dueTime: '10:30',
      linkedNoteIds: ['note-1'],
      isRepeating: true,
      repeatConfig: { frequency: 'daily' } as never
    })
    const child = task({ id: 'child', title: 'Child', parentId: 'parent', completedAt: new Date() })
    const callbacks = {
      toggle: vi.fn(),
      update: vi.fn(),
      click: vi.fn(),
      expand: vi.fn(),
      select: vi.fn(),
      shiftSelect: vi.fn(),
      noteClick: vi.fn()
    }

    const { rerender } = render(
      <TaskGroup
        label="Today"
        tasks={[parent, child]}
        allTasks={[parent, child]}
        projects={[proj]}
        urgency="critical"
        selectedTaskId="parent"
        showProjectBadge
        onToggleComplete={callbacks.toggle}
        onUpdateTask={callbacks.update}
        onTaskClick={callbacks.click}
        onToggleExpand={callbacks.expand}
        onToggleSelect={callbacks.select}
        onShiftSelect={callbacks.shiftSelect}
        selectedIds={new Set(['parent'])}
        expandedIds={new Set(['parent'])}
        isSelectionMode
      />
    )

    expect(screen.getByText('Today 1 overdue')).toBeInTheDocument()
    fireEvent.click(screen.getByText('status'))
    fireEvent.click(screen.getByText('priority'))
    fireEvent.click(screen.getByText('linked'))
    expect(callbacks.update).toHaveBeenCalledWith('parent', { statusId: 'done' })
    expect(callbacks.update).toHaveBeenCalledWith('parent', { priority: 'high' })
    expect(callbacks.noteClick).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('button', { name: /Task: Parent/ }), { key: 'ArrowLeft' })
    expect(callbacks.expand).toHaveBeenCalledWith('parent')

    rerender(
      <StatusTaskGroup
        status={proj.statuses[2]}
        tasks={[task({ id: 'done-task', title: 'Done task', statusId: 'done' })]}
        allTasks={[]}
        project={proj}
        onToggleComplete={callbacks.toggle}
        onUpdateTask={callbacks.update}
        onTaskClick={callbacks.click}
      />
    )
    fireEvent.click(screen.getByText('sortable Done task'))
    expect(callbacks.toggle).toHaveBeenCalledWith('done-task')

    rerender(
      <ParentTaskRow
        task={parent}
        project={proj}
        subtasks={[child]}
        progress={{ completed: 1, total: 1 }}
        isExpanded={false}
        isCompleted
        renderMode="overlay"
        overlayWidth={320}
        onToggleExpand={callbacks.expand}
        onToggleComplete={callbacks.toggle}
      />
    )
    expect(screen.getByText('status done')).toBeInTheDocument()
    expect(screen.getByText('bars none')).toBeInTheDocument()

    rerender(
      <TodayTaskRow
        task={parent}
        projects={[proj]}
        section="overdue"
        onToggleComplete={callbacks.toggle}
        onUpdateTask={callbacks.update}
        onClick={callbacks.click}
      />
    )
    fireEvent.click(screen.getByText('check'))
    fireEvent.click(screen.getByText('project badge'))
    fireEvent.click(screen.getByText('priority badge'))
    fireEvent.click(screen.getByText('date badge'))
    expect(callbacks.update).toHaveBeenCalledWith('parent', { projectId: 'project-2' })
    expect(callbacks.update).toHaveBeenCalledWith('parent', { priority: 'urgent' })
    expect(callbacks.update).toHaveBeenCalledWith('parent', { dueDate: null })

    rerender(
      <SubtaskRow
        subtask={child}
        statuses={proj.statuses}
        isLast
        onToggleComplete={callbacks.toggle}
        onClick={callbacks.click}
      />
    )
    fireEvent.click(screen.getByText('subtask status done'))
    fireEvent.keyDown(screen.getByRole('button', { name: /Subtask: Child/ }), { key: 'Enter' })
    expect(callbacks.toggle).toHaveBeenCalledWith('child')
    expect(callbacks.click).toHaveBeenCalledWith('child')
  })

  it('handles outline hover, autocomplete commands, and task creation flow', async () => {
    const onHeadingClick = vi.fn()
    const { rerender } = render(<OutlineEdge headings={[]} onHeadingClick={onHeadingClick} />)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()

    rerender(
      <OutlineEdge
        headings={[
          { id: 'h1', level: 1, text: 'Heading one', position: 0 },
          { id: 'h2', level: 2, text: 'Heading two', position: 1 },
          { id: 'h3', level: 4, text: 'Heading deep', position: 2 }
        ]}
        activeHeadingId="h2"
        onHeadingClick={onHeadingClick}
      />
    )
    fireEvent.mouseEnter(screen.getByText('', { selector: '.vertical-connector' }).parentElement!)
    fireEvent.click(screen.getByText('Heading two'))
    expect(onHeadingClick).toHaveBeenCalledWith('h2')

    const tagCommand = vi.fn()
    const tagRef = createRef<TagAutocompleteRef>()
    rerender(
      <TagAutocomplete
        ref={tagRef}
        items={[{ name: 'work', count: 2 }]}
        command={tagCommand}
        query="new"
      />
    )
    fireEvent.click(screen.getByText('work'))
    expect(tagCommand).toHaveBeenCalledWith({ tag: 'work' })
    act(() => {
      expect(tagRef.current?.onKeyDown({ event: { key: 'ArrowDown' } as never })).toBe(true)
      expect(tagRef.current?.onKeyDown({ event: { key: ' ' } as never })).toBe(true)
    })

    const wikiCommand = vi.fn()
    const wikiRef = createRef<WikiLinkAutocompleteRef>()
    rerender(
      <WikiLinkAutocomplete
        ref={wikiRef}
        items={[
          { id: 'p1', title: 'Page one', exists: true, lastEdited: new Date().toISOString() },
          { id: 'p2', title: 'Page two', exists: true, lastEdited: new Date().toISOString() },
          { id: 'p3', title: 'Page three', exists: true, lastEdited: new Date().toISOString() },
          { id: 'p4', title: 'Page four', exists: false, lastEdited: new Date().toISOString() }
        ]}
        command={wikiCommand}
      />
    )
    const pageFourOption = screen.getByRole('option', { name: 'Page four' })
    expect(pageFourOption.querySelector('svg')).toBeNull()

    fireEvent.click(screen.getByText('Page four'))
    expect(wikiCommand).toHaveBeenCalledWith({ href: 'p4', title: 'Page four', exists: false })
    act(() => {
      expect(wikiRef.current?.onKeyDown({ event: { key: 'ArrowUp' } as never })).toBe(true)
    })

    const onCreated = vi.fn()
    const onCancel = vi.fn()
    const anchor = { current: document.createElement('span') }
    rerender(
      <TaskCreationPopover
        isOpen
        anchorRef={anchor}
        title="Created task"
        noteId="note-1"
        onCreated={onCreated}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByTitle('High'))
    fireEvent.change(screen.getByDisplayValue(''), { target: { value: '2026-05-12' } })
    fireEvent.click(screen.getByText('Create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('created-task', 'Created task'))
    expect(mocks.taskCreate).toHaveBeenCalledWith({
      projectId: 'inbox',
      title: 'Created task',
      priority: 3,
      dueDate: '2026-05-12',
      linkedNoteIds: ['note-1']
    })

    mocks.taskCreate.mockResolvedValueOnce({ success: false, error: 'No create' })
    rerender(
      <TaskCreationPopover
        isOpen
        anchorRef={anchor}
        title="Failed task"
        onCreated={onCreated}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(await screen.findByText('No create')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByText('Failed task').parentElement!, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('loads task block data and handles note tree delete flows', async () => {
    const block = renderHook(({ id }) => useTaskBlockData(id), {
      initialProps: { id: 'task-block' }
    })
    await waitFor(() => expect(block.result.current.task?.title).toBe('Block task'))

    act(() =>
      mocks.taskListeners.updated({
        id: 'task-block',
        task: task({ id: 'task-block', title: 'Updated task' })
      })
    )
    expect(block.result.current.task?.title).toBe('Updated task')

    act(() => mocks.taskListeners.deleted({ id: 'task-block' }))
    expect(block.result.current.isDeleted).toBe(true)

    const selectedIds = ['note-1', 'folder-Work']
    const setSelectedIds = vi.fn()
    const deleteNote = vi.fn().mockResolvedValue({ success: true })
    const closeTab = vi.fn()
    const refreshFolders = vi.fn().mockResolvedValue(undefined)
    const noteMap = new Map([['note-1', { id: 'note-1', title: 'Delete me' } as never]])
    const tree = renderHook(() =>
      useTreeDelete({
        selectedIds,
        setSelectedIds,
        noteMap,
        deleteNoteMutateAsync: deleteNote,
        closeTab,
        refreshFolders
      })
    )

    act(() => tree.result.current.handleBulkDelete())
    expect(tree.result.current.notesToDelete).toHaveLength(1)
    expect(tree.result.current.foldersToDelete).toEqual(['Work'])

    await act(async () => {
      await tree.result.current.handleDeleteConfirm()
    })
    expect(deleteNote).toHaveBeenCalledWith('note-1')
    expect(mocks.deleteFolder).toHaveBeenCalledWith('Work')
    expect(refreshFolders).toHaveBeenCalled()
    expect(setSelectedIds).toHaveBeenCalledWith([])

    const failingDelete = vi.fn().mockRejectedValue(new Error('delete failed'))
    const failing = renderHook(() =>
      useTreeDelete({
        selectedIds: [],
        setSelectedIds,
        noteMap,
        deleteNoteMutateAsync: failingDelete,
        closeTab,
        refreshFolders
      })
    )
    act(() => failing.result.current.handleDeleteClick({ id: 'note-2', title: 'Bad' } as never))
    await act(async () => {
      await failing.result.current.handleDeleteConfirm()
    })
    expect(mocks.logger.error).toHaveBeenCalledWith('Failed to delete items', expect.any(Error))
  })

  it('renders bookmarks and tab bar actions across empty, error, and populated states', async () => {
    const onBookmarkClick = vi.fn()
    const { rerender } = render(
      <SidebarBookmarkList maxVisible={1} onBookmarkClick={onBookmarkClick} />
    )

    fireEvent.click(screen.getByText('Bookmarked note'))
    expect(onBookmarkClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'bookmark-1' }))
    fireEvent.click(screen.getByText('+1 more'))
    expect(screen.getByText('Bookmarked task')).toBeInTheDocument()
    fireEvent.click(screen.getAllByText('phaseF.componentsSidebarSidebarBookmarkList.remove')[0])
    await waitFor(() => expect(mocks.removeBookmark).toHaveBeenCalledWith('bookmark-1'))

    mocks.bookmarksLoading = true
    rerender(<SidebarBookmarkList />)
    expect(
      screen.getByText('phaseF.componentsSidebarSidebarBookmarkList.loadingBookmarks')
    ).toBeInTheDocument()

    mocks.bookmarksLoading = false
    mocks.bookmarksError = new Error('load failed')
    rerender(<SidebarBookmarkList />)
    expect(
      screen.getByText('phaseF.componentsSidebarSidebarBookmarkList.failedToLoadBookmarks')
    ).toBeInTheDocument()

    mocks.bookmarksError = null
    mocks.bookmarks = []
    rerender(<SidebarBookmarkList />)
    expect(
      screen.getByText('phaseF.componentsSidebarSidebarBookmarkList.noBookmarksYet')
    ).toBeInTheDocument()

    rerender(<TabBarWithDrag groupId="group-1" />)
    expect(screen.getByText('pinned Pinned')).toBeInTheDocument()
    expect(screen.getByText('tab Regular')).toBeInTheDocument()
    expect(screen.queryByText('phaseF.componentsTabsTabBarWithDrag.graphG')).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'phaseF.componentsTabsTabBarWithDrag.dayPanel' })
    )
    expect(mocks.toggleDayPanel).toHaveBeenCalled()

    mocks.dayPanelOpen = true
    rerender(<TabBarWithDrag groupId="group-1" />)
    expect(screen.getByRole('tablist')).toHaveStyle({ marginInlineEnd: '320px' })
    expect(
      screen.queryByRole('button', { name: 'phaseF.componentsTabsTabBarWithDrag.dayPanel' })
    ).not.toBeInTheDocument()

    mocks.tabGroup = null
    rerender(<TabBarWithDrag groupId="missing" />)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('scrolls the active tab into view so it never stays past the strip edge', () => {
    const scrolled: Element[] = []
    const spy = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(function scrollIntoViewStub(this: HTMLElement) {
        scrolled.push(this)
      })

    try {
      mocks.tabGroup = {
        id: 'group-1',
        activeTabId: 'tab-1',
        tabs: [
          { id: 'tab-1', title: 'First', isPinned: false, type: 'note' },
          { id: 'tab-2', title: 'Last', isPinned: false, type: 'note' }
        ]
      }
      const { rerender } = render(<TabBarWithDrag groupId="group-1" />)
      expect(scrolled.at(-1)).toHaveAttribute('data-tab-id', 'tab-1')

      mocks.tabGroup = { ...mocks.tabGroup, activeTabId: 'tab-2' }
      rerender(<TabBarWithDrag groupId="group-1" />)
      expect(scrolled.at(-1)).toHaveAttribute('data-tab-id', 'tab-2')
    } finally {
      spy.mockRestore()
    }
  })
})
