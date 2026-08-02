import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { TasksPage } from './tasks'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'
import type React from 'react'

const mocks = vi.hoisted(() => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  addProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  getOrderedTasks: vi.fn((tasks: Task[]) => tasks),
  registerUndo: vi.fn(),
  removeUndoEntry: vi.fn(),
  createTask: vi.fn(),
  updateTaskWithUndo: vi.fn(),
  completeTask: vi.fn(),
  uncompleteTask: vi.fn(),
  deleteTaskWithUndo: vi.fn(),
  saveTabState: vi.fn(),
  openTab: vi.fn(),
  notesGet: vi.fn(),
  notesGetFile: vi.fn(),
  clearFilters: vi.fn(),
  updateFilters: vi.fn(),
  updateSort: vi.fn(),
  saveFilter: vi.fn(),
  deleteSavedFilter: vi.fn(),
  toggleStarFilter: vi.fn(),
  selectAll: vi.fn(),
  deselectAll: vi.fn(),
  toggleSelectAll: vi.fn(),
  toggleTask: vi.fn(),
  selectRange: vi.fn(),
  enterSelectionMode: vi.fn(),
  exitSelectionMode: vi.fn(),
  bulkComplete: vi.fn(),
  bulkChangePriority: vi.fn(),
  bulkChangeDueDate: vi.fn(),
  bulkMoveToProject: vi.fn(),
  bulkChangeStatus: vi.fn(),
  bulkArchive: vi.fn(),
  bulkDelete: vi.fn(),
  taskReorder: vi.fn(),
  undoableDeps: null as any,
  bulkDeps: null as any,
  subtaskDeps: null as any,
  saveFilterShortcut: null as any,
  filterState: {
    filters: {
      search: '',
      projectIds: [] as string[],
      priorities: [] as string[],
      tags: [] as string[],
      dueDate: { type: 'any', customStart: null, customEnd: null },
      statusIds: [] as string[],
      completion: 'active',
      repeatType: 'all',
      hasTime: 'all'
    },
    sort: { field: 'createdAt', direction: 'desc' },
    hasActiveFilters: false
  },
  activeTabViewState: {
    activeInternalTab: 'all',
    activeTab: 'all',
    activeView: 'list',
    selectedProjectId: null as string | null,
    openTaskId: null as string | null
  },
  savedFilters: [
    {
      id: 'saved-1',
      name: 'Important',
      starred: true,
      filters: { priority: ['high'] },
      sort: { field: 'priority', direction: 'asc' }
    }
  ],
  selectionState: {
    selectedCount: 0,
    hasSelection: false,
    allSelected: false,
    someSelected: false,
    selectedTaskIds: [] as string[],
    selectedIds: new Set<string>(),
    isSelectionMode: false
  },
  subtaskState: {
    allSubtasksCompleteDialogOpen: false,
    pendingAutoCompleteParent: null as Task | null,
    bulkDueDateDialogOpen: false,
    bulkPriorityDialogOpen: false,
    deleteAllSubtasksDialogOpen: false,
    pendingBulkOperationParent: null as Task | null,
    pendingBulkOperationSubtasks: [] as Task[]
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.name ?? key })
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

// BlockNote can't mount in jsdom; stub the task description editor.
vi.mock('@/components/tasks/task-description-editor', () => ({
  TaskDescriptionEditor: ({
    initialContent,
    onContentChange,
    placeholder
  }: {
    initialContent: string | null
    onContentChange?: (markdown: string) => void
    placeholder?: string
  }) => (
    <textarea
      placeholder={placeholder}
      defaultValue={initialContent ?? ''}
      onChange={(event) => onContentChange?.(event.target.value)}
    />
  )
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/contexts/tasks', () => ({
  useTasksContext: () => ({
    addTask: mocks.addTask,
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask,
    addProject: mocks.addProject,
    updateProject: mocks.updateProject,
    deleteProject: mocks.deleteProject,
    getOrderedTasks: mocks.getOrderedTasks
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({ openTab: mocks.openTab, saveTabState: mocks.saveTabState }),
  useActiveTab: () => ({
    id: 'tasks-tab',
    viewState: mocks.activeTabViewState
  })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: { get: mocks.notesGet, getFile: mocks.notesGetFile }
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { reorder: mocks.taskReorder }
}))

vi.mock('@/hooks/use-task-preferences', () => ({
  useTaskPreferences: () => ({ settings: { defaultProjectId: null, defaultView: 'all' } })
}))

vi.mock('@/hooks/use-save-filter-shortcut', () => ({
  useSaveFilterShortcut: (args: unknown) => {
    mocks.saveFilterShortcut = args
  }
}))

vi.mock('@/hooks/use-undoable-task-actions', () => ({
  useUndoableTaskActions: (deps: unknown) => {
    mocks.undoableDeps = deps
    return {
      createTask: mocks.createTask,
      updateTaskWithUndo: mocks.updateTaskWithUndo,
      completeTask: mocks.completeTask,
      uncompleteTask: mocks.uncompleteTask,
      deleteTask: mocks.deleteTaskWithUndo
    }
  }
}))

vi.mock('@/hooks', () => ({
  useUndoTracker: () => ({
    registerUndo: mocks.registerUndo,
    removeUndoEntry: mocks.removeUndoEntry
  }),
  useFilterState: () => ({
    filters: mocks.filterState.filters,
    sort: mocks.filterState.sort,
    updateFilters: mocks.updateFilters,
    updateSort: mocks.updateSort,
    clearFilters: mocks.clearFilters,
    hasActiveFilters: mocks.filterState.hasActiveFilters
  }),
  useSavedFilters: () => ({
    savedFilters: mocks.savedFilters,
    saveFilter: mocks.saveFilter,
    deleteFilter: mocks.deleteSavedFilter,
    toggleStar: mocks.toggleStarFilter
  }),
  useFilteredAndSortedTasks: ({ tasks }: { tasks: Task[] }) => ({
    filteredTasks: tasks,
    totalCount: tasks.length,
    filteredCount: mocks.filterState.hasActiveFilters ? 0 : tasks.length
  }),
  useTaskSelection: () => ({
    selection: {
      selectedIds: mocks.selectionState.selectedIds,
      isSelectionMode: mocks.selectionState.isSelectionMode
    },
    selectedCount: mocks.selectionState.selectedCount,
    hasSelection: mocks.selectionState.hasSelection,
    allSelected: mocks.selectionState.allSelected,
    someSelected: mocks.selectionState.someSelected,
    selectedTaskIds: mocks.selectionState.selectedTaskIds,
    toggleTask: mocks.toggleTask,
    selectRange: mocks.selectRange,
    selectAll: mocks.selectAll,
    deselectAll: mocks.deselectAll,
    toggleSelectAll: mocks.toggleSelectAll,
    enterSelectionMode: mocks.enterSelectionMode,
    exitSelectionMode: mocks.exitSelectionMode
  }),
  useBulkActions: (deps: unknown) => {
    mocks.bulkDeps = deps
    return {
      bulkComplete: mocks.bulkComplete,
      bulkChangePriority: mocks.bulkChangePriority,
      bulkChangeDueDate: mocks.bulkChangeDueDate,
      bulkMoveToProject: mocks.bulkMoveToProject,
      bulkChangeStatus: mocks.bulkChangeStatus,
      bulkArchive: mocks.bulkArchive,
      bulkDelete: mocks.bulkDelete,
      getSelectedTasks: () => [task]
    }
  },
  useSubtaskManagement: (deps: unknown) => {
    mocks.subtaskDeps = deps
    return {
      handleCompleteSubtask: vi.fn(),
      handleReorderSubtasks: vi.fn(),
      handleAddSubtask: vi.fn(),
      allSubtasksCompleteDialogOpen: mocks.subtaskState.allSubtasksCompleteDialogOpen,
      pendingAutoCompleteParent: mocks.subtaskState.pendingAutoCompleteParent,
      closeAllSubtasksCompleteDialog: vi.fn(),
      keepParentOpen: vi.fn(),
      autoCompleteParent: vi.fn(),
      bulkDueDateDialogOpen: mocks.subtaskState.bulkDueDateDialogOpen,
      pendingBulkOperationParent: mocks.subtaskState.pendingBulkOperationParent,
      pendingBulkOperationSubtasks: mocks.subtaskState.pendingBulkOperationSubtasks,
      closeBulkDueDateDialog: vi.fn(),
      confirmBulkDueDate: vi.fn(),
      bulkPriorityDialogOpen: mocks.subtaskState.bulkPriorityDialogOpen,
      closeBulkPriorityDialog: vi.fn(),
      confirmBulkPriority: vi.fn(),
      deleteAllSubtasksDialogOpen: mocks.subtaskState.deleteAllSubtasksDialogOpen,
      closeDeleteAllSubtasksDialog: vi.fn(),
      confirmDeleteAllSubtasks: vi.fn()
    }
  }
}))

vi.mock('@/components/ui/page-toolbar', () => ({
  PageToolbar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-toolbar">{children}</div>
  )
}))

vi.mock('@/components/tasks/tasks-tab-bar', () => ({
  TasksTabBar: ({
    onTabChange,
    onProjectChange,
    onProjectEdit,
    onApplySavedFilter,
    onUnstarSavedFilter,
    projects,
    savedFilters
  }: {
    onTabChange: (tab: string) => void
    onProjectChange: (id: string | null) => void
    onProjectEdit: (project: Project) => void
    onApplySavedFilter: (filter: unknown) => void
    onUnstarSavedFilter: (id: string) => void
    projects: Project[]
    savedFilters: unknown[]
  }) => (
    <div>
      <button type="button" onClick={() => onTabChange('today')}>
        Today tab
      </button>
      <button type="button" onClick={() => onProjectChange(projects[0]?.id ?? null)}>
        Pick project
      </button>
      <button type="button" onClick={() => onProjectEdit(projects[0])}>
        Edit project
      </button>
      <button type="button" onClick={() => onApplySavedFilter(savedFilters[0])}>
        Apply starred filter
      </button>
      <button type="button" onClick={() => onUnstarSavedFilter('saved-1')}>
        Unstar filter
      </button>
    </div>
  )
}))

vi.mock('@/components/capture-bar', () => ({
  CaptureBar: ({
    onSubmit,
    onOpenDetail
  }: {
    onSubmit: (
      title: string,
      parsed?: {
        dueDate: Date | null
        priority: string
        projectId: string | null
        statusId?: string | null
      }
    ) => void
    onOpenDetail: (title: string) => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onSubmit('Quick task', { dueDate: null, priority: 'high', projectId: null })}
      >
        Quick add
      </button>
      <button
        type="button"
        onClick={() =>
          onSubmit('Status task', {
            dueDate: null,
            priority: 'none',
            projectId: 'project-1',
            statusId: 'p-done'
          })
        }
      >
        Quick add status
      </button>
      <button type="button" onClick={() => onOpenDetail('Draft title')}>
        Open add modal
      </button>
    </div>
  )
}))

vi.mock('@/components/tasks/task-list', () => ({
  TaskList: ({
    tasks,
    onToggleComplete,
    onUpdateTask,
    onTaskClick,
    onNoteClick,
    onQuickAdd
  }: {
    tasks: Task[]
    onToggleComplete: (id: string) => void
    onUpdateTask: (id: string, updates: Partial<Task>) => void
    onTaskClick: (id: string) => void
    onNoteClick: (id: string) => void
    onQuickAdd: (title: string) => void
  }) => (
    <div data-testid="task-list">
      {tasks.map((item) => (
        <div key={item.id}>{item.title}</div>
      ))}
      <button type="button" onClick={() => onToggleComplete(tasks[0].id)}>
        Toggle task
      </button>
      <button type="button" onClick={() => onUpdateTask(tasks[0].id, { title: 'Changed' })}>
        Update task
      </button>
      <button type="button" onClick={() => onTaskClick(tasks[0].id)}>
        Open task
      </button>
      <button type="button" onClick={() => onNoteClick('note-1')}>
        Open linked note
      </button>
      <button type="button" onClick={() => onQuickAdd('Inline task')}>
        Inline add
      </button>
    </div>
  )
}))

vi.mock('@/components/tasks/kanban', () => ({
  KanbanBoard: ({ onQuickAdd }: { onQuickAdd: (title: string, columnId: string) => void }) => (
    <button type="button" onClick={() => onQuickAdd('Kanban task', 'p-done')}>
      Kanban quick add
    </button>
  )
}))

vi.mock('@/components/tasks/task-detail-drawer', () => ({
  TaskDetailDrawer: ({
    isOpen,
    onClose,
    onToggleComplete,
    onNoteClick,
    onDeleteTask
  }: {
    isOpen: boolean
    onClose: () => void
    onToggleComplete: (id: string) => void
    onNoteClick: (id: string) => void
    onDeleteTask: (id: string) => void
  }) =>
    isOpen ? (
      <div>
        <button type="button" onClick={onClose}>
          Close drawer
        </button>
        <button type="button" onClick={() => onToggleComplete('task-1')}>
          Toggle drawer task
        </button>
        <button type="button" onClick={() => onNoteClick('note-1')}>
          Drawer linked note
        </button>
        <button type="button" onClick={() => onDeleteTask('task-1')}>
          Delete drawer task
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/tasks/add-task-modal', () => ({
  AddTaskModal: ({
    isOpen,
    onClose,
    onAddTask,
    prefillTitle
  }: {
    isOpen: boolean
    onClose: () => void
    onAddTask: (task: Task) => void
    prefillTitle: string
  }) =>
    isOpen ? (
      <div>
        <span>{prefillTitle}</span>
        <button type="button" onClick={() => onAddTask(task)}>
          Save modal task
        </button>
        <button type="button" onClick={onClose}>
          Close modal
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/tasks/project-modal', () => ({
  ProjectModal: ({
    isOpen,
    onClose,
    onSave,
    onDelete
  }: {
    isOpen: boolean
    onClose: () => void
    onSave: (project: Project) => void
    onDelete: () => void
  }) =>
    isOpen ? (
      <div>
        <button type="button" onClick={() => onSave(project)}>
          Save project
        </button>
        <button type="button" onClick={onClose}>
          Close project
        </button>
        <button type="button" onClick={onDelete}>
          Delete project
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/tasks/filters', () => ({
  FilterBar: ({
    onClearFilters,
    onSaveFilter
  }: {
    onClearFilters: () => void
    onSaveFilter: () => void
  }) => (
    <div>
      <button type="button" onClick={onClearFilters}>
        Clear filter bar
      </button>
      <button type="button" onClick={onSaveFilter}>
        Save filter bar
      </button>
    </div>
  ),
  FilterDropdown: ({
    children,
    onUpdateFilters,
    onClearFilters,
    onSaveFilter,
    onApplySavedFilter,
    onDeleteSavedFilter
  }: {
    children: React.ReactNode
    onUpdateFilters: (updates: unknown) => void
    onClearFilters: () => void
    onSaveFilter: (name: string) => void
    onApplySavedFilter: (filter: unknown) => void
    onDeleteSavedFilter: (id: string) => void
  }) => (
    <div>
      {children}
      <button type="button" onClick={() => onUpdateFilters({ priority: ['high'] })}>
        Update filters
      </button>
      <button type="button" onClick={onClearFilters}>
        Clear filters
      </button>
      <button type="button" onClick={() => onSaveFilter('High only')}>
        Save filter
      </button>
      <button type="button" onClick={() => onApplySavedFilter(mocks.savedFilters[0])}>
        Apply filter
      </button>
      <button type="button" onClick={() => onDeleteSavedFilter('saved-1')}>
        Delete filter
      </button>
    </div>
  ),
  FilterEmptyState: ({ onClearFilters }: { onClearFilters: () => void }) => (
    <button type="button" onClick={onClearFilters}>
      Empty filters
    </button>
  ),
  GroupByDropdown: ({ onChange }: { onChange: (sort: unknown) => void }) => (
    <button type="button" onClick={() => onChange({ field: 'priority', direction: 'asc' })}>
      Group by
    </button>
  )
}))

vi.mock('@/components/tasks/bulk-actions', () => ({
  BulkActionToolbar: ({
    onComplete,
    onChangePriority,
    onChangeDueDate,
    onMoveToProject,
    onChangeStatus,
    onArchive,
    onDelete,
    onCancel,
    statuses
  }: {
    onComplete: () => void
    onChangePriority: (priority: string) => void
    onChangeDueDate: (option: string) => void
    onMoveToProject: (projectId: string) => void
    onChangeStatus: (statusId: string) => void
    onArchive: () => void
    onDelete: () => void
    onCancel: () => void
    statuses: Array<unknown>
  }) => (
    <div>
      <span data-testid="bulk-status-count">{statuses.length}</span>
      <button type="button" onClick={onComplete}>
        Bulk complete
      </button>
      <button type="button" onClick={() => onChangePriority('urgent')}>
        Bulk priority
      </button>
      <button type="button" onClick={() => onChangeDueDate('tomorrow')}>
        Bulk due date
      </button>
      <button type="button" onClick={() => onChangeDueDate('today')}>
        Bulk today
      </button>
      <button type="button" onClick={() => onChangeDueDate('pick-date')}>
        Bulk pick date
      </button>
      <button type="button" onClick={() => onChangeDueDate('remove')}>
        Bulk remove due date
      </button>
      <button type="button" onClick={() => onChangeDueDate('next-week')}>
        Bulk next week
      </button>
      <button type="button" onClick={() => onChangeDueDate('next-month')}>
        Bulk next month
      </button>
      <button type="button" onClick={() => onMoveToProject('project-1')}>
        Bulk move
      </button>
      <button type="button" onClick={() => onChangeStatus('p-done')}>
        Bulk status
      </button>
      <button type="button" onClick={onArchive}>
        Bulk archive
      </button>
      <button type="button" onClick={onDelete}>
        Bulk delete
      </button>
      <button type="button" onClick={onCancel}>
        Bulk cancel
      </button>
    </div>
  ),
  BulkDeleteDialog: ({
    open,
    onConfirm,
    onClose
  }: {
    open: boolean
    onConfirm: () => void
    onClose: () => void
  }) =>
    open ? (
      <div>
        <button type="button" onClick={onConfirm}>
          Confirm bulk delete
        </button>
        <button type="button" onClick={onClose}>
          Close bulk delete
        </button>
      </div>
    ) : null,
  BulkDueDatePicker: ({
    open,
    onConfirm,
    onClose
  }: {
    open: boolean
    onConfirm: (date: Date, time: string | null) => void
    onClose: () => void
  }) =>
    open ? (
      <div>
        <button type="button" onClick={() => onConfirm(new Date('2026-05-10'), null)}>
          Pick bulk due date
        </button>
        <button type="button" onClick={onClose}>
          Close due picker
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/tasks/dialogs', () => ({
  AllSubtasksCompleteDialog: ({ isOpen, parentTaskTitle }: any) => (
    <div data-testid="all-subtasks-dialog" data-open={String(isOpen)}>
      {parentTaskTitle}
    </div>
  ),
  BulkDueDateDialog: ({ isOpen, completedCount }: any) => (
    <div data-testid="bulk-subtask-due-dialog" data-open={String(isOpen)}>
      {completedCount}
    </div>
  ),
  BulkPriorityDialog: ({ isOpen, completedCount }: any) => (
    <div data-testid="bulk-subtask-priority-dialog" data-open={String(isOpen)}>
      {completedCount}
    </div>
  ),
  DeleteAllSubtasksDialog: ({ isOpen, subtasks }: any) => (
    <div data-testid="delete-subtasks-dialog" data-open={String(isOpen)}>
      {subtasks.length}
    </div>
  )
}))

const project: Project = {
  id: 'project-1',
  name: 'Work',
  description: '',
  icon: 'Folder',
  color: '#123456',
  isDefault: true,
  isArchived: false,
  createdAt: new Date('2026-05-01'),
  taskCount: 1,
  statuses: [
    { id: 'p-todo', name: 'Todo', color: '#999999', type: 'todo', order: 0 },
    { id: 'p-done', name: 'Done', color: '#00aa00', type: 'done', order: 1 }
  ]
}

const task: Task = {
  id: 'task-1',
  title: 'Ship coverage',
  description: '',
  projectId: 'project-1',
  statusId: 'p-todo',
  priority: 'medium',
  dueDate: new Date('2026-05-10'),
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: ['note-1'],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-05-09'),
  completedAt: null,
  archivedAt: null
}

function renderPage(overrides: Partial<React.ComponentProps<typeof TasksPage>> = {}) {
  return renderWithProviders(
    <TasksPage
      selectedId="all"
      selectedType="view"
      tasks={[task]}
      projects={[project]}
      onTasksChange={vi.fn()}
      onSelectionChange={vi.fn()}
      {...overrides}
    />
  )
}

describe('TasksPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.filterState.filters = {
      search: '',
      projectIds: [],
      priorities: [],
      tags: [],
      dueDate: { type: 'any', customStart: null, customEnd: null },
      statusIds: [],
      completion: 'active',
      repeatType: 'all',
      hasTime: 'all'
    }
    mocks.filterState.hasActiveFilters = false
    mocks.activeTabViewState = {
      activeInternalTab: 'all',
      activeTab: 'all',
      activeView: 'list',
      selectedProjectId: null,
      openTaskId: null
    }
    mocks.selectionState.selectedCount = 0
    mocks.selectionState.hasSelection = false
    mocks.selectionState.allSelected = false
    mocks.selectionState.someSelected = false
    mocks.selectionState.selectedTaskIds = []
    mocks.selectionState.selectedIds = new Set()
    mocks.selectionState.isSelectionMode = false
    mocks.undoableDeps = null
    mocks.bulkDeps = null
    mocks.subtaskDeps = null
    mocks.saveFilterShortcut = null
    mocks.subtaskState.allSubtasksCompleteDialogOpen = false
    mocks.subtaskState.pendingAutoCompleteParent = null
    mocks.subtaskState.bulkDueDateDialogOpen = false
    mocks.subtaskState.bulkPriorityDialogOpen = false
    mocks.subtaskState.deleteAllSubtasksDialogOpen = false
    mocks.subtaskState.pendingBulkOperationParent = null
    mocks.subtaskState.pendingBulkOperationSubtasks = []
    mocks.notesGet.mockResolvedValue({ id: 'note-1', title: 'Linked Note', emoji: 'x' })
    mocks.notesGetFile.mockResolvedValue(null)
    mocks.taskReorder.mockResolvedValue(undefined)
  })

  it('drives task list, quick-add, filters, and linked-note navigation', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(screen.getByText('Ship coverage')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Quick add' }))
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Quick task', priority: 'high' })
    )

    await user.click(screen.getByRole('button', { name: 'Toggle task' }))
    expect(mocks.completeTask).toHaveBeenCalledWith('task-1')

    await user.click(screen.getByRole('button', { name: 'Update task' }))
    expect(mocks.updateTaskWithUndo).toHaveBeenCalledWith('task-1', { title: 'Changed' })

    await user.click(screen.getByRole('button', { name: 'Open task' }))
    expect(mocks.saveTabState).toHaveBeenCalledWith(
      'tasks-tab',
      expect.objectContaining({ viewState: expect.objectContaining({ openTaskId: 'task-1' }) })
    )

    await user.click(screen.getByRole('button', { name: 'Open linked note' }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', title: 'Linked Note', entityId: 'note-1' })
    )

    await user.click(screen.getByRole('button', { name: 'Save filter' }))
    expect(mocks.saveFilter).toHaveBeenCalledWith('High only', mocks.filterState.filters, {
      field: 'createdAt',
      direction: 'desc'
    })

    await user.click(screen.getByRole('button', { name: 'Apply filter' }))
    expect(mocks.updateFilters).toHaveBeenCalledWith({ priority: ['high'] })
    expect(mocks.updateSort).toHaveBeenCalledWith({ field: 'priority', direction: 'asc' })

    await user.click(screen.getByRole('button', { name: 'Delete filter' }))
    expect(mocks.deleteSavedFilter).toHaveBeenCalledWith('saved-1')

    fireEvent.keyDown(window, { key: 'F', shiftKey: true })
    expect(mocks.clearFilters).toHaveBeenCalled()
  })

  it('drives captured hook callbacks and add-task modal reset paths', async () => {
    const user = userEvent.setup()
    const onTasksChange = vi.fn()
    renderPage({ onTasksChange })

    mocks.undoableDeps.addTask(task)
    mocks.undoableDeps.updateTask('task-1', { title: 'Updated through deps' })
    mocks.undoableDeps.deleteTask('task-1')
    expect(mocks.addTask).toHaveBeenCalledWith(task)
    expect(mocks.updateTask).toHaveBeenCalledWith('task-1', { title: 'Updated through deps' })
    expect(mocks.deleteTask).toHaveBeenCalledWith('task-1')

    mocks.bulkDeps.onUpdateTask('task-1', { priority: 'urgent' })
    mocks.bulkDeps.onDeleteTask('task-1')
    mocks.bulkDeps.onComplete()
    mocks.bulkDeps.onAddTask(task)
    expect(mocks.updateTask).toHaveBeenCalledWith('task-1', { priority: 'urgent' })
    expect(mocks.deleteTask).toHaveBeenCalledWith('task-1')
    expect(mocks.deselectAll).toHaveBeenCalled()
    expect(mocks.addTask).toHaveBeenCalledWith(task)

    mocks.subtaskDeps.onTasksChange((current: Task[]) => [
      ...current,
      { ...task, id: 'task-2', title: 'Second' }
    ])
    mocks.subtaskDeps.onAddTask(task)
    mocks.subtaskDeps.onUpdateTask('task-1', { title: 'Subtask update' })
    mocks.subtaskDeps.onDeleteTask('task-1')
    mocks.subtaskDeps.onReorderTasks(['task-1'], { 'task-1': 1 })
    expect(onTasksChange).toHaveBeenCalledWith([task, expect.objectContaining({ id: 'task-2' })])
    expect(mocks.addTask).toHaveBeenCalledWith(task)
    expect(mocks.updateTask).toHaveBeenCalledWith('task-1', { title: 'Subtask update' })
    expect(mocks.deleteTask).toHaveBeenCalledWith('task-1')
    await waitFor(() => expect(mocks.taskReorder).toHaveBeenCalledWith(['task-1'], { 'task-1': 1 }))

    act(() => {
      mocks.saveFilterShortcut.onSave()
    })
    await user.click(screen.getByRole('button', { name: 'Save filter bar' }))

    await user.click(screen.getByRole('button', { name: 'Quick add status' }))
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Status task', statusId: 'p-done' })
    )

    await user.click(screen.getByRole('button', { name: 'Open add modal' }))
    expect(screen.getByText('Draft title')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save modal task' }))
    expect(mocks.createTask).toHaveBeenCalledWith(task)

    await user.click(screen.getByRole('button', { name: 'Open add modal' }))
    await user.click(screen.getByRole('button', { name: 'Close modal' }))
    expect(screen.queryByText('Draft title')).not.toBeInTheDocument()
  })

  it('persists task tab controls and clears saved filters when toggled off', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('radio', { name: 'page.viewMode.kanban' }))
    expect(mocks.saveTabState).toHaveBeenCalledWith(
      'tasks-tab',
      expect.objectContaining({ viewState: expect.objectContaining({ activeView: 'kanban' }) })
    )

    await user.click(screen.getByRole('button', { name: 'Pick project' }))
    expect(mocks.saveTabState).toHaveBeenCalledWith(
      'tasks-tab',
      expect.objectContaining({
        viewState: expect.objectContaining({ selectedProjectId: 'project-1' })
      })
    )

    await user.click(screen.getAllByRole('button', { name: 'Apply starred filter' })[0])
    expect(mocks.updateFilters).toHaveBeenCalledWith({ priority: ['high'] })

    await user.click(screen.getAllByRole('button', { name: 'Apply starred filter' })[0])
    expect(mocks.clearFilters).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Today tab' }))
    expect(mocks.saveTabState).toHaveBeenCalledWith(
      'tasks-tab',
      expect.objectContaining({
        viewState: expect.objectContaining({ activeInternalTab: 'today' })
      })
    )

    await user.click(screen.getByRole('button', { name: 'Unstar filter' }))
    expect(mocks.toggleStarFilter).toHaveBeenCalledWith('saved-1')
  })

  it('renders kanban mode and creates completed tasks from done-column quick add', async () => {
    const user = userEvent.setup()
    mocks.activeTabViewState = {
      activeInternalTab: 'all',
      activeTab: 'all',
      activeView: 'kanban',
      selectedProjectId: null,
      openTaskId: null
    }

    renderPage()

    await user.click(screen.getByRole('button', { name: 'Kanban quick add' }))
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Kanban task',
        statusId: 'p-done',
        completedAt: expect.any(Date)
      })
    )
  })

  it('falls back to the default view when tab state has no saved tab', () => {
    mocks.activeTabViewState = {
      activeView: 'list',
      selectedProjectId: null,
      openTaskId: null
    }

    renderPage()

    // With no saved tab, activeInternalTab resolves from taskPrefs.defaultView ('all').
    expect(screen.getByRole('button', { name: 'Today tab' })).toBeInTheDocument()
  })

  it('uses today defaults for quick add', async () => {
    const user = userEvent.setup()
    mocks.activeTabViewState = {
      activeInternalTab: 'today',
      activeTab: 'today',
      activeView: 'list',
      selectedProjectId: null,
      openTaskId: null
    }

    renderPage({ selectedId: 'today' })

    await user.click(screen.getByRole('button', { name: 'Quick add' }))
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Quick task', dueDate: expect.any(Date) })
    )
  })

  it('uncompletes already-done tasks and handles open drawer actions', async () => {
    const user = userEvent.setup()
    mocks.activeTabViewState = {
      activeInternalTab: 'all',
      activeTab: 'all',
      activeView: 'list',
      selectedProjectId: null,
      openTaskId: 'task-1'
    }
    const completedTask = { ...task, statusId: 'p-done', completedAt: null }

    renderPage({ tasks: [completedTask] })

    await user.click(screen.getByRole('button', { name: 'Toggle drawer task' }))
    expect(mocks.uncompleteTask).toHaveBeenCalledWith('task-1')

    await user.click(screen.getByRole('button', { name: 'Drawer linked note' }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', title: 'Linked Note', entityId: 'note-1' })
    )

    await user.click(screen.getByRole('button', { name: 'Close drawer' }))
    expect(mocks.saveTabState).toHaveBeenCalledWith(
      'tasks-tab',
      expect.objectContaining({ viewState: expect.objectContaining({ openTaskId: null }) })
    )

    await user.click(screen.getByRole('button', { name: 'Delete drawer task' }))
    expect(mocks.deleteTaskWithUndo).toHaveBeenCalledWith('task-1')
  })

  it('opens related audio items in the file viewer', async () => {
    const user = userEvent.setup()
    mocks.notesGetFile.mockResolvedValue({
      id: 'note-1',
      path: 'notes/Voice Memo.webm',
      absolutePath: '/vault/notes/Voice Memo.webm',
      title: 'Voice Memo',
      fileType: 'audio',
      mimeType: 'audio/webm',
      fileSize: 1234,
      created: new Date('2026-05-01'),
      modified: new Date('2026-05-01')
    })

    renderPage()

    await user.click(screen.getByRole('button', { name: 'Open linked note' }))

    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file',
        title: 'Voice Memo',
        icon: 'file-audio',
        path: '/file/note-1',
        entityId: 'note-1'
      })
    )
    expect(mocks.notesGet).not.toHaveBeenCalledWith('note-1')
  })

  it('executes project edit and modal save/delete flows', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Edit project' }))
    await user.click(screen.getByRole('button', { name: 'Close project' }))

    await user.click(screen.getByRole('button', { name: 'Edit project' }))
    await user.click(screen.getByRole('button', { name: 'Save project' }))
    expect(mocks.updateProject).toHaveBeenCalledWith('project-1', project)

    await user.click(screen.getByRole('button', { name: 'Edit project' }))
    await user.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(mocks.deleteProject).toHaveBeenCalledWith('project-1')
  })

  it('executes selection shortcuts and bulk actions', async () => {
    const user = userEvent.setup()
    mocks.selectionState.selectedCount = 1
    mocks.selectionState.hasSelection = true
    mocks.selectionState.someSelected = true
    mocks.selectionState.selectedTaskIds = ['task-1']
    mocks.selectionState.selectedIds = new Set(['task-1'])

    renderPage()

    fireEvent.keyDown(window, { key: 'a', metaKey: true })
    expect(mocks.selectAll).toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Enter', metaKey: true })
    expect(mocks.bulkComplete).toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Backspace', metaKey: true })
    await user.click(screen.getByRole('button', { name: 'Close bulk delete' }))

    await user.click(screen.getByRole('button', { name: 'Bulk priority' }))
    expect(mocks.bulkChangePriority).toHaveBeenCalledWith('urgent')

    await user.click(screen.getByRole('button', { name: 'Bulk due date' }))
    expect(mocks.bulkChangeDueDate).toHaveBeenCalledWith(expect.any(Date))

    await user.click(screen.getByRole('button', { name: 'Bulk today' }))
    expect(mocks.bulkChangeDueDate).toHaveBeenCalledWith(expect.any(Date))

    await user.click(screen.getByRole('button', { name: 'Bulk pick date' }))
    await user.click(screen.getByRole('button', { name: 'Pick bulk due date' }))
    expect(mocks.bulkChangeDueDate).toHaveBeenCalledWith(new Date('2026-05-10'))

    await user.click(screen.getByRole('button', { name: 'Bulk pick date' }))
    await user.click(screen.getByRole('button', { name: 'Close due picker' }))

    await user.click(screen.getByRole('button', { name: 'Bulk remove due date' }))
    expect(mocks.bulkChangeDueDate).toHaveBeenCalledWith(null)

    await user.click(screen.getByRole('button', { name: 'Bulk next week' }))
    await user.click(screen.getByRole('button', { name: 'Bulk next month' }))
    expect(mocks.bulkChangeDueDate).toHaveBeenCalledTimes(6)

    await user.click(screen.getByRole('button', { name: 'Bulk move' }))
    expect(mocks.bulkMoveToProject).toHaveBeenCalledWith('project-1')

    await user.click(screen.getByRole('button', { name: 'Bulk status' }))
    expect(mocks.bulkChangeStatus).toHaveBeenCalledWith('p-done')

    await user.click(screen.getByRole('button', { name: 'Bulk archive' }))
    expect(mocks.bulkArchive).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Bulk delete' }))
    await user.click(screen.getByRole('button', { name: 'Confirm bulk delete' }))
    expect(mocks.bulkDelete).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Bulk cancel' }))
    expect(mocks.deselectAll).toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mocks.deselectAll).toHaveBeenCalled()
  })

  it('covers selected project statuses and project delete reset/error paths', async () => {
    const user = userEvent.setup()
    mocks.selectionState.selectedCount = 1
    mocks.selectionState.hasSelection = true
    mocks.selectionState.selectedTaskIds = ['task-1']
    mocks.selectionState.selectedIds = new Set(['task-1'])
    mocks.activeTabViewState = {
      activeInternalTab: 'all',
      activeTab: 'all',
      activeView: 'list',
      selectedProjectId: 'project-1',
      openTaskId: null
    }

    renderPage({ selectedId: 'project-1', selectedType: 'project' })
    expect(screen.getByTestId('bulk-status-count')).toHaveTextContent('2')

    await user.click(screen.getByRole('button', { name: 'Edit project' }))
    await user.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(mocks.deleteProject).toHaveBeenCalledWith('project-1')
    expect(mocks.saveTabState).toHaveBeenCalledWith(
      'tasks-tab',
      expect.objectContaining({ viewState: expect.objectContaining({ selectedProjectId: null }) })
    )

    mocks.deleteProject.mockRejectedValueOnce(new Error('delete failed'))
    await user.click(screen.getByRole('button', { name: 'Edit project' }))
    await user.click(screen.getByRole('button', { name: 'Delete project' }))
    expect(mocks.deleteProject).toHaveBeenCalledTimes(2)
  })

  it('covers project save errors, list view toggle, and open subtask dialog props', async () => {
    const user = userEvent.setup()
    mocks.updateProject.mockRejectedValueOnce(new Error('save failed'))
    mocks.activeTabViewState = {
      activeInternalTab: 'all',
      activeTab: 'all',
      activeView: 'kanban',
      selectedProjectId: 'project-1',
      openTaskId: null
    }
    mocks.subtaskState.allSubtasksCompleteDialogOpen = true
    mocks.subtaskState.pendingAutoCompleteParent = task
    mocks.subtaskState.bulkDueDateDialogOpen = true
    mocks.subtaskState.bulkPriorityDialogOpen = true
    mocks.subtaskState.deleteAllSubtasksDialogOpen = true
    mocks.subtaskState.pendingBulkOperationParent = task
    mocks.subtaskState.pendingBulkOperationSubtasks = [
      { ...task, id: 'sub-1', completedAt: new Date('2026-05-10') },
      { ...task, id: 'sub-2', completedAt: null }
    ]

    renderPage()

    await user.click(screen.getByRole('radio', { name: 'page.viewMode.list' }))
    expect(mocks.saveTabState).toHaveBeenCalledWith(
      'tasks-tab',
      expect.objectContaining({ viewState: expect.objectContaining({ activeView: 'list' }) })
    )

    await user.click(screen.getByRole('button', { name: 'Edit project' }))
    await user.click(screen.getByRole('button', { name: 'Save project' }))
    expect(mocks.updateProject).toHaveBeenCalledWith('project-1', project)

    expect(screen.getByTestId('all-subtasks-dialog')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('bulk-subtask-due-dialog')).toHaveTextContent('1')
    expect(screen.getByTestId('bulk-subtask-priority-dialog')).toHaveTextContent('1')
    expect(screen.getByTestId('delete-subtasks-dialog')).toHaveTextContent('2')
  })

  it('renders the filter empty state when active filters remove all tasks', async () => {
    const user = userEvent.setup()
    mocks.filterState.hasActiveFilters = true

    renderPage()

    await user.click(screen.getByRole('button', { name: 'Empty filters' }))
    expect(mocks.clearFilters).toHaveBeenCalled()
  })
})
