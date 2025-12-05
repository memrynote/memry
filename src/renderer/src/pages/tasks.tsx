import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import {
    Plus,
    LayoutList,
    Columns3,
    CalendarDays,
    Settings,
} from "lucide-react"
import type { DragEndEvent } from "@dnd-kit/core"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "sonner"
import { TaskList } from "@/components/tasks/task-list"
import { AddTaskModal } from "@/components/tasks/add-task-modal"
import { TaskDetailPanel } from "@/components/tasks/task-detail-panel"
import { KanbanBoard } from "@/components/tasks/kanban"
import { CalendarView } from "@/components/tasks/calendar"
import { TodayView } from "@/components/tasks/today"
import { UpcomingView } from "@/components/tasks/upcoming"
import {
    CompletedView,
    ArchivedView,
    ClearCompletedMenu,
    ArchiveConfirmDialog,
    DeleteCompletedDialog,
} from "@/components/tasks/completed"
import { FilterBar, FilterEmptyState, type FilterBarRef } from "@/components/tasks/filters"
import { TaskDragOverlay } from "@/components/tasks/drag-drop"
import { DragProvider, type DragState } from "@/contexts/drag-context"
import { cn } from "@/lib/utils"
import {
    getFilteredTasks,
    getTaskCounts,
    formatTaskSubtitle,
    getDefaultTodoStatus,
    getDefaultDoneStatus,
    startOfDay,
    getCompletedTasks,
    getArchivedTasks,
    getTasksOlderThan,
    formatDateShort,
} from "@/lib/task-utils"
import {
    taskViews,
    LIST_ONLY_VIEWS,
    type Project,
    type ViewMode,
    type TaskFilters,
    type TaskSort,
    type SavedFilter,
} from "@/data/tasks-data"
import { createDefaultTask, generateTaskId, type Task, type Priority } from "@/data/sample-tasks"
import { addDays } from "@/lib/task-utils"
import { calculateNextOccurrence, shouldCreateNextOccurrence } from "@/lib/repeat-utils"
import type { StopRepeatOption } from "@/components/tasks/stop-repeating-dialog"
import { useFilterState, useSavedFilters, useFilteredAndSortedTasks, useTaskSelection, useBulkActions, useDragHandlers, useSubtaskManagement } from "@/hooks"
import { BulkActionToolbar, BulkDeleteDialog, BulkDueDatePicker } from "@/components/tasks/bulk-actions"
import {
    AllSubtasksCompleteDialog,
    BulkDueDateDialog,
    BulkPriorityDialog,
    DeleteAllSubtasksDialog,
} from "@/components/tasks/dialogs"
import { getSubtasks } from "@/lib/subtask-utils"
import type { TaskSelectionType } from "@/App"

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
}

interface TasksContentHeaderProps {
    title: string
    subtitle: string
    activeView: ViewMode
    availableViews: ViewMode[]
    showProjectSettings: boolean
    onViewChange: (view: ViewMode) => void
    onAddTask: () => void
    onProjectSettings: () => void
}

interface TasksViewToggleProps {
    activeView: ViewMode
    availableViews: ViewMode[]
    onViewChange: (view: ViewMode) => void
}

// ============================================================================
// VIEW TOGGLE COMPONENT
// ============================================================================

const TasksViewToggle = ({
    activeView,
    availableViews,
    onViewChange,
}: TasksViewToggleProps): React.JSX.Element => {
    const handleValueChange = (value: string): void => {
        if (value && availableViews.includes(value as ViewMode)) {
            onViewChange(value as ViewMode)
        }
    }

    return (
        <ToggleGroup
            type="single"
            value={activeView}
            onValueChange={handleValueChange}
            className="gap-1"
            aria-label="View mode"
        >
            <ToggleGroupItem
                value="list"
                aria-label="List view"
                disabled={!availableViews.includes("list")}
            >
                <LayoutList className="size-4" />
            </ToggleGroupItem>
            <ToggleGroupItem
                value="kanban"
                aria-label="Kanban view"
                disabled={!availableViews.includes("kanban")}
                className={cn(!availableViews.includes("kanban") && "hidden")}
            >
                <Columns3 className="size-4" />
            </ToggleGroupItem>
            <ToggleGroupItem
                value="calendar"
                aria-label="Calendar view"
                disabled={!availableViews.includes("calendar")}
                className={cn(!availableViews.includes("calendar") && "hidden")}
            >
                <CalendarDays className="size-4" />
            </ToggleGroupItem>
        </ToggleGroup>
    )
}

// ============================================================================
// CONTENT HEADER COMPONENT
// ============================================================================

const TasksContentHeader = ({
    title,
    subtitle,
    activeView,
    availableViews,
    showProjectSettings,
    onViewChange,
    onAddTask,
    onProjectSettings,
}: TasksContentHeaderProps): React.JSX.Element => {
    return (
        <header className="flex items-start justify-between border-b border-border px-6 py-5">
            {/* Left side: Title and Subtitle */}
            <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                    <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
                    {showProjectSettings && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={onProjectSettings}
                                    className={cn(
                                        "rounded p-1 text-text-tertiary transition-colors",
                                        "hover:bg-accent hover:text-text-secondary",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    )}
                                    aria-label="Project settings"
                                >
                                    <Settings className="size-4" />
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Project settings</TooltipContent>
                        </Tooltip>
                    )}
                </div>
                <p className="text-sm text-text-tertiary">{subtitle}</p>
            </div>

            {/* Right side: View Toggle and Add Task button */}
            <div className="flex items-center gap-3">
                <TasksViewToggle
                    activeView={activeView}
                    availableViews={availableViews}
                    onViewChange={onViewChange}
                />
                <Button onClick={onAddTask} size="sm">
                    <Plus className="size-4" aria-hidden="true" />
                    Add Task
                </Button>
            </div>
        </header>
    )
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
}: TasksPageProps): React.JSX.Element => {
    // Local setter that updates via parent callback
    const setTasks = useCallback((updater: Task[] | ((prev: Task[]) => Task[])) => {
        if (typeof updater === "function") {
            onTasksChange(updater(tasks))
        } else {
            onTasksChange(updater)
        }
    }, [tasks, onTasksChange])

    // View mode state
    const [activeView, setActiveView] = useState<ViewMode>("list")

    // Modal states
    const [isAddTaskModalOpen, setIsAddTaskModalOpen] = useState(false)
    const [addTaskPrefillTitle, setAddTaskPrefillTitle] = useState("")
    const [addTaskPrefillDueDate, setAddTaskPrefillDueDate] = useState<Date | null>(null)
    const [addTaskPrefillProjectId, setAddTaskPrefillProjectId] = useState<string | null>(null)

    // Task Detail Panel states
    const [isDetailPanelOpen, setIsDetailPanelOpen] = useState(false)
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

    // Completed/Archive view states
    const [showArchivedView, setShowArchivedView] = useState(false)
    const [isClearMenuOpen, setIsClearMenuOpen] = useState(false)
    const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false)
    const [archiveDialogVariant, setArchiveDialogVariant] = useState<"all" | "older-than">("all")
    const [archiveOlderThanDays, setArchiveOlderThanDays] = useState(7)
    const [isDeleteCompletedDialogOpen, setIsDeleteCompletedDialogOpen] = useState(false)
    const [deleteCompletedVariant, setDeleteCompletedVariant] = useState<"completed" | "archived">("completed")

    // Filter bar ref
    const filterBarRef = useRef<FilterBarRef>(null)

    // Filter state with persistence
    const {
        filters,
        sort,
        updateFilters,
        updateSort,
        clearFilters,
        hasActiveFilters: filtersActive,
    } = useFilterState({
        selectedType,
        selectedId,
        activeView,
        persistFilters: true,
    })

    // Saved filters
    const {
        savedFilters,
        saveFilter,
        deleteFilter: deleteSavedFilter,
    } = useSavedFilters()

    // Bulk delete dialog state
    const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false)

    // Bulk due date picker state
    const [isBulkDueDatePickerOpen, setIsBulkDueDatePickerOpen] = useState(false)

    // ========== DERIVED STATE ==========

    // Derived: get the selected project (if any)
    const selectedProject = useMemo(() => {
        if (selectedType === "project") {
            return projects.find((p) => p.id === selectedId) || null
        }
        return null
    }, [selectedId, selectedType, projects])

    // Derived: available views based on selection
    const availableViews = useMemo((): ViewMode[] => {
        if (LIST_ONLY_VIEWS.includes(selectedId)) {
            return ["list"]
        }
        return ["list", "kanban", "calendar"]
    }, [selectedId])

    // Reset to list view if current view becomes unavailable
    useEffect(() => {
        if (!availableViews.includes(activeView)) {
            setActiveView("list")
        }
    }, [availableViews, activeView])

    // Derived: filtered tasks for current selection (base filter by view/project)
    const baseFilteredTasks = useMemo(() => {
        return getFilteredTasks(tasks, selectedId, selectedType, projects)
    }, [tasks, selectedId, selectedType, projects])

    // Apply advanced filters and sort to base filtered tasks
    const { filteredTasks: advancedFilteredTasks, totalCount, filteredCount } = useFilteredAndSortedTasks({
        tasks: baseFilteredTasks,
        filters,
        sort,
        projects,
    })

    // Determine which filtered tasks to use based on view
    const shouldApplyAdvancedFilters = selectedId !== "today" && selectedId !== "upcoming" && selectedId !== "completed"
    const filteredTasks = shouldApplyAdvancedFilters ? advancedFilteredTasks : baseFilteredTasks

    // For project list view, use base filtered tasks to show all statuses including Done
    const projectListTasks = selectedType === "project" ? baseFilteredTasks : filteredTasks

    // Check if we should show the filter empty state
    const showFilterEmptyState = shouldApplyAdvancedFilters && filtersActive && filteredCount === 0 && totalCount > 0

    // Visible task IDs for selection (used by multi-select)
    const visibleTaskIds = useMemo(() => {
        return filteredTasks.map((t) => t.id)
    }, [filteredTasks])

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
        exitSelectionMode,
    } = useTaskSelection(visibleTaskIds)

    // Bulk actions hook
    const bulkActions = useBulkActions({
        selectedIds: selectedTaskIds,
        tasks,
        projects,
        onUpdateTask: (taskId, updates) => {
            setTasks((prev) =>
                prev.map((task) => (task.id === taskId ? { ...task, ...updates } : task))
            )
        },
        onDeleteTask: (taskId) => {
            setTasks((prev) => prev.filter((t) => t.id !== taskId))
        },
        onComplete: deselectAll,
    })

    // Drag handlers hook
    const { handleDragEnd: onDragEndHandler } = useDragHandlers({
        tasks,
        projects,
        onUpdateTask: (taskId, updates) => {
            setTasks((prev) =>
                prev.map((task) => (task.id === taskId ? { ...task, ...updates } : task))
            )
        },
        onDeleteTask: (taskId) => {
            setTasks((prev) => prev.filter((t) => t.id !== taskId))
        },
    })

    // Drag event handlers for DragProvider
    const handleDragEnd = useCallback(
        (event: DragEndEvent, dragState: DragState) => {
            onDragEndHandler(event, dragState)
            if (dragState.activeIds.length > 1) {
                deselectAll()
            }
        },
        [onDragEndHandler, deselectAll]
    )

    // Toggle selection mode handler
    const handleToggleSelectionMode = useCallback(() => {
        if (selection.isSelectionMode) {
            exitSelectionMode()
        } else {
            enterSelectionMode()
        }
    }, [selection.isSelectionMode, enterSelectionMode, exitSelectionMode])

    // Subtask management hook
    const subtaskManagement = useSubtaskManagement({
        tasks,
        projects,
        onTasksChange: setTasks,
    })

    // Derived: task counts for header
    const taskCounts = useMemo(() => {
        return getTaskCounts(tasks, selectedId, selectedType, projects)
    }, [tasks, selectedId, selectedType, projects])

    // Derived: title for content header
    const headerTitle = useMemo(() => {
        if (selectedType === "view") {
            const view = taskViews.find((v) => v.id === selectedId)
            return view?.label || "All Tasks"
        }
        return selectedProject?.name || "Project"
    }, [selectedId, selectedType, selectedProject])

    // Derived: subtitle for content header
    const headerSubtitle = useMemo(() => {
        if (selectedId === "today") {
            const today = new Date()
            return today.toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
            })
        }
        if (shouldApplyAdvancedFilters && filtersActive) {
            return `Showing ${filteredCount} of ${totalCount} tasks`
        }
        return formatTaskSubtitle(taskCounts, selectedId, selectedType)
    }, [taskCounts, selectedId, selectedType, shouldApplyAdvancedFilters, filtersActive, filteredCount, totalCount])

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
        return status?.type === "done"
    }, [selectedTask, projects])

    // Show filter bar for views that support it
    const showFilterBar = selectedId !== "today" && selectedId !== "upcoming" && selectedId !== "completed"

    // ========== HANDLERS ==========

    const handleSelectView = (id: string): void => {
        onSelectionChange(id, "view")
    }

    const handleProjectSettings = (): void => {
        // Project settings are now handled in AppSidebar
        // This is kept for the settings button in the header
        // We could emit an event or use a context here
    }

    const handleViewChange = (view: ViewMode): void => {
        setActiveView(view)
    }

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
            if (e.key === "/" && !isInputFocused() && showFilterBar) {
                e.preventDefault()
                filterBarRef.current?.focusSearch()
            }

            // Shift+F to clear all filters
            if (e.key === "F" && e.shiftKey && !isInputFocused() && showFilterBar) {
                e.preventDefault()
                clearFilters()
                toast.success("Filters cleared")
            }

            // Cmd/Ctrl+A to select all visible tasks
            if ((e.metaKey || e.ctrlKey) && e.key === "a" && !isInputFocused()) {
                e.preventDefault()
                selectAll()
            }

            // Escape to clear selection
            if (e.key === "Escape" && hasSelection) {
                e.preventDefault()
                deselectAll()
            }

            // Cmd/Ctrl+Enter to complete selected tasks
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && hasSelection) {
                e.preventDefault()
                bulkActions.bulkComplete()
            }

            // Cmd/Ctrl+Backspace to delete selected tasks
            if ((e.metaKey || e.ctrlKey) && e.key === "Backspace" && hasSelection) {
                e.preventDefault()
                setIsBulkDeleteDialogOpen(true)
            }
        }

        window.addEventListener("keydown", handler)
        return () => window.removeEventListener("keydown", handler)
    }, [showFilterBar, clearFilters, hasSelection, selectAll, deselectAll, bulkActions])

    const handleAddTask = (): void => {
        setAddTaskPrefillTitle("")
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
        setAddTaskPrefillTitle("")
        setAddTaskPrefillDueDate(null)
        setAddTaskPrefillProjectId(null)
    }

    const handleAddTaskFromModal = useCallback((newTask: Task): void => {
        setTasks((prev) => [...prev, newTask])
    }, [setTasks])

    // Get default project and due date for the modal based on current selection
    const modalDefaultProjectId = useMemo(() => {
        if (selectedType === "project" && selectedProject) {
            return selectedProject.id
        }
        return "personal"
    }, [selectedType, selectedProject])

    const modalDefaultDueDate = useMemo((): Date | null => {
        if (selectedId === "today") {
            return startOfDay(new Date())
        }
        if (selectedId === "upcoming") {
            return addDays(startOfDay(new Date()), 1)
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
            let projectId = parsedData?.projectId || "personal"
            let dueDate = parsedData?.dueDate || null
            const priority = parsedData?.priority || "none"

            if (!parsedData?.projectId) {
                if (selectedType === "project" && selectedProject) {
                    projectId = selectedProject.id
                } else {
                    const personalProject = projects.find((p) => p.isDefault)
                    if (personalProject) {
                        projectId = personalProject.id
                    }
                }
            }

            if (!parsedData?.dueDate) {
                if (selectedId === "today") {
                    dueDate = startOfDay(new Date())
                } else if (selectedId === "upcoming") {
                    dueDate = addDays(startOfDay(new Date()), 1)
                }
            }

            const project = projects.find((p) => p.id === projectId)

            let statusId: string
            if (parsedData?.statusId) {
                statusId = parsedData.statusId
            } else {
                const defaultStatus = project ? getDefaultTodoStatus(project) : null
                statusId = defaultStatus?.id || project?.statuses[0]?.id || "p-todo"
            }

            const newTask = createDefaultTask(projectId, statusId, title, dueDate)
            newTask.priority = priority

            setTasks((prev) => [...prev, newTask])
        },
        [selectedId, selectedType, selectedProject, projects, setTasks]
    )

    const handleToggleComplete = useCallback(
        (taskId: string): void => {
            const taskToComplete = tasks.find((t) => t.id === taskId)
            if (!taskToComplete) return

            const project = projects.find((p) => p.id === taskToComplete.projectId)
            if (!project) return

            const currentStatus = project.statuses.find((s) => s.id === taskToComplete.statusId)
            if (!currentStatus) return

            if (currentStatus.type === "done") {
                const todoStatus = getDefaultTodoStatus(project)
                setTasks((prev) =>
                    prev.map((task) =>
                        task.id === taskId
                            ? { ...task, statusId: todoStatus?.id || task.statusId, completedAt: null }
                            : task
                    )
                )
                return
            }

            const doneStatus = getDefaultDoneStatus(project)

            if (taskToComplete.isRepeating && taskToComplete.repeatConfig && taskToComplete.dueDate) {
                const config = taskToComplete.repeatConfig
                const newCompletedCount = config.completedCount + 1
                const nextDate = calculateNextOccurrence(taskToComplete.dueDate, config)
                const shouldCreateNext = shouldCreateNextOccurrence({
                    ...config,
                    completedCount: newCompletedCount,
                })

                setTasks((prev) =>
                    prev.map((task) =>
                        task.id === taskId
                            ? {
                                ...task,
                                statusId: doneStatus?.id || task.statusId,
                                completedAt: new Date(),
                                repeatConfig: {
                                    ...config,
                                    completedCount: newCompletedCount,
                                },
                            }
                            : task
                    )
                )

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
                            completedCount: newCompletedCount,
                        },
                    }
                    setTasks((prev) => [...prev, newTask])
                    toast.success("Task completed!", {
                        description: `Next occurrence: ${formatDateShort(nextDate)}`,
                    })
                } else {
                    toast.success("Series complete!", {
                        description: "This was the final occurrence.",
                    })
                }
            } else {
                setTasks((prev) =>
                    prev.map((task) =>
                        task.id === taskId
                            ? { ...task, statusId: doneStatus?.id || task.statusId, completedAt: new Date() }
                            : task
                    )
                )
            }
        },
        [tasks, projects, setTasks]
    )

    const handleSkipOccurrence = useCallback(
        (taskId: string): void => {
            const task = tasks.find((t) => t.id === taskId)
            if (!task || !task.isRepeating || !task.repeatConfig || !task.dueDate) return

            const nextDate = calculateNextOccurrence(task.dueDate, task.repeatConfig)
            if (nextDate) {
                setTasks((prev) =>
                    prev.map((t) =>
                        t.id === taskId ? { ...t, dueDate: nextDate } : t
                    )
                )
                toast.success("Occurrence skipped", {
                    description: `Moved to ${formatDateShort(nextDate)}`,
                })
            }
        },
        [tasks, setTasks]
    )

    const handleStopRepeating = useCallback(
        (taskId: string, option: StopRepeatOption): void => {
            const task = tasks.find((t) => t.id === taskId)
            if (!task) return

            if (option === "delete") {
                setTasks((prev) => prev.filter((t) => t.id !== taskId))
                setIsDetailPanelOpen(false)
                setSelectedTaskId(null)
                toast.success("Repeating task deleted")
            } else {
                setTasks((prev) =>
                    prev.map((t) =>
                        t.id === taskId
                            ? { ...t, isRepeating: false, repeatConfig: null }
                            : t
                    )
                )
                toast.success("Task will no longer repeat")
            }
        },
        [tasks, setTasks]
    )

    const handleTaskClick = useCallback((taskId: string): void => {
        setSelectedTaskId(taskId)
        setIsDetailPanelOpen(true)
    }, [])

    const handleCloseDetailPanel = useCallback((): void => {
        setIsDetailPanelOpen(false)
        setSelectedTaskId(null)
    }, [])

    const handleUpdateTask = useCallback((taskId: string, updates: Partial<Task>): void => {
        setTasks((prev) =>
            prev.map((task) => (task.id === taskId ? { ...task, ...updates } : task))
        )
    }, [setTasks])

    const handleDeleteTask = useCallback((taskId: string): void => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        const deletedTask = { ...task }

        setTasks((prev) => prev.filter((t) => t.id !== taskId))
        setIsDetailPanelOpen(false)
        setSelectedTaskId(null)

        toast.success("Task deleted", {
            description: `"${task.title}" has been deleted.`,
            action: {
                label: "Undo",
                onClick: () => {
                    setTasks((prev) => [...prev, deletedTask])
                },
            },
        })
    }, [tasks, setTasks])

    const handleDuplicateTask = useCallback((taskId: string): void => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        const project = projects.find((p) => p.id === task.projectId)
        const defaultStatus = project ? getDefaultTodoStatus(project) : null

        const duplicatedTask: Task = {
            ...task,
            id: `task-${Date.now()}`,
            title: `${task.title} (copy)`,
            statusId: defaultStatus?.id || task.statusId,
            createdAt: new Date(),
            completedAt: null,
        }

        setTasks((prev) => [...prev, duplicatedTask])

        toast.success("Task duplicated", {
            description: `"${duplicatedTask.title}" has been created.`,
        })

        setSelectedTaskId(duplicatedTask.id)
    }, [tasks, projects, setTasks])

    const handleAddTaskWithDate = useCallback(
        (date: Date): void => {
            const projectId =
                selectedType === "project" && selectedProject ? selectedProject.id : "personal"
            setAddTaskPrefillProjectId(projectId)
            setAddTaskPrefillDueDate(date)
            setAddTaskPrefillTitle("")
            setIsAddTaskModalOpen(true)
        },
        [selectedProject, selectedType]
    )

    // ========== ARCHIVE HANDLERS ==========

    const handleUncompleteTask = useCallback(
        (taskId: string): void => {
            const task = tasks.find((t) => t.id === taskId)
            if (!task) return

            const project = projects.find((p) => p.id === task.projectId)
            if (!project) return

            const todoStatus = getDefaultTodoStatus(project)

            setTasks((prev) =>
                prev.map((t) =>
                    t.id === taskId
                        ? { ...t, statusId: todoStatus?.id || t.statusId, completedAt: null }
                        : t
                )
            )

            toast.success("Task restored to active")
        },
        [tasks, projects, setTasks]
    )

    const handleArchiveTask = useCallback(
        (taskId: string): void => {
            setTasks((prev) =>
                prev.map((t) =>
                    t.id === taskId
                        ? { ...t, archivedAt: new Date() }
                        : t
                )
            )

            toast.success("Task archived", {
                action: {
                    label: "Undo",
                    onClick: () => {
                        setTasks((prev) =>
                            prev.map((t) =>
                                t.id === taskId
                                    ? { ...t, archivedAt: null }
                                    : t
                            )
                        )
                    },
                },
            })
        },
        [setTasks]
    )

    const handleUnarchiveTask = useCallback(
        (taskId: string): void => {
            setTasks((prev) =>
                prev.map((t) =>
                    t.id === taskId
                        ? { ...t, archivedAt: null }
                        : t
                )
            )

            toast.success("Task restored to completed")
        },
        [setTasks]
    )

    const handleDeleteCompletedTask = useCallback(
        (taskId: string): void => {
            const task = tasks.find((t) => t.id === taskId)
            if (!task) return

            const deletedTask = { ...task }

            setTasks((prev) => prev.filter((t) => t.id !== taskId))

            toast.success("Task deleted", {
                action: {
                    label: "Undo",
                    onClick: () => {
                        setTasks((prev) => [...prev, deletedTask])
                    },
                },
            })
        },
        [tasks, setTasks]
    )

    const handleViewArchived = useCallback((): void => {
        setShowArchivedView(true)
    }, [])

    const handleBackFromArchived = useCallback((): void => {
        setShowArchivedView(false)
    }, [])

    const handleOpenClearMenu = useCallback((): void => {
        setIsClearMenuOpen(true)
    }, [])

    const completedTasksForActions = useMemo(
        () => getCompletedTasks(tasks),
        [tasks]
    )

    const archivedTasksForActions = useMemo(
        () => getArchivedTasks(tasks),
        [tasks]
    )

    const handleArchiveAll = useCallback((): void => {
        setArchiveDialogVariant("all")
        setIsArchiveDialogOpen(true)
    }, [])

    const handleArchiveOlderThan = useCallback((days: number): void => {
        setArchiveOlderThanDays(days)
        setArchiveDialogVariant("older-than")
        setIsArchiveDialogOpen(true)
    }, [])

    const handleConfirmArchive = useCallback((): void => {
        if (archiveDialogVariant === "all") {
            const completedIds = completedTasksForActions.map((t) => t.id)
            setTasks((prev) =>
                prev.map((t) =>
                    completedIds.includes(t.id)
                        ? { ...t, archivedAt: new Date() }
                        : t
                )
            )
            toast.success(`${completedIds.length} task${completedIds.length !== 1 ? "s" : ""} archived`)
        } else {
            const olderTasks = getTasksOlderThan(completedTasksForActions, archiveOlderThanDays)
            const olderIds = olderTasks.map((t) => t.id)
            setTasks((prev) =>
                prev.map((t) =>
                    olderIds.includes(t.id)
                        ? { ...t, archivedAt: new Date() }
                        : t
                )
            )
            toast.success(`${olderIds.length} task${olderIds.length !== 1 ? "s" : ""} archived`)
        }
        setIsArchiveDialogOpen(false)
    }, [archiveDialogVariant, archiveOlderThanDays, completedTasksForActions, setTasks])

    const tasksToArchiveCount = useMemo((): number => {
        if (archiveDialogVariant === "all") {
            return completedTasksForActions.length
        }
        return getTasksOlderThan(completedTasksForActions, archiveOlderThanDays).length
    }, [archiveDialogVariant, archiveOlderThanDays, completedTasksForActions])

    const handleDeleteAllCompleted = useCallback((): void => {
        setDeleteCompletedVariant("completed")
        setIsDeleteCompletedDialogOpen(true)
    }, [])

    const handleDeleteAllArchived = useCallback((): void => {
        setDeleteCompletedVariant("archived")
        setIsDeleteCompletedDialogOpen(true)
    }, [])

    const handleConfirmDeleteCompleted = useCallback((): void => {
        if (deleteCompletedVariant === "completed") {
            const completedIds = completedTasksForActions.map((t) => t.id)
            setTasks((prev) => prev.filter((t) => !completedIds.includes(t.id)))
            toast.success(`${completedIds.length} task${completedIds.length !== 1 ? "s" : ""} deleted permanently`)
        } else {
            const archivedIds = archivedTasksForActions.map((t) => t.id)
            setTasks((prev) => prev.filter((t) => !archivedIds.includes(t.id)))
            toast.success(`${archivedIds.length} task${archivedIds.length !== 1 ? "s" : ""} deleted permanently`)
        }
        setIsDeleteCompletedDialogOpen(false)
    }, [deleteCompletedVariant, completedTasksForActions, archivedTasksForActions, setTasks])

    const tasksToDeleteCount = useMemo((): number => {
        if (deleteCompletedVariant === "completed") {
            return completedTasksForActions.length
        }
        return archivedTasksForActions.length
    }, [deleteCompletedVariant, completedTasksForActions, archivedTasksForActions])

    const calendarTasks = useMemo(() => {
        if (selectedType === "project") {
            return tasks.filter((t) => t.projectId === selectedId)
        }
        return tasks
    }, [selectedType, selectedId, tasks])

    // ========== BULK ACTION HANDLERS ==========

    const handleBulkChangePriority = useCallback(
        (priority: Priority): void => {
            bulkActions.bulkChangePriority(priority)
        },
        [bulkActions]
    )

    const handleBulkChangeDueDate = useCallback(
        (option: string): void => {
            if (option === "pick-date") {
                setIsBulkDueDatePickerOpen(true)
                return
            }

            if (option === "remove") {
                bulkActions.bulkChangeDueDate(null)
                return
            }

            const today = startOfDay(new Date())
            let newDate: Date | null = null

            switch (option) {
                case "today":
                    newDate = today
                    break
                case "tomorrow":
                    newDate = addDays(today, 1)
                    break
                case "next-week":
                    newDate = addDays(today, 7)
                    break
                case "next-month":
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
            toast.success("Filter saved", {
                description: `"${name}" has been saved to your filters.`,
            })
        },
        [saveFilter]
    )

    const handleDeleteSavedFilter = useCallback(
        (filterId: string): void => {
            deleteSavedFilter(filterId)
            toast.success("Filter deleted")
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
        if (selectedType === "project" && selectedProject) {
            return selectedProject.statuses
        }
        return []
    }, [selectedType, selectedProject])

    return (
        <>
            <DragProvider
                tasks={tasks}
                selectedIds={selection.selectedIds}
                onDragEnd={handleDragEnd}
            >
                <div className={cn("flex h-full", className)}>
                    {/* Main Content Area - Full Width */}
                    <main className="flex flex-1 flex-col overflow-hidden">
                        {/* Content Header */}
                        <TasksContentHeader
                            title={headerTitle}
                            subtitle={headerSubtitle}
                            activeView={activeView}
                            availableViews={availableViews}
                            showProjectSettings={selectedType === "project" && !!selectedProject}
                            onViewChange={handleViewChange}
                            onAddTask={handleAddTask}
                            onProjectSettings={handleProjectSettings}
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
                                showStatusFilter={activeView === "kanban"}
                                statuses={currentProjectStatuses}
                                isSelectionMode={selection.isSelectionMode}
                                onToggleSelectionMode={handleToggleSelectionMode}
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
                                showStatusAction={activeView === "kanban" && selectedType === "project"}
                            />
                        )}

                        {/* Content Body - Today View */}
                        {activeView === "list" && selectedId === "today" && (
                            <TodayView
                                tasks={tasks}
                                projects={projects}
                                selectedTaskId={selectedTaskId}
                                onToggleComplete={handleToggleComplete}
                                onTaskClick={handleTaskClick}
                                onQuickAdd={handleQuickAdd}
                                onOpenModal={handleOpenAddTaskModal}
                                onViewUpcoming={() => handleSelectView("upcoming")}
                            />
                        )}

                        {/* Content Body - Upcoming View */}
                        {activeView === "list" && selectedId === "upcoming" && (
                            <UpcomingView
                                tasks={tasks}
                                projects={projects}
                                selectedTaskId={selectedTaskId}
                                onToggleComplete={handleToggleComplete}
                                onTaskClick={handleTaskClick}
                                onQuickAdd={handleQuickAdd}
                                onOpenModal={handleOpenAddTaskModal}
                                onAddTaskWithDate={handleAddTaskWithDate}
                            />
                        )}

                        {/* Content Body - Completed View */}
                        {activeView === "list" && selectedId === "completed" && !showArchivedView && (
                            <CompletedView
                                tasks={tasks}
                                projects={projects}
                                onUncomplete={handleUncompleteTask}
                                onArchive={handleArchiveTask}
                                onDelete={handleDeleteCompletedTask}
                                onViewArchived={handleViewArchived}
                                onOpenClearMenu={handleOpenClearMenu}
                            />
                        )}

                        {/* Content Body - Archived View */}
                        {activeView === "list" && selectedId === "completed" && showArchivedView && (
                            <ArchivedView
                                tasks={tasks}
                                projects={projects}
                                onBack={handleBackFromArchived}
                                onRestore={handleUnarchiveTask}
                                onDelete={handleDeleteCompletedTask}
                                onDeleteAll={handleDeleteAllArchived}
                            />
                        )}

                        {/* Content Body - Task List (for other views) */}
                        {activeView === "list" && selectedId !== "today" && selectedId !== "upcoming" && selectedId !== "completed" && (
                            showFilterEmptyState ? (
                                <FilterEmptyState
                                    filters={filters}
                                    projects={projects}
                                    onClearFilters={clearFilters}
                                />
                            ) : (
                                <TaskList
                                    tasks={selectedType === "project" ? projectListTasks : filteredTasks}
                                    projects={projects}
                                    selectedId={selectedId}
                                    selectedType={selectedType}
                                    selectedTaskId={selectedTaskId}
                                    onToggleComplete={handleToggleComplete}
                                    onToggleSubtaskComplete={subtaskManagement.handleCompleteSubtask}
                                    onTaskClick={handleTaskClick}
                                    onQuickAdd={handleQuickAdd}
                                    onOpenModal={handleOpenAddTaskModal}
                                    isSelectionMode={selection.isSelectionMode}
                                    selectedIds={selection.selectedIds}
                                    onToggleSelect={toggleTask}
                                    onShiftSelect={selectRange}
                                />
                            )
                        )}

                        {/* Kanban View */}
                        {activeView === "kanban" && (
                            showFilterEmptyState ? (
                                <FilterEmptyState
                                    filters={filters}
                                    projects={projects}
                                    onClearFilters={clearFilters}
                                />
                            ) : (
                                <KanbanBoard
                                    tasks={filteredTasks}
                                    projects={projects}
                                    selectedId={selectedId}
                                    selectedType={selectedType}
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
                            )
                        )}

                        {/* Calendar view */}
                        {activeView === "calendar" && (
                            <CalendarView
                                tasks={calendarTasks}
                                projects={projects}
                                selectedId={selectedId}
                                selectedType={selectedType}
                                onUpdateTask={handleUpdateTask}
                                onTaskClick={handleTaskClick}
                                onAddTaskWithDate={handleAddTaskWithDate}
                                onToggleComplete={handleToggleComplete}
                                isSelectionMode={selection.isSelectionMode}
                                selectedIds={selection.selectedIds}
                                onToggleSelect={toggleTask}
                            />
                        )}
                    </main>

                    {/* Drag Overlay */}
                    <TaskDragOverlay projects={projects} />
                </div>
            </DragProvider>

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
                completedCount={completedTasksForActions.length}
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
                parentTitle={subtaskManagement.pendingAutoCompleteParent?.title || ""}
                subtaskCount={subtaskManagement.pendingAutoCompleteParent ? getSubtasks(subtaskManagement.pendingAutoCompleteParent.id, tasks).length : 0}
                onClose={subtaskManagement.closeAllSubtasksCompleteDialog}
                onKeepOpen={subtaskManagement.keepParentOpen}
                onCompleteParent={subtaskManagement.autoCompleteParent}
            />

            {/* Bulk Due Date Dialog for Subtasks */}
            <BulkDueDateDialog
                isOpen={subtaskManagement.bulkDueDateDialogOpen}
                parentTitle={subtaskManagement.pendingBulkOperationParent?.title || ""}
                subtaskCount={subtaskManagement.pendingBulkOperationSubtasks.length}
                completedCount={subtaskManagement.pendingBulkOperationSubtasks.filter((s) => s.completedAt !== null).length}
                onClose={subtaskManagement.closeBulkDueDateDialog}
                onApply={subtaskManagement.confirmBulkDueDate}
            />

            {/* Bulk Priority Dialog for Subtasks */}
            <BulkPriorityDialog
                isOpen={subtaskManagement.bulkPriorityDialogOpen}
                parentTitle={subtaskManagement.pendingBulkOperationParent?.title || ""}
                subtaskCount={subtaskManagement.pendingBulkOperationSubtasks.length}
                completedCount={subtaskManagement.pendingBulkOperationSubtasks.filter((s) => s.completedAt !== null).length}
                onClose={subtaskManagement.closeBulkPriorityDialog}
                onApply={subtaskManagement.confirmBulkPriority}
            />

            {/* Delete All Subtasks Dialog */}
            <DeleteAllSubtasksDialog
                isOpen={subtaskManagement.deleteAllSubtasksDialogOpen}
                parentTitle={subtaskManagement.pendingBulkOperationParent?.title || ""}
                subtasks={subtaskManagement.pendingBulkOperationSubtasks}
                onClose={subtaskManagement.closeDeleteAllSubtasksDialog}
                onConfirm={subtaskManagement.confirmDeleteAllSubtasks}
            />
        </>
    )
}
