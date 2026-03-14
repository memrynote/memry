import { useState, useMemo, useCallback, useEffect, useRef } from 'react'

import { toast } from 'sonner'
import { TaskList } from '@/components/tasks/task-list'
import { TasksTabBar, type TasksInternalTab } from '@/components/tasks/tasks-tab-bar'
import { ProjectsTabContent } from '@/components/tasks/projects/projects-tab-content'
import { ProjectSelector } from '@/components/tasks/projects/project-selector'
import { AddTaskModal } from '@/components/tasks/add-task-modal'
import { ProjectModal } from '@/components/tasks/project-modal'
import { TaskDetailPanel } from '@/components/tasks/task-detail-panel'
import { KanbanBoard } from '@/components/tasks/kanban'
import { CalendarView } from '@/components/tasks/calendar'
import { TodayView } from '@/components/tasks/today'
import {
  ClearCompletedMenu,
  ArchiveConfirmDialog,
  DeleteCompletedDialog,
  ArchivedView
} from '@/components/tasks/completed'
import { FilterBar, FilterEmptyState, type FilterBarRef } from '@/components/tasks/filters'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  getFilteredTasks,
  getDefaultTodoStatus,
  getDefaultDoneStatus,
  startOfDay,
  getCompletedTasks,
  getArchivedTasks,
  getTasksOlderThan,
  formatDateShort,
  getTodayTasks,
  countActiveFilters
} from '@/lib/task-utils'
import {
  type Project,
  type ViewMode,
  type TaskFilters,
  type TaskSort,
  type SavedFilter,
  type CompletionFilterType
} from '@/data/tasks-data'
import { createDefaultTask, generateTaskId, type Task, type Priority } from '@/data/sample-tasks'
import { addDays } from '@/lib/task-utils'
import { calculateNextOccurrence, shouldCreateNextOccurrence } from '@/lib/repeat-utils'
import type { StopRepeatOption } from '@/components/tasks/stop-repeating-dialog'
import {
  useFilterState,
  useSavedFilters,
  useFilteredAndSortedTasks,
  useTaskSelection,
  useBulkActions,
  useSubtaskManagement,
  useUndoTracker
} from '@/hooks'
import { useTasksContext } from '@/contexts/tasks'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
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
  selectedTaskIds: _externalSelectedIds,
  onSelectedTaskIdsChange
}: TasksPageProps): React.JSX.Element => {
  // Get database-aware task operations from context
  const {
    addTask: contextAddTask,
    updateTask: contextUpdateTask,
    deleteTask: contextDeleteTask,
    addProject: contextAddProject,
    updateProject: contextUpdateProject,
    deleteProject: contextDeleteProject
  } = useTasksContext()

  // T051-T054: Undo tracking for Cmd+Z support
  const { registerUndo } = useUndoTracker()

  const { settings: taskPrefs } = useTaskPreferences()

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
  const [activeView, setActiveView] = useState<ViewMode>('list')

  // Internal tab state for the new tab bar navigation (default to Today)
  const [activeInternalTab, setActiveInternalTab] = useState<TasksInternalTab>('today')

  // Track selected project for "All projects" filter dropdown
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  // Modal states
  const [isAddTaskModalOpen, setIsAddTaskModalOpen] = useState(false)
  const [addTaskPrefillTitle, setAddTaskPrefillTitle] = useState('')
  const [addTaskPrefillDueDate, setAddTaskPrefillDueDate] = useState<Date | null>(null)
  const [addTaskPrefillProjectId, setAddTaskPrefillProjectId] = useState<string | null>(null)

  // Task Detail Panel states
  const [isDetailPanelOpen, setIsDetailPanelOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  // Completed/Archive view states
  const [showArchivedView, setShowArchivedView] = useState(false)
  const [isClearMenuOpen, setIsClearMenuOpen] = useState(false)
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false)
  const [archiveDialogVariant, setArchiveDialogVariant] = useState<'all' | 'older-than'>('all')
  const [archiveOlderThanDays, setArchiveOlderThanDays] = useState(7)
  const [isDeleteCompletedDialogOpen, setIsDeleteCompletedDialogOpen] = useState(false)
  const [deleteCompletedVariant, setDeleteCompletedVariant] = useState<'completed' | 'archived'>(
    'completed'
  )

  // Filter bar ref + panel toggle
  const filterBarRef = useRef<FilterBarRef>(null)
  const [isFiltersPanelOpen, setIsFiltersPanelOpen] = useState(false)

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

  // Saved filters
  const { savedFilters, saveFilter, deleteFilter: deleteSavedFilter } = useSavedFilters()

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

  // Derived: available views based on internal tab
  const availableViews = useMemo((): ViewMode[] => {
    if (
      activeInternalTab === 'today' ||
      activeInternalTab === 'thisWeek' ||
      activeInternalTab === 'done'
    ) {
      return ['list']
    }
    return ['list', 'kanban', 'calendar']
  }, [activeInternalTab])

  // Reset to list view if current view becomes unavailable
  useEffect(() => {
    if (!availableViews.includes(activeView)) {
      setActiveView('list')
    }
  }, [availableViews, activeView])

  // Derived: filtered tasks for current selection (base filter by view/project)
  const baseFilteredTasks = useMemo(() => {
    return getFilteredTasks(tasks, selectedId, selectedType, projects)
  }, [tasks, selectedId, selectedType, projects])

  // Projects tab: scope tasks to selected project for filtering/counts
  const projectsTabBaseTasks = useMemo(() => {
    if (!selectedProjectId) return []
    return getFilteredTasks(tasks, selectedProjectId, 'project', projects)
  }, [tasks, selectedProjectId, projects])

  // Project-scoped filter adjustments (used when project selected from dropdown)
  const projectsTabFilters = useMemo(() => {
    return filters
  }, [filters])

  // Apply advanced filters and sort to base filtered tasks
  const {
    filteredTasks: advancedFilteredTasks,
    totalCount,
    filteredCount
  } = useFilteredAndSortedTasks({
    tasks: baseFilteredTasks,
    filters,
    sort,
    projects
  })

  // Apply advanced filters and sort to selected project tasks (Projects tab)
  const { filteredTasks: projectsTabFilteredTasks } = useFilteredAndSortedTasks({
    tasks: projectsTabBaseTasks,
    filters: projectsTabFilters,
    sort,
    projects
  })

  // Apply advanced filters for all selections (All/Today/Upcoming/Projects/Project)
  const filteredTasks = advancedFilteredTasks

  // Check if we should show the filter empty state
  const showFilterEmptyState = filtersActive && filteredCount === 0 && totalCount > 0

  // Visible task IDs for selection (used by multi-select)
  // Scope to what's actually rendered in the active internal tab.
  const selectionScopeTasks = useMemo(() => {
    if (activeInternalTab === 'today') {
      const { overdue, today } = getTodayTasks(filteredTasks, projects)
      return [...overdue, ...today]
    }

    if (activeInternalTab === 'done') {
      return getCompletedTasks(filteredTasks)
    }

    return filteredTasks
  }, [activeInternalTab, filteredTasks, projects])

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
  } = useTaskSelection(visibleTaskIds)

  // Sync selection state with App level for drag-drop
  useEffect(() => {
    if (onSelectedTaskIdsChange) {
      onSelectedTaskIdsChange(selection.selectedIds)
    }
  }, [selection.selectedIds, onSelectedTaskIdsChange])

  // Bulk actions hook - use context functions to persist to database
  const bulkActions = useBulkActions({
    selectedIds: selectedTaskIds,
    tasks,
    projects,
    onUpdateTask: contextUpdateTask,
    onDeleteTask: contextDeleteTask,
    onComplete: deselectAll
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

  // Derived: tab counts for TasksTabBar
  const tabCounts = useMemo(() => {
    const allActive = getFilteredTasks(tasks, 'all', 'view', projects)
    const todayResult = getTodayTasks(tasks, projects)
    const todayCount = todayResult.overdue.length + todayResult.today.length

    // This week: active tasks due within 7 days (including today + overdue)
    const now = startOfDay(new Date())
    const weekEnd = addDays(now, 7)
    const thisWeekCount = allActive.filter((t) => {
      if (!t.dueDate) return false
      return t.dueDate < weekEnd
    }).length

    const doneCount = getCompletedTasks(tasks).length

    return {
      today: todayCount,
      thisWeek: thisWeekCount,
      all: allActive.length,
      done: doneCount
    }
  }, [tasks, projects])

  // Derived: selected task for detail panel
  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null
    return tasks.find((t) => t.id === selectedTaskId) || null
  }, [selectedTaskId, tasks])

  // Derived: is selected task completed
  const isSelectedTaskCompleted = useMemo(() => {
    if (!selectedTask) return false
    const project = projects.find((p) => p.id === selectedTask.projectId)
    if (!project) return false
    const status = project.statuses.find((s) => s.id === selectedTask.statusId)
    return status?.type === 'done'
  }, [selectedTask, projects])

  // Visibility constants
  const showFilterBar = true

  // ========== HANDLERS ==========

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
      // "/" to focus search (only when filter bar is visible)
      if (e.key === '/' && !isInputFocused() && showFilterBar) {
        e.preventDefault()
        filterBarRef.current?.focusSearch()
      }

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
      // Use context addTask to persist to database
      contextAddTask(newTask)
    },
    [contextAddTask]
  )

  // Get default project and due date for the modal based on current selection
  const modalDefaultProjectId = useMemo(() => {
    if (selectedType === 'project' && selectedProject) {
      return selectedProject.id
    }
    if (taskPrefs.defaultProjectId) {
      return taskPrefs.defaultProjectId
    }
    return 'personal'
  }, [selectedType, selectedProject, taskPrefs.defaultProjectId])

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
      let projectId = parsedData?.projectId || 'personal'
      let dueDate = parsedData?.dueDate || null
      const priority = parsedData?.priority || 'none'

      if (!parsedData?.projectId) {
        if (selectedType === 'project' && selectedProject) {
          projectId = selectedProject.id
        } else if (taskPrefs.defaultProjectId) {
          projectId = taskPrefs.defaultProjectId
        } else {
          const personalProject = projects.find((p) => p.isDefault)
          if (personalProject) {
            projectId = personalProject.id
          }
        }
      }

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

      // Use context addTask to persist to database
      contextAddTask(newTask)
    },
    [
      selectedId,
      selectedType,
      selectedProject,
      projects,
      contextAddTask,
      taskPrefs.defaultProjectId
    ]
  )

  const handleToggleComplete = useCallback(
    (taskId: string): void => {
      const taskToComplete = tasks.find((t) => t.id === taskId)
      if (!taskToComplete) return

      const project = projects.find((p) => p.id === taskToComplete.projectId)
      if (!project) return

      const currentStatus = project.statuses.find((s) => s.id === taskToComplete.statusId)
      if (!currentStatus) return

      if (currentStatus.type === 'done') {
        // Uncomplete: move back to todo status
        const todoStatus = getDefaultTodoStatus(project)
        contextUpdateTask(taskId, {
          statusId: todoStatus?.id || taskToComplete.statusId,
          completedAt: null
        })
        return
      }

      const doneStatus = getDefaultDoneStatus(project)
      const completedAt = new Date()

      // Get subtasks to also complete them
      const subtasks = getSubtasks(taskId, tasks)
      const hasSubtasks = subtasks.length > 0

      if (taskToComplete.isRepeating && taskToComplete.repeatConfig && taskToComplete.dueDate) {
        const config = taskToComplete.repeatConfig
        const newCompletedCount = config.completedCount + 1
        const nextDate = calculateNextOccurrence(taskToComplete.dueDate, config)
        const shouldCreateNext = shouldCreateNextOccurrence({
          ...config,
          completedCount: newCompletedCount
        })

        // Mark the completed task as done (no longer repeating)
        contextUpdateTask(taskId, {
          statusId: doneStatus?.id || taskToComplete.statusId,
          completedAt,
          isRepeating: false,
          repeatConfig: null
        })

        // Also complete all subtasks
        if (hasSubtasks) {
          subtasks.forEach((subtask) => {
            if (!subtask.completedAt) {
              contextUpdateTask(subtask.id, {
                statusId: doneStatus?.id || subtask.statusId,
                completedAt
              })
            }
          })
        }

        // Create the next occurrence if needed
        if (shouldCreateNext && nextDate) {
          const newTask: Task = {
            ...taskToComplete,
            id: generateTaskId(),
            dueDate: nextDate,
            statusId: getDefaultTodoStatus(project)?.id || taskToComplete.statusId,
            completedAt: null,
            createdAt: new Date(),
            repeatConfig: {
              ...config,
              completedCount: newCompletedCount
            }
          }
          contextAddTask(newTask)
          toast.success('Task completed!', {
            description: `Next occurrence: ${formatDateShort(nextDate)}`
          })
        } else {
          toast.success('Series complete!', {
            description: 'This was the final occurrence.'
          })
        }
      } else {
        // Simple completion: mark as done
        contextUpdateTask(taskId, {
          statusId: doneStatus?.id || taskToComplete.statusId,
          completedAt
        })

        // Also complete all subtasks
        if (hasSubtasks) {
          const incompleteSubtasks = subtasks.filter((s) => !s.completedAt)
          incompleteSubtasks.forEach((subtask) => {
            contextUpdateTask(subtask.id, {
              statusId: doneStatus?.id || subtask.statusId,
              completedAt
            })
          })
          if (incompleteSubtasks.length > 0) {
            toast.success('Task completed!', {
              description: `Also marked ${incompleteSubtasks.length} subtask(s) as done.`
            })
          }
        }
      }
    },
    [tasks, projects, contextUpdateTask, contextAddTask]
  )

  const handleSkipOccurrence = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task || !task.isRepeating || !task.repeatConfig || !task.dueDate) return

      const nextDate = calculateNextOccurrence(task.dueDate, task.repeatConfig)
      if (nextDate) {
        // T-GAP-001: Use contextUpdateTask to persist to database
        contextUpdateTask(taskId, { dueDate: nextDate })
        toast.success('Occurrence skipped', {
          description: `Moved to ${formatDateShort(nextDate)}`
        })
      }
    },
    [tasks, contextUpdateTask]
  )

  const handleStopRepeating = useCallback(
    (taskId: string, option: StopRepeatOption): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      if (option === 'delete') {
        // T-GAP-003: Use contextDeleteTask to persist to database
        contextDeleteTask(taskId)
        setIsDetailPanelOpen(false)
        setSelectedTaskId(null)
        toast.success('Repeating task deleted')
      } else {
        // T-GAP-002: Use contextUpdateTask to persist to database
        contextUpdateTask(taskId, { isRepeating: false, repeatConfig: null })
        toast.success('Task will no longer repeat')
      }
    },
    [tasks, contextDeleteTask, contextUpdateTask]
  )

  const handleTaskClick = useCallback((taskId: string): void => {
    setSelectedTaskId(taskId)
    setIsDetailPanelOpen(true)
  }, [])

  const handleCloseDetailPanel = useCallback((): void => {
    setIsDetailPanelOpen(false)
    setSelectedTaskId(null)
  }, [])

  const handleUpdateTask = useCallback(
    (taskId: string, updates: Partial<Task>): void => {
      // Use context updateTask to persist to database
      contextUpdateTask(taskId, updates)
    },
    [contextUpdateTask]
  )

  const handleDeleteTask = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      const deletedTask = { ...task }

      // Use context deleteTask to persist to database
      contextDeleteTask(taskId)
      setIsDetailPanelOpen(false)
      setSelectedTaskId(null)

      // T051-T054: Register undo for Cmd+Z support
      const undoFn = () => {
        contextAddTask(deletedTask)
      }
      registerUndo(`Delete "${task.title}"`, undoFn)

      toast.success('Task deleted', {
        description: `"${task.title}" has been deleted.`,
        duration: 10000, // T052: 10-second timeout for undo per spec
        action: {
          label: 'Undo',
          onClick: undoFn
        }
      })
    },
    [tasks, contextDeleteTask, contextAddTask, registerUndo]
  )

  const handleDuplicateTask = useCallback(
    async (taskId: string): Promise<void> => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      try {
        // Use backend service which handles subtask duplication
        const result = await tasksService.duplicate(taskId)

        if (result.success && result.task) {
          toast.success('Task duplicated', {
            description: `"${result.task.title}" has been created.`
          })
          setSelectedTaskId(result.task.id)
        } else {
          toast.error('Failed to duplicate task', {
            description: extractErrorMessage(result.error, 'Unknown error')
          })
        }
      } catch (error) {
        log.error('Failed to duplicate task:', error)
        toast.error(extractErrorMessage(error, 'Failed to duplicate task'))
      }
    },
    [tasks]
  )

  const handleAddTaskWithDate = useCallback(
    (date: Date): void => {
      const projectId =
        selectedType === 'project' && selectedProject ? selectedProject.id : 'personal'
      setAddTaskPrefillProjectId(projectId)
      setAddTaskPrefillDueDate(date)
      setAddTaskPrefillTitle('')
      setIsAddTaskModalOpen(true)
    },
    [selectedProject, selectedType]
  )

  // ========== ARCHIVE HANDLERS (unused after refactor, kept for potential future use) ==========

  const _handleUncompleteTask = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      const project = projects.find((p) => p.id === task.projectId)
      if (!project) return

      const todoStatus = getDefaultTodoStatus(project)

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, statusId: todoStatus?.id || t.statusId, completedAt: null } : t
        )
      )

      toast.success('Task restored to active')
    },
    [tasks, projects, setTasks]
  )

  const _handleArchiveTask = useCallback(
    (taskId: string): void => {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, archivedAt: new Date() } : t)))

      toast.success('Task archived', {
        duration: 10000, // T052: 10-second timeout for undo per spec
        action: {
          label: 'Undo',
          onClick: () => {
            setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, archivedAt: null } : t)))
          }
        }
      })
    },
    [setTasks]
  )

  const _handleUnarchiveTask = useCallback(
    (taskId: string): void => {
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, archivedAt: null } : t)))

      toast.success('Task restored to completed')
    },
    [setTasks]
  )

  const _handleDeleteCompletedTask = useCallback(
    (taskId: string): void => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return

      const deletedTask = { ...task }

      setTasks((prev) => prev.filter((t) => t.id !== taskId))

      toast.success('Task deleted', {
        duration: 10000, // T052: 10-second timeout for undo per spec
        action: {
          label: 'Undo',
          onClick: () => {
            setTasks((prev) => [...prev, deletedTask])
          }
        }
      })
    },
    [tasks, setTasks]
  )

  // Calendar tasks for CalendarView (kept for potential future use)
  const _calendarTasks = useMemo(() => {
    if (selectedType === 'project') {
      return tasks.filter((t) => t.projectId === selectedId)
    }
    return tasks
  }, [selectedType, selectedId, tasks])

  // ========== ARCHIVE ACTIONS ==========

  const handleViewArchived = useCallback((): void => {
    setShowArchivedView(true)
  }, [])

  const handleBackFromArchived = useCallback((): void => {
    setShowArchivedView(false)
  }, [])

  const handleOpenClearMenu = useCallback((): void => {
    setIsClearMenuOpen(true)
  }, [])

  const completedTasksForActions = useMemo(() => getCompletedTasks(tasks), [tasks])

  const archivedTasksForActions = useMemo(() => getArchivedTasks(tasks), [tasks])

  const handleArchiveAll = useCallback((): void => {
    setArchiveDialogVariant('all')
    setIsArchiveDialogOpen(true)
  }, [])

  const handleArchiveOlderThan = useCallback((days: number): void => {
    setArchiveOlderThanDays(days)
    setArchiveDialogVariant('older-than')
    setIsArchiveDialogOpen(true)
  }, [])

  const handleConfirmArchive = useCallback(async (): Promise<void> => {
    let tasksToArchive: Task[]
    if (archiveDialogVariant === 'all') {
      tasksToArchive = completedTasksForActions
    } else {
      tasksToArchive = getTasksOlderThan(completedTasksForActions, archiveOlderThanDays)
    }

    // Archive each task via handleUpdateTask to trigger database save
    for (const task of tasksToArchive) {
      await handleUpdateTask(task.id, { archivedAt: new Date() })
    }

    toast.success(`${tasksToArchive.length} task${tasksToArchive.length !== 1 ? 's' : ''} archived`)
    setIsArchiveDialogOpen(false)
  }, [archiveDialogVariant, archiveOlderThanDays, completedTasksForActions, handleUpdateTask])

  const tasksToArchiveCount = useMemo((): number => {
    if (archiveDialogVariant === 'all') {
      return completedTasksForActions.length
    }
    return getTasksOlderThan(completedTasksForActions, archiveOlderThanDays).length
  }, [archiveDialogVariant, archiveOlderThanDays, completedTasksForActions])

  const handleDeleteAllCompleted = useCallback((): void => {
    setDeleteCompletedVariant('completed')
    setIsDeleteCompletedDialogOpen(true)
  }, [])

  const handleDeleteAllArchived = useCallback((): void => {
    setDeleteCompletedVariant('archived')
    setIsDeleteCompletedDialogOpen(true)
  }, [])

  const handleConfirmDeleteCompleted = useCallback(async (): Promise<void> => {
    let tasksToDelete: Task[]
    if (deleteCompletedVariant === 'completed') {
      tasksToDelete = completedTasksForActions
    } else {
      tasksToDelete = archivedTasksForActions
    }

    // Delete each task via handleDeleteTask to trigger database delete
    for (const task of tasksToDelete) {
      await handleDeleteTask(task.id)
    }

    toast.success(
      `${tasksToDelete.length} task${tasksToDelete.length !== 1 ? 's' : ''} deleted permanently`
    )
    setIsDeleteCompletedDialogOpen(false)
  }, [deleteCompletedVariant, completedTasksForActions, archivedTasksForActions, handleDeleteTask])

  const tasksToDeleteCount = useMemo((): number => {
    if (deleteCompletedVariant === 'completed') {
      return completedTasksForActions.length
    }
    return archivedTasksForActions.length
  }, [deleteCompletedVariant, completedTasksForActions, archivedTasksForActions])

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
      toast.success('Filter deleted')
    },
    [deleteSavedFilter]
  )

  const handleApplySavedFilter = useCallback(
    (savedFilter: SavedFilter): void => {
      updateFilters(savedFilter.filters)
      if (savedFilter.sort) {
        updateSort(savedFilter.sort)
      }
      toast.success(`Applied "${savedFilter.name}"`)
    },
    [updateFilters, updateSort]
  )

  // Get statuses for the current project (for Kanban filter)
  const currentProjectStatuses = useMemo(() => {
    if (selectedType === 'project' && selectedProject) {
      return selectedProject.statuses
    }
    return []
  }, [selectedType, selectedProject])

  return (
    <>
      <div className={cn('relative h-full', className)}>
        {/* Main Content Area */}
        <main className="absolute inset-0 flex flex-col overflow-hidden py-6 px-9">
          {/* Page Header */}
          <div className="flex items-center gap-4 shrink-0">
            <h1 className="text-[24px] tracking-[-0.03em] text-text-primary font-[family-name:var(--font-heading)] font-bold leading-[30px]">
              Tasks
            </h1>
            <div className="grow" />
            <button
              type="button"
              onClick={() => setIsFiltersPanelOpen((prev) => !prev)}
              className={cn(
                'flex items-center rounded-sm py-1.5 px-3 gap-1.5 border transition-colors',
                isFiltersPanelOpen || filtersActive
                  ? 'border-foreground/20 bg-foreground/5 text-text-primary'
                  : 'border-border text-text-secondary hover:bg-accent/50'
              )}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M1.5 3.5h11M3.5 7h7M5.5 10.5h3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  className="text-text-tertiary"
                />
              </svg>
              <span className="text-[13px] leading-4">Filter</span>
              {filtersActive && (
                <span className="flex items-center justify-center size-[18px] rounded-full bg-foreground text-background text-[10px] font-bold">
                  {countActiveFilters(filters)}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() =>
                updateSort({
                  field: sort.field === 'dueDate' ? 'priority' : 'dueDate',
                  direction: sort.direction
                })
              }
              className="flex items-center rounded-sm py-1.5 px-3 gap-1.5 border border-border text-text-secondary hover:bg-accent/50 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M3 4l2-2 2 2M5 2v10M11 10l-2 2-2-2M9 12V2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-text-tertiary"
                />
              </svg>
              <span className="text-[13px] leading-4">Sort</span>
            </button>
            <button
              type="button"
              onClick={handleAddTask}
              className="flex items-center rounded-sm py-1.5 px-3.5 gap-1.5 bg-foreground text-background hover:opacity-90 transition-opacity"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M6 2v8M2 6h8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              <span className="text-[13px] font-medium leading-4">Add task</span>
            </button>
          </div>

          {/* Internal Tab Bar */}
          <TasksTabBar
            activeTab={activeInternalTab}
            onTabChange={setActiveInternalTab}
            counts={tabCounts}
            activeView={activeView}
            availableViews={availableViews}
            onViewChange={setActiveView}
            projects={projects}
            selectedProjectId={selectedProjectId}
            onProjectChange={setSelectedProjectId}
          />

          {/* Filter Bar */}
          {showFilterBar && (
            <FilterBar
              ref={filterBarRef}
              filters={filters}
              sort={sort}
              onUpdateFilters={updateFilters}
              onUpdateSort={updateSort}
              onClearFilters={clearFilters}
              projects={projects}
              tasks={baseFilteredTasks}
              savedFilters={savedFilters}
              onSaveFilter={handleSaveFilter}
              onDeleteSavedFilter={handleDeleteSavedFilter}
              onApplySavedFilter={handleApplySavedFilter}
              showStatusFilter={activeView === 'kanban'}
              statuses={currentProjectStatuses}
              isFiltersPanelOpen={isFiltersPanelOpen}
              isSelectionMode={selection.isSelectionMode}
              onToggleSelectionMode={handleToggleSelectionMode}
              showCompletionToggle={activeInternalTab === 'all'}
              onViewArchived={activeInternalTab === 'all' ? handleViewArchived : undefined}
              onArchiveOptions={activeInternalTab === 'all' ? handleOpenClearMenu : undefined}
              completedCount={completedTasksForActions.length}
              archivedCount={archivedTasksForActions.length}
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
              showStatusAction={activeView === 'kanban' && selectedType === 'project'}
            />
          )}

          {/* T049: Archived View - shown when viewing archived tasks */}
          {showArchivedView && (
            <ArchivedView
              tasks={tasks}
              projects={projects}
              onBack={handleBackFromArchived}
              onRestore={(taskId) => handleUpdateTask(taskId, { archivedAt: null })}
              onDelete={handleDeleteTask}
              onDeleteAll={handleDeleteAllArchived}
            />
          )}

          {/* Content Body - Today Tab */}
          {activeInternalTab === 'today' && (
            <div className="relative flex flex-1 flex-col overflow-hidden">
              <TodayView
                tasks={filteredTasks}
                projects={projects}
                selectedTaskId={selectedTaskId}
                onToggleComplete={handleToggleComplete}
                onUpdateTask={handleUpdateTask}
                onTaskClick={handleTaskClick}
                onQuickAdd={handleQuickAdd}
                onOpenModal={handleOpenAddTaskModal}
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
                  onClearFilters={clearFilters}
                />
              ) : (
                <TaskList
                  tasks={filteredTasks}
                  projects={projects}
                  selectedId="all"
                  selectedType="view"
                  selectedTaskId={selectedTaskId}
                  onToggleComplete={handleToggleComplete}
                  onUpdateTask={handleUpdateTask}
                  onToggleSubtaskComplete={subtaskManagement.handleCompleteSubtask}
                  onTaskClick={handleTaskClick}
                  onQuickAdd={handleQuickAdd}
                  onOpenModal={handleOpenAddTaskModal}
                  isSelectionMode={selection.isSelectionMode}
                  selectedIds={selection.selectedIds}
                  onToggleSelect={toggleTask}
                  onShiftSelect={selectRange}
                  onReorderSubtasks={subtaskManagement.handleReorderSubtasks}
                  onAddSubtask={subtaskManagement.handleAddSubtask}
                />
              )}
            </div>
          )}

          {/* Content Body - This Week Tab */}
          {activeInternalTab === 'thisWeek' && (
            <div className="relative flex flex-1 flex-col overflow-hidden">
              <TodayView
                tasks={filteredTasks}
                projects={projects}
                selectedTaskId={selectedTaskId}
                onToggleComplete={handleToggleComplete}
                onUpdateTask={handleUpdateTask}
                onTaskClick={handleTaskClick}
                onQuickAdd={handleQuickAdd}
                onOpenModal={handleOpenAddTaskModal}
              />
            </div>
          )}

          {/* Content Body - Done Tab */}
          {activeInternalTab === 'done' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <TaskList
                tasks={getCompletedTasks(tasks)}
                projects={projects}
                selectedId="completed"
                selectedType="view"
                selectedTaskId={selectedTaskId}
                onToggleComplete={handleToggleComplete}
                onUpdateTask={handleUpdateTask}
                onToggleSubtaskComplete={subtaskManagement.handleCompleteSubtask}
                onTaskClick={handleTaskClick}
                onQuickAdd={handleQuickAdd}
                onOpenModal={handleOpenAddTaskModal}
                isSelectionMode={selection.isSelectionMode}
                selectedIds={selection.selectedIds}
                onToggleSelect={toggleTask}
                onShiftSelect={selectRange}
                onReorderSubtasks={subtaskManagement.handleReorderSubtasks}
                onAddSubtask={subtaskManagement.handleAddSubtask}
              />
            </div>
          )}

          {/* Kanban View - All Tab */}
          {activeInternalTab === 'all' && activeView === 'kanban' && (
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {showFilterEmptyState ? (
                <FilterEmptyState
                  filters={filters}
                  projects={projects}
                  onClearFilters={clearFilters}
                />
              ) : (
                <KanbanBoard
                  tasks={filteredTasks}
                  projects={projects}
                  selectedId="all"
                  selectedType="view"
                  selectedTaskId={selectedTaskId}
                  onUpdateTask={handleUpdateTask}
                  onTaskClick={handleTaskClick}
                  onToggleComplete={handleToggleComplete}
                  onDeleteTask={handleDeleteTask}
                  onQuickAdd={handleQuickAdd}
                  isSelectionMode={selection.isSelectionMode}
                  selectedIds={selection.selectedIds}
                  onToggleSelect={toggleTask}
                />
              )}
            </div>
          )}

          {/* Calendar View - All Tab */}
          {activeInternalTab === 'all' && activeView === 'calendar' && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <CalendarView
                tasks={filteredTasks}
                projects={projects}
                selectedId="all"
                selectedType="view"
                onUpdateTask={handleUpdateTask}
                onTaskClick={handleTaskClick}
                onAddTaskWithDate={handleAddTaskWithDate}
                onToggleComplete={handleToggleComplete}
                isSelectionMode={selection.isSelectionMode}
                selectedIds={selection.selectedIds}
                onToggleSelect={toggleTask}
              />
            </div>
          )}
        </main>
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

      {/* Task Detail Panel */}
      <TaskDetailPanel
        isOpen={isDetailPanelOpen}
        task={selectedTask}
        allTasks={tasks}
        projects={projects}
        isCompleted={isSelectedTaskCompleted}
        onClose={handleCloseDetailPanel}
        onUpdateTask={handleUpdateTask}
        onToggleComplete={handleToggleComplete}
        onDeleteTask={handleDeleteTask}
        onDuplicateTask={handleDuplicateTask}
        onSkipOccurrence={handleSkipOccurrence}
        onStopRepeating={handleStopRepeating}
        onAddSubtask={subtaskManagement.handleAddSubtask}
        onBulkAddSubtasks={subtaskManagement.handleBulkAddSubtasks}
        onUpdateSubtask={handleUpdateTask}
        onToggleSubtaskComplete={subtaskManagement.handleCompleteSubtask}
        onDeleteSubtask={subtaskManagement.handleDeleteSubtask}
        onReorderSubtasks={subtaskManagement.handleReorderSubtasks}
        onPromoteSubtask={subtaskManagement.handlePromoteToTask}
        onCompleteAllSubtasks={subtaskManagement.handleCompleteAllSubtasks}
        onMarkAllSubtasksIncomplete={subtaskManagement.handleMarkAllSubtasksIncomplete}
        onOpenBulkDueDateDialog={subtaskManagement.openBulkDueDateDialog}
        onOpenBulkPriorityDialog={subtaskManagement.openBulkPriorityDialog}
        onOpenDeleteAllSubtasksDialog={subtaskManagement.openDeleteAllSubtasksDialog}
      />

      {/* Clear Completed Menu */}
      <ClearCompletedMenu
        open={isClearMenuOpen}
        onOpenChange={setIsClearMenuOpen}
        onArchiveAll={handleArchiveAll}
        onArchiveOlderThan={handleArchiveOlderThan}
        onDeleteAll={handleDeleteAllCompleted}
        onViewArchived={handleViewArchived}
        completedCount={completedTasksForActions.length}
        archivedCount={archivedTasksForActions.length}
      />

      {/* Archive Confirm Dialog */}
      <ArchiveConfirmDialog
        open={isArchiveDialogOpen}
        onOpenChange={setIsArchiveDialogOpen}
        onConfirm={handleConfirmArchive}
        taskCount={tasksToArchiveCount}
        variant={archiveDialogVariant}
        olderThanDays={archiveOlderThanDays}
      />

      {/* Delete Completed Dialog */}
      <DeleteCompletedDialog
        open={isDeleteCompletedDialogOpen}
        onOpenChange={setIsDeleteCompletedDialogOpen}
        onConfirm={handleConfirmDeleteCompleted}
        taskCount={tasksToDeleteCount}
        variant={deleteCompletedVariant}
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
