import { useState, useMemo, useCallback, useEffect, useRef } from 'react'

import { toast } from 'sonner'
import { TaskList } from '@/components/tasks/task-list'
import { TasksTabBar, type TasksInternalTab } from '@/components/tasks/tasks-tab-bar'
import { ProjectsTabContent } from '@/components/tasks/projects/projects-tab-content'
import { ProjectSelector } from '@/components/tasks/projects/project-selector'
import { AddTaskModal } from '@/components/tasks/add-task-modal'
import { ProjectModal } from '@/components/tasks/project-modal'
import { KanbanBoard } from '@/components/tasks/kanban'
import { QuickAddInput } from '@/components/tasks/quick-add-input'
import { TaskDetailDrawer } from '@/components/tasks/task-detail-drawer'
import {
  FilterBar,
  FilterDropdown,
  FilterEmptyState,
  GroupByDropdown
} from '@/components/tasks/filters'
import { cn } from '@/lib/utils'
import { PageToolbar } from '@/components/ui/page-toolbar'
import {
  getFilteredTasks,
  getDefaultTodoStatus,
  startOfDay,
  getCompletedTasks,
  getCompletedTodayTasks,
  getTodayTasks,
  countActiveFilters,
  scopeTasksByProject,
  applyFiltersAndSort
} from '@/lib/task-utils'
import {
  type Project,
  type ViewMode,
  type TaskFilters,
  type TaskSort,
  type SavedFilter,
  type CompletionFilterType
} from '@/data/tasks-data'
import { createDefaultTask, type Task, type Priority } from '@/data/sample-tasks'
import { addDays } from '@/lib/task-utils' // used by handleBulkChangeDueDate
import {
  useFilterState,
  useSavedFilters,
  useFilteredAndSortedTasks,
  useTaskSelection,
  useBulkActions,
  useSubtaskManagement,
  useUndoTracker
} from '@/hooks'
import { useUndoableTaskActions } from '@/hooks/use-undoable-task-actions'
import { useTasksContext } from '@/contexts/tasks'
import { useSaveFilterShortcut } from '@/hooks/use-save-filter-shortcut'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import {
  resolveModalDefaultProject,
  resolveInitialViewProject,
  resolveQuickAddProject
} from '@/lib/default-project-resolution'
import {
  BulkActionToolbar,
  BulkDeleteDialog,
  BulkDueDatePicker
} from '@/components/tasks/bulk-actions'
import {
  AllSubtasksCompleteDialog,
  BulkDueDateDialog,
  BulkPriorityDialog,
  DeleteAllSubtasksDialog
} from '@/components/tasks/dialogs'
import { getSubtasks } from '@/lib/subtask-utils'
import { tasksService } from '@/services/tasks-service'
import type { TaskSelectionType } from '@/App'
import { createLogger } from '@/lib/logger'
import { useTabActions, useActiveTab } from '@/contexts/tabs'
import { notesService } from '@/services/notes-service'

const log = createLogger('Page:Tasks')

// ============================================================================
// TYPES
// ============================================================================

interface TasksPageProps {
  className?: string
  selectedId: string
  selectedType: TaskSelectionType
  tasks: Task[]
  projects: Project[]
  onTasksChange: (tasks: Task[]) => void
  onSelectionChange: (id: string, type: TaskSelectionType) => void
  /** Task IDs currently selected for multi-drag (passed from App level) */
  selectedTaskIds?: Set<string>
  /** Callback to sync selection state with App level */
  onSelectedTaskIdsChange?: (ids: Set<string>) => void
}

// ============================================================================
// MAIN TASKS PAGE COMPONENT
// ============================================================================

export const TasksPage = ({
  className,
  selectedId,
  selectedType,
  tasks,
  projects,
  onTasksChange,
  onSelectionChange,
  selectedTaskIds: externalSelectedIds,
  onSelectedTaskIdsChange
}: TasksPageProps): React.JSX.Element => {
  // Get database-aware task operations from context
  const {
    addTask: contextAddTask,
    updateTask: contextUpdateTask,
    deleteTask: contextDeleteTask,
    addProject: contextAddProject,
    updateProject: contextUpdateProject,
    deleteProject: contextDeleteProject,
    getOrderedTasks
  } = useTasksContext()

  // T051-T054: Undo tracking for Cmd+Z support
  const { registerUndo, removeUndoEntry } = useUndoTracker()

  const undoable = useUndoableTaskActions({
    tasks,
    projects,
    addTask: contextAddTask,
    updateTask: contextUpdateTask,
    deleteTask: contextDeleteTask,
    registerUndo,
    removeUndoEntry
  })

  const { settings: taskPrefs } = useTaskPreferences()
  const { openTab } = useTabActions()
  const activeTab = useActiveTab()

  const handleNoteClick = useCallback(
    async (noteId: string) => {
      const note = await notesService.get(noteId)
      openTab({
        type: 'note',
        title: note?.title ?? 'Untitled',
        icon: 'file-text',
        emoji: note?.emoji,
        path: `/notes/${noteId}`,
        entityId: noteId,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    },
    [openTab]
  )

  // Local setter that updates via parent callback
  const setTasks = useCallback(
    (updater: Task[] | ((prev: Task[]) => Task[])) => {
      if (typeof updater === 'function') {
        onTasksChange(updater(tasks))
      } else {
        onTasksChange(updater)
      }
    },
    [tasks, onTasksChange]
  )

  // View mode state
  const [activeView, setActiveViewRaw] = useState<ViewMode>('list')

  // Internal tab state for the new tab bar navigation (default to Today)
  const [activeInternalTab, setActiveInternalTab] = useState<TasksInternalTab>('today')

  // Track selected project for "All projects" filter dropdown
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const hasAppliedDefaultProject = useRef(false)

  useEffect(() => {
    if (hasAppliedDefaultProject.current) return
    const resolved = resolveInitialViewProject(selectedType, taskPrefs.defaultProjectId, projects)
    if (resolved) {
      setSelectedProjectId(resolved)
      hasAppliedDefaultProject.current = true
    }
  }, [selectedType, taskPrefs.defaultProjectId, projects])

  // Task detail drawer state
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)

  // Restore viewState from tab (e.g. navigating from journal sidebar)
  const lastAppliedTaskId = useRef<string | null>(null)
  const incomingTaskId = (activeTab?.viewState?.openTaskId as string) ?? null
  const incomingProjectId = (activeTab?.viewState?.selectedProjectId as string) ?? null
  const incomingActiveTab = (activeTab?.viewState?.activeTab as TasksInternalTab) ?? null

  useEffect(() => {
    if (!incomingTaskId || incomingTaskId === lastAppliedTaskId.current) return
    lastAppliedTaskId.current = incomingTaskId
    setDetailTaskId(incomingTaskId)
    if (incomingProjectId) {
      setSelectedProjectId(incomingProjectId)
      hasAppliedDefaultProject.current = true
    }
    if (incomingActiveTab) {
      setActiveInternalTab(incomingActiveTab)
    }
  }, [incomingTaskId, incomingProjectId, incomingActiveTab])

  // Modal states
  const [isAddTaskModalOpen, setIsAddTaskModalOpen] = useState(false)
  const [addTaskPrefillTitle, setAddTaskPrefillTitle] = useState('')
  const [addTaskPrefillDueDate, setAddTaskPrefillDueDate] = useState<Date | null>(null)
  const [addTaskPrefillProjectId, setAddTaskPrefillProjectId] = useState<string | null>(null)

  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false)

  // Filter state with persistence
  const {
    filters,
    sort,
    updateFilters,
    updateSort,
    clearFilters,
    hasActiveFilters: filtersActive
  } = useFilterState({
    selectedType,
    selectedId,
    activeView,
    persistFilters: true
  })

  const setActiveView = useCallback((view: ViewMode) => {
    setActiveViewRaw(view)
  }, [])

  // Saved filters
  const {
    savedFilters,
    saveFilter,
    deleteFilter: deleteSavedFilter,
    toggleStar: toggleStarFilter
  } = useSavedFilters()
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null)

  const starredFilters = useMemo(() => savedFilters.filter((f) => f.starred), [savedFilters])

  useSaveFilterShortcut({
    onSave: () => setIsFilterDropdownOpen(true),
    hasActiveFilters: filtersActive
  })

  const updateFiltersAndClearSaved = useCallback(
    (updates: Partial<TaskFilters>) => {
      setActiveSavedFilterId(null)
      updateFilters(updates)
    },
    [updateFilters]
  )

  const clearFiltersAndClearSaved = useCallback(() => {
    setActiveSavedFilterId(null)
    clearFilters()
  }, [clearFilters])

  const handleTabChange = useCallback(
    (tab: TasksInternalTab) => {
      if (activeSavedFilterId) {
        setActiveSavedFilterId(null)
        clearFilters()
      }
      setActiveInternalTab(tab)
    },
    [activeSavedFilterId, clearFilters]
  )

  // Bulk delete dialog state
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false)

  // Bulk due date picker state
  const [isBulkDueDatePickerOpen, setIsBulkDueDatePickerOpen] = useState(false)

  // Project modal states
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

  // ========== DERIVED STATE ==========

  // Derived: get the selected project (if any)
  const selectedProject = useMemo(() => {
    if (selectedType === 'project') {
      return projects.find((p) => p.id === selectedId) || null
    }
    return null
  }, [selectedId, selectedType, projects])

  const availableViews = useMemo((): ViewMode[] => {
    if (activeInternalTab === 'today') {
      return ['list']
    }
    return ['list', 'kanban']
  }, [activeInternalTab])

  // Reset to list view if current view becomes unavailable
  useEffect(() => {
    if (!availableViews.includes(activeView)) {
      setActiveView('list')
    }
  }, [availableViews, activeView])

  // Derived: filtered tasks for current selection, scoped by dropdown project
  const baseFilteredTasks = useMemo(() => {
    const base = getFilteredTasks(tasks, selectedId, selectedType, projects)
    return scopeTasksByProject(base, selectedProjectId)
  }, [tasks, selectedId, selectedType, projects, selectedProjectId])

  // Apply advanced filters and sort to base filtered tasks
  const { filteredTasks, totalCount, filteredCount } = useFilteredAndSortedTasks({
    tasks: baseFilteredTasks,
    filters,
    sort,
    projects
  })

  // Kanban needs completed tasks for the Done column — filteredTasks excludes them
  const kanbanTasks = useMemo(() => {
    if (activeView !== 'kanban') return filteredTasks
    const nonArchived = tasks.filter((t) => !t.archivedAt)
    const scoped = scopeTasksByProject(nonArchived, selectedProjectId)
    return applyFiltersAndSort(scoped, { ...filters, completion: 'all' }, sort, projects)
  }, [activeView, filteredTasks, tasks, selectedProjectId, filters, sort, projects])

  // Check if we should show the filter empty state
  const showFilterEmptyState = filtersActive && filteredCount === 0 && totalCount > 0

  // Derived: today tab tasks (overdue + today, flat)
  const todayFilteredTasks = useMemo(() => {
    const { overdue, today } = getTodayTasks(filteredTasks, projects)
    return [...overdue, ...today]
  }, [filteredTasks, projects])

  const selectionScopeTasks = useMemo(() => {
    if (activeInternalTab === 'today') {
      return todayFilteredTasks
    }

    return filteredTasks
  }, [activeInternalTab, filteredTasks, todayFilteredTasks])

  const visibleTaskIds = useMemo(() => selectionScopeTasks.map((t) => t.id), [selectionScopeTasks])

  // Task selection hook
  const {
    selection,
    selectedCount,
    hasSelection,
    allSelected,
    someSelected,
    selectedTaskIds,
    toggleTask,
    selectRange,
    selectAll,
    deselectAll,
    toggleSelectAll,
    enterSelectionMode,
    exitSelectionMode
  } = useTaskSelection(visibleTaskIds, {
    controlledSelectedIds: externalSelectedIds,
    onSelectionChange: onSelectedTaskIdsChange
  })

  // Bulk actions hook - use context functions to persist to database
  const bulkActions = useBulkActions({
    selectedIds: selectedTaskIds,
    tasks,
    projects,
    onUpdateTask: contextUpdateTask,
    onDeleteTask: contextDeleteTask,
    onComplete: deselectAll,
    registerUndo,
    onAddTask: contextAddTask
  })

  // Toggle selection mode handler
  const handleToggleSelectionMode = useCallback(() => {
    if (selection.isSelectionMode) {
      exitSelectionMode()
    } else {
      enterSelectionMode()
    }
  }, [selection.isSelectionMode, enterSelectionMode, exitSelectionMode])

  // Subtask management hook - T038-T042: Wire to database via context operations
  const subtaskManagement = useSubtaskManagement({
    tasks,
    projects,
    onTasksChange: setTasks,
    onAddTask: contextAddTask,
    onUpdateTask: contextUpdateTask,
    onDeleteTask: contextDeleteTask,
    onReorderTasks: async (taskIds, positions) => {
      try {
        await tasksService.reorder(taskIds, positions)
      } catch (error) {
        log.error('Failed to reorder subtasks:', error)
      }
    }
  })

  // Derived: tab counts for TasksTabBar (scoped by dropdown project)
  const tabCounts = useMemo(() => {
    const scopedTasks = scopeTasksByProject(tasks, selectedProjectId)
    const allActive = getFilteredTasks(scopedTasks, 'all', 'view', projects)
    const todayResult = getTodayTasks(scopedTasks, projects)
    const todayCount =
      todayResult.overdue.filter((t) => t.parentId === null).length +
      todayResult.today.filter((t) => t.parentId === null).length

    return {
      today: todayCount,
      all: allActive.length
    }
  }, [tasks, projects, selectedProjectId])

  const allTabDoneTasks = useMemo(
    () => scopeTasksByProject(getCompletedTasks(tasks), selectedProjectId),
    [tasks, selectedProjectId]
  )

  const todayTabDoneTasks = useMemo(
    () => scopeTasksByProject(getCompletedTodayTasks(tasks), selectedProjectId),
    [tasks, selectedProjectId]
  )

  // Visibility constants
  const showFilterBar = true

  // ========== HANDLERS ==========

  // Task detail drawer
  const detailTask = useMemo(
    () => (detailTaskId ? (tasks.find((t) => t.id === detailTaskId) ?? null) : null),
    [detailTaskId, tasks]
  )

  const handleTaskClick = useCallback((taskId: string) => {
    setDetailTaskId((prev) => (prev === taskId ? null : taskId))
  }, [])

  const handleCloseDetail = useCallback(() => {
    setDetailTaskId(null)
  }, [])

  // Selection change handler (kept for interface compatibility)
  const _handleSelectView = (id: string): void => {
    onSelectionChange(id, 'view')
  }

  const handleProjectSettings = (): void => {
    // Project settings are now handled in AppSidebar
    // This is kept for the settings button in the header
    // We could emit an event or use a context here
  }

  // ========== PROJECT HANDLERS ==========

  const handleCreateProject = useCallback(() => {
    setEditingProject(null)
    setIsProjectModalOpen(true)
  }, [])

  const handleEditProject = useCallback((project: Project) => {
    setEditingProject(project)
    setIsProjectModalOpen(true)
  }, [])

  const handleSaveProject = useCallback(
    async (project: Project) => {
      try {
        if (editingProject) {
          await contextUpdateProject(project.id, project)
          toast.success('Project updated')
        } else {
          await contextAddProject(project)
          toast.success('Project created')
        }
        setIsProjectModalOpen(false)
        setEditingProject(null)
      } catch (error) {
        log.error('Failed to save project:', error)
        toast.error('Failed to save project')
      }
    },
    [editingProject, contextAddProject, contextUpdateProject]
  )

  const handleArchiveProject = useCallback(
    async (project: Project) => {
      try {
        await contextUpdateProject(project.id, { isArchived: true })
        toast.success('Project archived')
      } catch (error) {
        log.error('Failed to archive project:', error)
        toast.error('Failed to archive project')
      }
    },
    [contextUpdateProject]
  )

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      try {
        await contextDeleteProject(projectId)
        toast.success('Project deleted')
        // If we were viewing the deleted project, reset selection
        if (selectedProjectId === projectId) {
          setSelectedProjectId(null)
        }
      } catch (error) {
        log.error('Failed to delete project:', error)
        toast.error('Failed to delete project')
      }
    },
    [contextDeleteProject, selectedProjectId]
  )

  // Keyboard shortcuts for filter operations and selection
  useEffect(() => {
    const isInputFocused = (): boolean => {
      const activeElement = document.activeElement
      return (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement as HTMLElement)?.isContentEditable === true
      )
    }

    const handler = (e: KeyboardEvent): void => {
      // Shift+F to clear all filters
      if (e.key === 'F' && e.shiftKey && !isInputFocused() && showFilterBar) {
        e.preventDefault()
        clearFilters()
        toast.success('Filters cleared')
      }

      // Cmd/Ctrl+A to select all visible tasks
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !isInputFocused()) {
        e.preventDefault()
        selectAll()
      }

      // Escape to clear selection
      if (e.key === 'Escape' && hasSelection) {
        e.preventDefault()
        deselectAll()
      }

      // Cmd/Ctrl+Enter to complete selected tasks
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && hasSelection) {
        e.preventDefault()
        bulkActions.bulkComplete()
      }

      // Cmd/Ctrl+Backspace to delete selected tasks
      if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace' && hasSelection) {
        e.preventDefault()
        setIsBulkDeleteDialogOpen(true)
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showFilterBar, clearFilters, hasSelection, selectAll, deselectAll, bulkActions])

  const handleAddTask = (): void => {
    setAddTaskPrefillTitle('')
    setAddTaskPrefillDueDate(null)
    setAddTaskPrefillProjectId(null)
    setIsAddTaskModalOpen(true)
  }

  const handleOpenAddTaskModal = useCallback((prefillTitle: string): void => {
    setAddTaskPrefillTitle(prefillTitle)
    setAddTaskPrefillDueDate(null)
    setAddTaskPrefillProjectId(null)
    setIsAddTaskModalOpen(true)
  }, [])

  const handleAddTaskModalClose = (): void => {
    setIsAddTaskModalOpen(false)
    setAddTaskPrefillTitle('')
    setAddTaskPrefillDueDate(null)
    setAddTaskPrefillProjectId(null)
  }

  const handleAddTaskFromModal = useCallback(
    (newTask: Task): void => {
      undoable.createTask(newTask)
    },
    [undoable]
  )

  // Get default project and due date for the modal based on current selection
  const modalDefaultProjectId = useMemo(
    () =>
      resolveModalDefaultProject(
        { selectedType, selectedProject },
        taskPrefs.defaultProjectId,
        selectedProjectId
      ),
    [selectedType, selectedProject, taskPrefs.defaultProjectId, selectedProjectId]
  )

  const quickAddProjectColor = useMemo((): string => {
    const projectId = resolveQuickAddProject(
      null,
      { selectedType, selectedProject },
      taskPrefs.defaultProjectId,
      projects,
      selectedProjectId
    )
    const project = projects.find((p) => p.id === projectId)
    return project?.color || '#6B7280'
  }, [selectedType, selectedProject, taskPrefs.defaultProjectId, projects, selectedProjectId])

  const modalDefaultDueDate = useMemo((): Date | null => {
    if (selectedId === 'today') {
      return startOfDay(new Date())
    }
    return null
  }, [selectedId])

  const handleQuickAdd = useCallback(
    (
      title: string,
      parsedData?: {
        dueDate: Date | null
        priority: Priority
        projectId: string | null
        statusId?: string | null
      }
    ): void => {
      const projectId = resolveQuickAddProject(
        parsedData?.projectId,
        { selectedType, selectedProject },
        taskPrefs.defaultProjectId,
        projects,
        selectedProjectId
      )
      let dueDate = parsedData?.dueDate || null
      const priority = parsedData?.priority || 'none'

      if (!parsedData?.dueDate) {
        if (selectedId === 'today') {
          dueDate = startOfDay(new Date())
        }
      }

      const project = projects.find((p) => p.id === projectId)

      let statusId: string
      if (parsedData?.statusId) {
        statusId = parsedData.statusId
      } else {
        const defaultStatus = project ? getDefaultTodoStatus(project) : null
        statusId = defaultStatus?.id || project?.statuses[0]?.id || 'p-todo'
      }

      const newTask = createDefaultTask(projectId, statusId, title, dueDate)
      newTask.priority = priority

      undoable.createTask(newTask)
    },
    [
      selectedId,
      selectedType,
      selectedProject,
      selectedProjectId,
      projects,
      undoable,
      taskPrefs.defaultProjectId
    ]
  )

  const handleKanbanQuickAdd = useCallback(
    (title: string, columnId: string): void => {
      const project = selectedProject || projects[0]
      if (!project) return

      const status = project.statuses.find((s) => s.id === columnId)
      const statusId = status?.id || getDefaultTodoStatus(project)?.id || project.statuses[0]?.id
      if (!statusId) return

      const newTask = createDefaultTask(project.id, statusId, title)

      if (status?.type === 'done') {
        newTask.completedAt = new Date()
      }

      undoable.createTask(newTask)
    },
    [selectedProject, projects, undoable]
  )

  const handleToggleComplete = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return

      const currentStatus = project.statuses.find((s) => s.id === task.statusId)
      if (!currentStatus) return

      if (currentStatus.type === 'done') {
        undoable.uncompleteTask(taskId)
      } else {
        undoable.completeTask(taskId)
      }
    },
    [tasks, projects, undoable]
  )

  const handleUpdateTask = useCallback(
    (taskId: string, updates: Partial<Task>): void => {
      undoable.updateTaskWithUndo(taskId, updates)
    },
    [undoable]
  )

  const handleDeleteTask = useCallback(
    (taskId: string): void => {
      undoable.deleteTask(taskId)
    },
    [undoable]
  )

  const handleDeleteTaskFromDrawer = useCallback(
    (taskId: string): void => {
      undoable.deleteTask(taskId)
      setDetailTaskId(null)
    },
    [undoable]
  )

  // ========== BULK ACTION HANDLERS ==========

  const handleBulkChangePriority = useCallback(
    (priority: Priority): void => {
      bulkActions.bulkChangePriority(priority)
    },
    [bulkActions]
  )

  const handleBulkChangeDueDate = useCallback(
    (option: string): void => {
      if (option === 'pick-date') {
        setIsBulkDueDatePickerOpen(true)
        return
      }

      if (option === 'remove') {
        bulkActions.bulkChangeDueDate(null)
        return
      }

      const today = startOfDay(new Date())
      let newDate: Date | null = null

      switch (option) {
        case 'today':
          newDate = today
          break
        case 'tomorrow':
          newDate = addDays(today, 1)
          break
        case 'next-week':
          newDate = addDays(today, 7)
          break
        case 'next-month':
          newDate = addDays(today, 30)
          break
      }

      if (newDate) {
        bulkActions.bulkChangeDueDate(newDate)
      }
    },
    [bulkActions]
  )

  const handleBulkDueDateConfirm = useCallback(
    (date: Date, _time: string | null): void => {
      bulkActions.bulkChangeDueDate(date)
    },
    [bulkActions]
  )

  const handleBulkMoveToProject = useCallback(
    (projectId: string): void => {
      bulkActions.bulkMoveToProject(projectId)
    },
    [bulkActions]
  )

  const handleBulkChangeStatus = useCallback(
    (statusId: string): void => {
      bulkActions.bulkChangeStatus(statusId)
    },
    [bulkActions]
  )

  const handleBulkDeleteConfirm = useCallback((): void => {
    bulkActions.bulkDelete()
    setIsBulkDeleteDialogOpen(false)
  }, [bulkActions])

  // ========== FILTER HANDLERS ==========

  const handleSaveFilter = useCallback(
    (name: string, filterState: TaskFilters, sortState?: TaskSort): void => {
      saveFilter(name, filterState, sortState)
      toast.success('Filter saved', {
        description: `"${name}" has been saved to your filters.`
      })
    },
    [saveFilter]
  )

  const handleDeleteSavedFilter = useCallback(
    (filterId: string): void => {
      deleteSavedFilter(filterId)
      if (activeSavedFilterId === filterId) {
        setActiveSavedFilterId(null)
        clearFilters()
      }
      toast.success('Filter deleted')
    },
    [deleteSavedFilter, activeSavedFilterId, clearFilters]
  )

  const handleApplySavedFilter = useCallback(
    (savedFilter: SavedFilter): void => {
      if (activeSavedFilterId === savedFilter.id) {
        clearFilters()
        setActiveSavedFilterId(null)
        return
      }
      updateFilters(savedFilter.filters)
      if (savedFilter.sort) {
        updateSort(savedFilter.sort)
      }
      setActiveSavedFilterId(savedFilter.id)
      toast.success(`Applied "${savedFilter.name}"`)
    },
    [activeSavedFilterId, updateFilters, updateSort, clearFilters]
  )

  const currentProjectStatuses = useMemo(() => {
    if (selectedType === 'project' && selectedProject) {
      return selectedProject.statuses
    }
    if (selectedProjectId) {
      const proj = projects.find((p) => p.id === selectedProjectId)
      if (proj) return proj.statuses
    }
    return []
  }, [selectedType, selectedProject, selectedProjectId, projects])

  return (
    <>
      <div className={cn('h-full flex overflow-hidden', className)}>
        {/* Main Content Area */}
        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Page Header — compact single-row toolbar */}
          <PageToolbar className="px-2 py-1 min-h-[38px]">
            <TasksTabBar
              activeTab={activeInternalTab}
              onTabChange={handleTabChange}
              counts={tabCounts}
              projects={projects}
              selectedProjectId={selectedProjectId}
              onProjectChange={setSelectedProjectId}
              onProjectEdit={handleEditProject}
              savedFilters={starredFilters}
              activeSavedFilterId={activeSavedFilterId}
              onApplySavedFilter={handleApplySavedFilter}
              onUnstarSavedFilter={toggleStarFilter}
            />

            {/* Inline Quick-Add Input */}
            <QuickAddInput
              compact
              onAdd={handleQuickAdd}
              onOpenModal={handleOpenAddTaskModal}
              projects={projects}
              projectColor={quickAddProjectColor}
            />

            {/* Filter Button */}
            <FilterDropdown
              open={isFilterDropdownOpen}
              onOpenChange={setIsFilterDropdownOpen}
              filters={filters}
              onUpdateFilters={updateFiltersAndClearSaved}
              onClearFilters={clearFiltersAndClearSaved}
              tasks={baseFilteredTasks}
              projects={projects}
              savedFilters={savedFilters}
              activeSavedFilterId={activeSavedFilterId}
              hasActiveFilters={filtersActive}
              onDeleteSavedFilter={handleDeleteSavedFilter}
              onApplySavedFilter={handleApplySavedFilter}
              onSaveFilter={(name) => handleSaveFilter(name, filters, sort)}
              onToggleStarFilter={toggleStarFilter}
              statuses={currentProjectStatuses}
            >
              <button
                type="button"
                className={cn(
                  'flex items-center shrink-0 rounded-[5px] py-1 px-2 gap-1 border transition-colors',
                  isFilterDropdownOpen || filtersActive
                    ? 'border-foreground/20 bg-foreground/5 text-foreground/90'
                    : 'border-border text-muted-foreground hover:bg-surface-active/50'
                )}
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <path
                    d="M2 3h9M3.5 6.5h6M5 10h3"
                    stroke="currentColor"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="text-[12px] font-medium">Filter</span>
                {filtersActive && (
                  <span className="flex items-center justify-center size-[14px] rounded-full bg-foreground text-background text-[9px] font-bold">
                    {countActiveFilters(filters)}
                  </span>
                )}
              </button>
            </FilterDropdown>

            {/* Group By Button */}
            <GroupByDropdown sort={sort} onChange={updateSort} />

            {/* View Mode Switcher */}
            {availableViews.length > 1 && (
              <div
                className="flex items-center shrink-0 rounded-[5px] overflow-clip border border-border"
                role="radiogroup"
                aria-label="View mode"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={activeView === 'list'}
                  aria-label="List view"
                  onClick={() => setActiveView('list')}
                  className={cn(
                    'flex items-center justify-center w-[26px] h-6 shrink-0 transition-colors',
                    activeView === 'list'
                      ? 'bg-foreground/10 text-foreground'
                      : 'text-text-tertiary hover:text-text-secondary'
                  )}
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                    <path
                      d="M2 3.5h9M2 6.5h9M2 9.5h9"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                {availableViews.includes('kanban') && (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={activeView === 'kanban'}
                    aria-label="Kanban view"
                    onClick={() => setActiveView('kanban')}
                    className={cn(
                      'flex items-center justify-center w-[26px] h-6 shrink-0 transition-colors',
                      activeView === 'kanban'
                        ? 'bg-foreground/10 text-foreground'
                        : 'text-text-tertiary hover:text-text-secondary'
                    )}
                  >
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <rect x="1.5" y="2" width="2.5" height="9" rx="0.75" stroke="currentColor" />
                      <rect
                        x="5.25"
                        y="2"
                        width="2.5"
                        height="6.5"
                        rx="0.75"
                        stroke="currentColor"
                      />
                      <rect x="9" y="2" width="2.5" height="4.5" rx="0.75" stroke="currentColor" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </PageToolbar>

          {/* Active Filter Chips */}
          {showFilterBar && (
            <FilterBar
              filters={filters}
              projects={projects}
              onUpdateFilters={updateFiltersAndClearSaved}
              onClearFilters={clearFiltersAndClearSaved}
              onSaveFilter={() => setIsFilterDropdownOpen(true)}
              isSaved={activeSavedFilterId !== null}
            />
          )}

          {/* Bulk Action Toolbar - shown when tasks are selected */}
          {hasSelection && (
            <BulkActionToolbar
              selectedCount={selectedCount}
              allSelected={allSelected}
              someSelected={someSelected}
              onToggleSelectAll={toggleSelectAll}
              onComplete={bulkActions.bulkComplete}
              onChangePriority={handleBulkChangePriority}
              onChangeDueDate={handleBulkChangeDueDate}
              onMoveToProject={handleBulkMoveToProject}
              onChangeStatus={handleBulkChangeStatus}
              onArchive={bulkActions.bulkArchive}
              onDelete={() => setIsBulkDeleteDialogOpen(true)}
              onCancel={deselectAll}
              projects={projects}
              statuses={currentProjectStatuses}
              showStatusAction={false}
            />
          )}

          {/* Content Body - Today Tab (flat listing of overdue + today tasks) */}
          {activeInternalTab === 'today' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <TaskList
                tasks={todayFilteredTasks}
                projects={projects}
                selectedId="today"
                selectedType="view"
                onToggleComplete={handleToggleComplete}
                onUpdateTask={handleUpdateTask}
                onToggleSubtaskComplete={subtaskManagement.handleCompleteSubtask}
                onQuickAdd={handleQuickAdd}
                onTaskClick={handleTaskClick}
                selectedTaskId={detailTaskId}
                isSelectionMode={selection.isSelectionMode}
                selectedIds={selection.selectedIds}
                onToggleSelect={toggleTask}
                onShiftSelect={selectRange}
                onReorderSubtasks={subtaskManagement.handleReorderSubtasks}
                onAddSubtask={subtaskManagement.handleAddSubtask}
                sortField={sort.field}
                sortDirection={sort.direction}
                showProjectBadge={!selectedProjectId}
                doneTasks={todayTabDoneTasks}
                getOrderedTasks={getOrderedTasks}
              />
            </div>
          )}

          {/* Content Body - All Tab (List View) */}
          {activeInternalTab === 'all' && activeView === 'list' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              {showFilterEmptyState ? (
                <FilterEmptyState
                  filters={filters}
                  projects={projects}
                  onClearFilters={clearFiltersAndClearSaved}
                />
              ) : (
                <TaskList
                  tasks={filteredTasks}
                  projects={projects}
                  selectedId="all"
                  selectedType="view"
                  onToggleComplete={handleToggleComplete}
                  onUpdateTask={handleUpdateTask}
                  onToggleSubtaskComplete={subtaskManagement.handleCompleteSubtask}
                  onQuickAdd={handleQuickAdd}
                  onTaskClick={handleTaskClick}
                  selectedTaskId={detailTaskId}
                  isSelectionMode={selection.isSelectionMode}
                  selectedIds={selection.selectedIds}
                  onToggleSelect={toggleTask}
                  onShiftSelect={selectRange}
                  onReorderSubtasks={subtaskManagement.handleReorderSubtasks}
                  onAddSubtask={subtaskManagement.handleAddSubtask}
                  sortField={sort.field}
                  sortDirection={sort.direction}
                  showProjectBadge={!selectedProjectId}
                  doneTasks={allTabDoneTasks}
                  getOrderedTasks={getOrderedTasks}
                />
              )}
            </div>
          )}

          {/* Kanban View - All Tab */}
          {activeInternalTab === 'all' && activeView === 'kanban' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <KanbanBoard
                tasks={kanbanTasks}
                projects={projects}
                selectedId="all"
                selectedType="view"
                selectedProjectId={selectedProjectId}
                sortField={sort.field}
                getOrderedTasks={getOrderedTasks}
                onUpdateTask={handleUpdateTask}
                onToggleComplete={handleToggleComplete}
                onTaskClick={handleTaskClick}
                onQuickAdd={handleKanbanQuickAdd}
                isSelectionMode={selection.isSelectionMode}
                selectedIds={selection.selectedIds}
                onToggleSelect={toggleTask}
              />
            </div>
          )}
        </main>

        {/* Task Detail Drawer */}
        <TaskDetailDrawer
          key={detailTask?.id ?? 'none'}
          task={detailTask}
          isOpen={!!detailTaskId}
          onClose={handleCloseDetail}
          tasks={tasks}
          projects={projects}
          onToggleComplete={handleToggleComplete}
          onUpdateTask={handleUpdateTask}
          onAddSubtask={subtaskManagement.handleAddSubtask}
          onNoteClick={handleNoteClick}
          onDeleteTask={handleDeleteTaskFromDrawer}
        />
      </div>

      {/* Add Task Modal */}
      <AddTaskModal
        isOpen={isAddTaskModalOpen}
        onClose={handleAddTaskModalClose}
        onAddTask={handleAddTaskFromModal}
        projects={projects}
        defaultProjectId={addTaskPrefillProjectId || modalDefaultProjectId}
        defaultDueDate={addTaskPrefillDueDate || modalDefaultDueDate}
        prefillTitle={addTaskPrefillTitle}
      />

      {/* Project Modal */}
      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={() => {
          setIsProjectModalOpen(false)
          setEditingProject(null)
        }}
        onSave={handleSaveProject}
        onDelete={editingProject ? () => handleDeleteProject(editingProject.id) : undefined}
        project={editingProject}
      />

      {/* Bulk Delete Dialog */}
      <BulkDeleteDialog
        open={isBulkDeleteDialogOpen}
        onClose={() => setIsBulkDeleteDialogOpen(false)}
        tasks={bulkActions.getSelectedTasks()}
        onConfirm={handleBulkDeleteConfirm}
      />

      {/* Bulk Due Date Picker */}
      <BulkDueDatePicker
        open={isBulkDueDatePickerOpen}
        onClose={() => setIsBulkDueDatePickerOpen(false)}
        taskCount={selectedCount}
        onConfirm={handleBulkDueDateConfirm}
      />

      {/* All Subtasks Complete Dialog */}
      <AllSubtasksCompleteDialog
        isOpen={subtaskManagement.allSubtasksCompleteDialogOpen}
        parentTitle={subtaskManagement.pendingAutoCompleteParent?.title || ''}
        subtaskCount={
          subtaskManagement.pendingAutoCompleteParent
            ? getSubtasks(subtaskManagement.pendingAutoCompleteParent.id, tasks).length
            : 0
        }
        onClose={subtaskManagement.closeAllSubtasksCompleteDialog}
        onKeepOpen={subtaskManagement.keepParentOpen}
        onCompleteParent={subtaskManagement.autoCompleteParent}
      />

      {/* Bulk Due Date Dialog for Subtasks */}
      <BulkDueDateDialog
        isOpen={subtaskManagement.bulkDueDateDialogOpen}
        parentTitle={subtaskManagement.pendingBulkOperationParent?.title || ''}
        subtaskCount={subtaskManagement.pendingBulkOperationSubtasks.length}
        completedCount={
          subtaskManagement.pendingBulkOperationSubtasks.filter((s) => s.completedAt !== null)
            .length
        }
        onClose={subtaskManagement.closeBulkDueDateDialog}
        onApply={subtaskManagement.confirmBulkDueDate}
      />

      {/* Bulk Priority Dialog for Subtasks */}
      <BulkPriorityDialog
        isOpen={subtaskManagement.bulkPriorityDialogOpen}
        parentTitle={subtaskManagement.pendingBulkOperationParent?.title || ''}
        subtaskCount={subtaskManagement.pendingBulkOperationSubtasks.length}
        completedCount={
          subtaskManagement.pendingBulkOperationSubtasks.filter((s) => s.completedAt !== null)
            .length
        }
        onClose={subtaskManagement.closeBulkPriorityDialog}
        onApply={subtaskManagement.confirmBulkPriority}
      />

      {/* Delete All Subtasks Dialog */}
      <DeleteAllSubtasksDialog
        isOpen={subtaskManagement.deleteAllSubtasksDialogOpen}
        parentTitle={subtaskManagement.pendingBulkOperationParent?.title || ''}
        subtasks={subtaskManagement.pendingBulkOperationSubtasks}
        onClose={subtaskManagement.closeDeleteAllSubtasksDialog}
        onConfirm={subtaskManagement.confirmDeleteAllSubtasks}
      />
    </>
  )
}
