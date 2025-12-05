import { useState, useMemo, useCallback, useEffect, useRef } from "react"
import {
    List,
    Star,
    Calendar,
    Check,
    Plus,
    LayoutList,
    Columns3,
    CalendarDays,
    Settings,
} from "lucide-react"
import type { DragEndEvent } from "@dnd-kit/core"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { toast } from "sonner"
import { ProjectModal } from "@/components/tasks/project-modal"
import { DeleteProjectDialog, type DeleteTasksOption } from "@/components/tasks/delete-project-dialog"
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
import { TasksSidebar, type SidebarView, type SidebarProject } from "@/components/tasks/tasks-sidebar"
import { FilterBar, FilterEmptyState, type FilterBarRef } from "@/components/tasks/filters"
import { TaskDragOverlay, DroppableProjectItem } from "@/components/tasks/drag-drop"
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
    initialProjects,
    LIST_ONLY_VIEWS,
    type TaskView,
    type Project,
    type ViewMode,
    type TaskFilters,
    type TaskSort,
    type SavedFilter,
} from "@/data/tasks-data"
import { sampleTasks, createDefaultTask, generateTaskId, type Task, type Priority } from "@/data/sample-tasks"
import { addDays } from "@/lib/task-utils"
import { calculateNextOccurrence, shouldCreateNextOccurrence } from "@/lib/repeat-utils"
import type { StopRepeatOption } from "@/components/tasks/stop-repeating-dialog"
import { useFilterState, useSavedFilters, useFilteredAndSortedTasks, useTaskSelection, useBulkActions, useDragHandlers } from "@/hooks"
import { BulkActionToolbar, BulkDeleteDialog, BulkDueDatePicker } from "@/components/tasks/bulk-actions"

// ============================================================================
// TYPES
// ============================================================================

type SelectionType = "view" | "project"

interface TasksPageProps {
    className?: string
}

interface TasksLeftColumnProps {
    selectedId: string
    selectedType: SelectionType
    projects: Project[]
    viewCounts: Record<string, number>
    onSelectView: (id: string) => void
    onSelectProject: (id: string) => void
    onNewProject: () => void
    onEditProject: (project: Project) => void
}

interface TasksViewsSectionProps {
    selectedId: string
    selectedType: SelectionType
    viewCounts: Record<string, number>
    onSelect: (id: string) => void
}

interface TasksProjectsSectionProps {
    selectedId: string
    selectedType: SelectionType
    projects: Project[]
    onSelect: (id: string) => void
    onNewProject: () => void
    onEditProject: (project: Project) => void
}

interface TasksViewNavItemProps {
    id: string
    label: string
    icon: React.ReactNode
    count: number
    isSelected: boolean
    onSelect: (id: string) => void
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
// ICON MAPPING
// ============================================================================

const viewIconMap: Record<TaskView["icon"], React.ReactNode> = {
    list: <List className="size-4" />,
    star: <Star className="size-4" />,
    calendar: <Calendar className="size-4" />,
    check: <Check className="size-4" />,
}

// ============================================================================
// VIEW NAV ITEM COMPONENT
// ============================================================================

const TasksViewNavItem = ({
    id,
    label,
    icon,
    count,
    isSelected,
    onSelect,
}: TasksViewNavItemProps): React.JSX.Element => {
    const handleClick = (): void => {
        onSelect(id)
    }

    const handleKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onSelect(id)
        }
    }

    return (
        <button
            type="button"
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            aria-label={`${label}, ${count} tasks`}
            aria-pressed={isSelected}
            className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected && "bg-accent border-l-3 border-l-primary font-medium"
            )}
        >
            <span className="shrink-0 text-text-tertiary" aria-hidden="true">
                {icon}
            </span>
            <span className="flex-1 truncate text-left text-text-secondary">{label}</span>
            <span className="shrink-0 text-xs text-text-tertiary">{count}</span>
        </button>
    )
}

// ============================================================================
// VIEWS SECTION COMPONENT
// ============================================================================

const TasksViewsSection = ({
    selectedId,
    selectedType,
    viewCounts,
    onSelect,
}: TasksViewsSectionProps): React.JSX.Element => {
    return (
        <section aria-labelledby="views-section-label">
            <h2
                id="views-section-label"
                className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-text-tertiary"
            >
                Views
            </h2>
            <nav className="flex flex-col gap-0.5" role="navigation" aria-label="Task views">
                {taskViews.map((view) => (
                    <TasksViewNavItem
                        key={view.id}
                        id={view.id}
                        label={view.label}
                        icon={viewIconMap[view.icon]}
                        count={viewCounts[view.id] || 0}
                        isSelected={selectedType === "view" && selectedId === view.id}
                        onSelect={onSelect}
                    />
                ))}
            </nav>
        </section>
    )
}

// ============================================================================
// PROJECTS SECTION COMPONENT
// ============================================================================

const TasksProjectsSection = ({
    selectedId,
    selectedType,
    projects,
    onSelect,
    onNewProject,
    onEditProject,
}: TasksProjectsSectionProps): React.JSX.Element => {
    const handleNewProjectClick = (): void => {
        onNewProject()
    }

    const handleNewProjectKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onNewProject()
        }
    }

    // Filter out archived projects
    const visibleProjects = projects.filter((p) => !p.isArchived)

    return (
        <section aria-labelledby="projects-section-label">
            <h2
                id="projects-section-label"
                className="mb-2 px-3 text-xs font-medium uppercase tracking-wide text-text-tertiary"
            >
                Projects
            </h2>
            <nav className="flex flex-col gap-0.5" role="navigation" aria-label="Projects">
                {visibleProjects.map((project) => (
                    <DroppableProjectItem
                        key={project.id}
                        project={project}
                        isSelected={selectedType === "project" && selectedId === project.id}
                        onClick={() => onSelect(project.id)}
                        onEdit={onEditProject}
                    />
                ))}
            </nav>

            {/* New Project Button */}
            <button
                type="button"
                onClick={handleNewProjectClick}
                onKeyDown={handleNewProjectKeyDown}
                tabIndex={0}
                aria-label="Create new project"
                className={cn(
                    "mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm",
                    "text-text-tertiary transition-colors duration-150",
                    "hover:bg-accent/50 hover:text-text-secondary",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                )}
            >
                <Plus className="size-4" aria-hidden="true" />
                <span>New Project</span>
            </button>
        </section>
    )
}

// ============================================================================
// LEFT COLUMN COMPONENT
// ============================================================================

const TasksLeftColumn = ({
    selectedId,
    selectedType,
    projects,
    viewCounts,
    onSelectView,
    onSelectProject,
    onNewProject,
    onEditProject,
}: TasksLeftColumnProps): React.JSX.Element => {
    return (
        <aside
            className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-surface"
            aria-label="Task navigation"
        >
            <ScrollArea className="flex-1">
                <div className="flex flex-col gap-6 p-4">
                    <TasksViewsSection
                        selectedId={selectedId}
                        selectedType={selectedType}
                        viewCounts={viewCounts}
                        onSelect={onSelectView}
                    />
                    <TasksProjectsSection
                        selectedId={selectedId}
                        selectedType={selectedType}
                        projects={projects}
                        onSelect={onSelectProject}
                        onNewProject={onNewProject}
                        onEditProject={onEditProject}
                    />
                </div>
            </ScrollArea>
        </aside>
    )
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

export const TasksPage = ({ className }: TasksPageProps): React.JSX.Element => {
    // Projects state (lifted to page level)
    const [projects, setProjects] = useState<Project[]>(initialProjects)

    // Tasks state
    const [tasks, setTasks] = useState<Task[]>(sampleTasks)

    // Selection state - single selection model (either view OR project)
    const [selectedId, setSelectedId] = useState<string>("all")
    const [selectedType, setSelectedType] = useState<SelectionType>("view")

    // View mode state
    const [activeView, setActiveView] = useState<ViewMode>("list")

    // Sidebar state
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
    const [userPreferredCollapsed, setUserPreferredCollapsed] = useState<boolean | null>(null)

    // Modal states
    const [isProjectModalOpen, setIsProjectModalOpen] = useState(false)
    const [editingProject, setEditingProject] = useState<Project | null>(null)
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
    const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
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

    // Calculate view counts dynamically
    const viewCounts = useMemo(() => {
        const counts: Record<string, number> = {}

        taskViews.forEach((view) => {
            const filtered = getFilteredTasks(tasks, view.id, "view", projects)
            counts[view.id] = filtered.length
        })

        return counts
    }, [tasks, projects])

    // Update project task counts
    const projectsWithCounts = useMemo(() => {
        return projects.map((project) => {
            const projectTasks = tasks.filter((t) => t.projectId === project.id)
            const incompleteTasks = projectTasks.filter((t) => {
                const status = project.statuses.find((s) => s.id === t.statusId)
                return status?.type !== "done"
            })
            return { ...project, taskCount: incompleteTasks.length }
        })
    }, [projects, tasks])

    // Derived: get the selected project (if any)
    const selectedProject = useMemo(() => {
        if (selectedType === "project") {
            return projectsWithCounts.find((p) => p.id === selectedId) || null
        }
        return null
    }, [selectedId, selectedType, projectsWithCounts])

    // Derived: available views based on selection
    const availableViews = useMemo((): ViewMode[] => {
        if (LIST_ONLY_VIEWS.includes(selectedId)) {
            return ["list"]
        }
        return ["list", "kanban", "calendar"]
    }, [selectedId])

    // Reset to list view if current view becomes unavailable
    useMemo(() => {
        if (!availableViews.includes(activeView)) {
            setActiveView("list")
        }
    }, [availableViews, activeView])

    // Derived: filtered tasks for current selection (base filter by view/project)
    const baseFilteredTasks = useMemo(() => {
        return getFilteredTasks(tasks, selectedId, selectedType, projectsWithCounts)
    }, [tasks, selectedId, selectedType, projectsWithCounts])

    // Apply advanced filters and sort to base filtered tasks
    const { filteredTasks: advancedFilteredTasks, totalCount, filteredCount } = useFilteredAndSortedTasks({
        tasks: baseFilteredTasks,
        filters,
        sort,
        projects: projectsWithCounts,
    })

    // Determine which filtered tasks to use based on view
    // For special views (today, upcoming, completed), we don't apply advanced filters
    // For project list view, we want to see all tasks grouped by status (including completed)
    const shouldApplyAdvancedFilters = selectedId !== "today" && selectedId !== "upcoming" && selectedId !== "completed"
    const filteredTasks = shouldApplyAdvancedFilters ? advancedFilteredTasks : baseFilteredTasks

    // For project list view, use base filtered tasks to show all statuses including Done
    // This allows the StatusTaskGroup to show completed tasks in their proper status group
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
    } = useTaskSelection(visibleTaskIds)

    // Bulk actions hook
    const bulkActions = useBulkActions({
        selectedIds: selectedTaskIds,
        tasks,
        projects: projectsWithCounts,
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
        projects: projectsWithCounts,
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
            // Clear selection after successful multi-drag
            if (dragState.activeIds.length > 1) {
                deselectAll()
            }
        },
        [onDragEndHandler, deselectAll]
    )

    // Derived: task counts for header
    const taskCounts = useMemo(() => {
        return getTaskCounts(tasks, selectedId, selectedType, projectsWithCounts)
    }, [tasks, selectedId, selectedType, projectsWithCounts])

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
        // For Today view, show full date like "Monday, December 16"
        if (selectedId === "today") {
            const today = new Date()
            return today.toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
            })
        }
        // Show filtered count when filters are active
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
        const project = projectsWithCounts.find((p) => p.id === selectedTask.projectId)
        if (!project) return false
        const status = project.statuses.find((s) => s.id === selectedTask.statusId)
        return status?.type === "done"
    }, [selectedTask, projectsWithCounts])

    // Show filter bar for views that support it
    const showFilterBar = selectedId !== "today" && selectedId !== "upcoming" && selectedId !== "completed"

    // ========== HANDLERS ==========

    const handleSelectView = (id: string): void => {
        setSelectedId(id)
        setSelectedType("view")
    }

    const handleSelectProject = (id: string): void => {
        setSelectedId(id)
        setSelectedType("project")
    }

    const handleNewProject = (): void => {
        setEditingProject(null)
        setIsProjectModalOpen(true)
    }

    const handleEditProject = useCallback((project: Project): void => {
        setEditingProject(project)
        setIsProjectModalOpen(true)
    }, [])

    const handleProjectModalClose = (): void => {
        setIsProjectModalOpen(false)
        setEditingProject(null)
    }

    const handleProjectSave = useCallback((project: Project): void => {
        setProjects((prev) => {
            const existingIndex = prev.findIndex((p) => p.id === project.id)
            if (existingIndex >= 0) {
                // Update existing project
                const updated = [...prev]
                updated[existingIndex] = project
                return updated
            }
            // Add new project
            return [...prev, project]
        })
    }, [])

    const handleProjectDelete = useCallback((projectId: string): void => {
        const project = projects.find((p) => p.id === projectId)
        if (project && !project.isDefault) {
            setProjectToDelete(project)
            setIsDeleteDialogOpen(true)
            setIsProjectModalOpen(false)
        }
    }, [projects])

    const handleDeleteDialogClose = (): void => {
        setIsDeleteDialogOpen(false)
        setProjectToDelete(null)
    }

    const handleDeleteConfirm = useCallback(
        (option: DeleteTasksOption): void => {
            if (!projectToDelete) return

            if (option === "move") {
                // Move tasks to Personal project
                const personalProject = projects.find((p) => p.isDefault)
                if (personalProject) {
                    const defaultStatus = getDefaultTodoStatus(personalProject)
                    if (defaultStatus) {
                        setTasks((prev) =>
                            prev.map((task) =>
                                task.projectId === projectToDelete.id
                                    ? { ...task, projectId: personalProject.id, statusId: defaultStatus.id }
                                    : task
                            )
                        )
                    }
                }
            } else {
                // Delete all tasks in project
                setTasks((prev) => prev.filter((t) => t.projectId !== projectToDelete.id))
            }

            // Remove project
            setProjects((prev) => prev.filter((p) => p.id !== projectToDelete.id))

            // If deleted project was selected, switch to "All Tasks"
            if (selectedId === projectToDelete.id) {
                setSelectedId("all")
                setSelectedType("view")
            }

            setIsDeleteDialogOpen(false)
            setProjectToDelete(null)
        },
        [projectToDelete, selectedId, projects]
    )

    const handleProjectSettings = (): void => {
        if (selectedProject) {
            handleEditProject(selectedProject)
        }
    }

    const handleViewChange = (view: ViewMode): void => {
        setActiveView(view)
    }

    const toggleSidebar = useCallback(() => {
        setSidebarCollapsed((prev) => {
            const next = !prev
            setUserPreferredCollapsed(next)
            try {
                localStorage.setItem("tasksSidebarCollapsed", JSON.stringify(next))
            } catch (err) {
                // ignore storage errors
            }
            return next
        })
    }, [])

    // Load saved preference
    useEffect(() => {
        try {
            const saved = localStorage.getItem("tasksSidebarCollapsed")
            if (saved !== null) {
                const parsed = JSON.parse(saved)
                setUserPreferredCollapsed(parsed)
                setSidebarCollapsed(parsed)
            }
        } catch (err) {
            // ignore
        }
    }, [])

    // Auto-collapse for space-hungry views when no user preference
    useEffect(() => {
        if (userPreferredCollapsed !== null) return
        if (activeView === "calendar" || activeView === "kanban") {
            setSidebarCollapsed(true)
        } else {
            setSidebarCollapsed(false)
        }
    }, [activeView, userPreferredCollapsed])

    // Keyboard shortcut Cmd/Ctrl + B or Cmd/Ctrl + \\
    useEffect(() => {
        const handler = (e: KeyboardEvent): void => {
            if (e.key === "b" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                toggleSidebar()
            }
            if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                toggleSidebar()
            }
        }
        window.addEventListener("keydown", handler)
        return () => window.removeEventListener("keydown", handler)
    }, [toggleSidebar])

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
        // Open the add task modal
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
    }, [])

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
            return addDays(startOfDay(new Date()), 1) // tomorrow
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
                statusId?: string | null // Optional status ID for kanban column context
            }
        ): void => {
            // Use parsed data if available, otherwise use context defaults
            let projectId = parsedData?.projectId || "personal"
            let dueDate = parsedData?.dueDate || null
            const priority = parsedData?.priority || "none"

            // If no project was parsed, use context default
            if (!parsedData?.projectId) {
                if (selectedType === "project" && selectedProject) {
                    projectId = selectedProject.id
                } else {
                    const personalProject = projectsWithCounts.find((p) => p.isDefault)
                    if (personalProject) {
                        projectId = personalProject.id
                    }
                }
            }

            // If no due date was parsed, use context default
            if (!parsedData?.dueDate) {
                if (selectedId === "today") {
                    dueDate = startOfDay(new Date())
                } else if (selectedId === "upcoming") {
                    dueDate = addDays(startOfDay(new Date()), 1) // tomorrow
                }
            }

            // Find the project
            const project = projectsWithCounts.find((p) => p.id === projectId)

            // Use provided statusId if available (from kanban column), otherwise fall back to default todo status
            let statusId: string
            if (parsedData?.statusId) {
                statusId = parsedData.statusId
            } else {
                const defaultStatus = project ? getDefaultTodoStatus(project) : null
                statusId = defaultStatus?.id || project?.statuses[0]?.id || "p-todo"
            }

            const newTask = createDefaultTask(projectId, statusId, title, dueDate)
            // Apply priority from parsed data
            newTask.priority = priority

            setTasks((prev) => [...prev, newTask])
        },
        [selectedId, selectedType, selectedProject, projectsWithCounts]
    )

    const handleToggleComplete = useCallback(
        (taskId: string): void => {
            const taskToComplete = tasks.find((t) => t.id === taskId)
            if (!taskToComplete) return

            const project = projectsWithCounts.find((p) => p.id === taskToComplete.projectId)
            if (!project) return

            const currentStatus = project.statuses.find((s) => s.id === taskToComplete.statusId)
            if (!currentStatus) return

            // If uncompleting, just update the status
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

            // Completing a task
            const doneStatus = getDefaultDoneStatus(project)

            // Handle repeating task completion
            if (taskToComplete.isRepeating && taskToComplete.repeatConfig && taskToComplete.dueDate) {
                const config = taskToComplete.repeatConfig
                const newCompletedCount = config.completedCount + 1
                const nextDate = calculateNextOccurrence(taskToComplete.dueDate, config)
                const shouldCreateNext = shouldCreateNextOccurrence({
                    ...config,
                    completedCount: newCompletedCount,
                })

                // Mark current task complete
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

                // Create next occurrence if applicable
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
                // Regular task completion
                setTasks((prev) =>
                    prev.map((task) =>
                        task.id === taskId
                            ? { ...task, statusId: doneStatus?.id || task.statusId, completedAt: new Date() }
                            : task
                    )
                )
            }
        },
        [tasks, projectsWithCounts]
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
        [tasks]
    )

    const handleStopRepeating = useCallback(
        (taskId: string, option: StopRepeatOption): void => {
            const task = tasks.find((t) => t.id === taskId)
            if (!task) return

            if (option === "delete") {
                // Delete the task entirely
                setTasks((prev) => prev.filter((t) => t.id !== taskId))
                setIsDetailPanelOpen(false)
                setSelectedTaskId(null)
                toast.success("Repeating task deleted")
            } else {
                // Keep task but stop repeating
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
        [tasks]
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
    }, [])

    const handleDeleteTask = useCallback((taskId: string): void => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        // Store for undo
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
    }, [tasks])

    const handleDuplicateTask = useCallback((taskId: string): void => {
        const task = tasks.find((t) => t.id === taskId)
        if (!task) return

        const project = projectsWithCounts.find((p) => p.id === task.projectId)
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

        // Open the duplicated task in the panel
        setSelectedTaskId(duplicatedTask.id)
    }, [tasks, projectsWithCounts])

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

            const project = projectsWithCounts.find((p) => p.id === task.projectId)
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
        [tasks, projectsWithCounts]
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
        []
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
        []
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
        [tasks]
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
            // Archive all completed tasks
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
            // Archive tasks older than N days
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
    }, [archiveDialogVariant, archiveOlderThanDays, completedTasksForActions])

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
    }, [deleteCompletedVariant, completedTasksForActions, archivedTasksForActions])

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

            // Calculate date based on option
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
        (date: Date, time: string | null): void => {
            // If time is provided, set the dueTime on the tasks as well
            if (time) {
                // For now, just set the date - time handling can be added later
                bulkActions.bulkChangeDueDate(date)
            } else {
                bulkActions.bulkChangeDueDate(date)
            }
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

    const sidebarViews: SidebarView[] = useMemo(
        () =>
            taskViews.map((view) => ({
                id: view.id,
                label: view.label,
                count: viewCounts[view.id] || 0,
                icon: viewIconMap[view.icon],
            })),
        [viewCounts]
    )

    const sidebarProjects: SidebarProject[] = useMemo(
        () =>
            projectsWithCounts
                .filter((p) => !p.isArchived)
                .map((p) => ({
                    id: p.id,
                    name: p.name,
                    taskCount: p.taskCount,
                    color: p.color,
                })),
        [projectsWithCounts]
    )

    return (
        <>
            <DragProvider
                tasks={tasks}
                selectedIds={selection.selectedIds}
                onDragEnd={handleDragEnd}
            >
                <div className={cn("flex h-full", className)}>
                    <TasksSidebar
                        collapsed={sidebarCollapsed}
                        onToggle={toggleSidebar}
                        views={sidebarViews}
                        projects={sidebarProjects}
                        selectedId={selectedId}
                        selectedType={selectedType}
                        onSelectView={handleSelectView}
                        onSelectProject={handleSelectProject}
                        onNewProject={handleNewProject}
                        renderExpanded={
                            <TasksLeftColumn
                                selectedId={selectedId}
                                selectedType={selectedType}
                                projects={projectsWithCounts}
                                viewCounts={viewCounts}
                                onSelectView={handleSelectView}
                                onSelectProject={handleSelectProject}
                                onNewProject={handleNewProject}
                                onEditProject={handleEditProject}
                            />
                        }
                    />

                    {/* Main Content Area */}
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
                                projects={projectsWithCounts}
                                tasks={baseFilteredTasks}
                                savedFilters={savedFilters}
                                onSaveFilter={handleSaveFilter}
                                onDeleteSavedFilter={handleDeleteSavedFilter}
                                onApplySavedFilter={handleApplySavedFilter}
                                showStatusFilter={activeView === "kanban"}
                                statuses={currentProjectStatuses}
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
                                projects={projectsWithCounts}
                                statuses={currentProjectStatuses}
                                showStatusAction={activeView === "kanban" && selectedType === "project"}
                            />
                        )}

                        {/* Content Body - Today View */}
                        {activeView === "list" && selectedId === "today" && (
                            <TodayView
                                tasks={tasks}
                                projects={projectsWithCounts}
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
                                projects={projectsWithCounts}
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
                                projects={projectsWithCounts}
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
                                projects={projectsWithCounts}
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
                                    projects={projectsWithCounts}
                                    onClearFilters={clearFilters}
                                />
                            ) : (
                                <TaskList
                                    tasks={selectedType === "project" ? projectListTasks : filteredTasks}
                                    projects={projectsWithCounts}
                                    selectedId={selectedId}
                                    selectedType={selectedType}
                                    selectedTaskId={selectedTaskId}
                                    onToggleComplete={handleToggleComplete}
                                    onTaskClick={handleTaskClick}
                                    onQuickAdd={handleQuickAdd}
                                    onOpenModal={handleOpenAddTaskModal}
                                    // Selection props
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
                                    projects={projectsWithCounts}
                                    onClearFilters={clearFilters}
                                />
                            ) : (
                                <KanbanBoard
                                    tasks={filteredTasks}
                                    projects={projectsWithCounts}
                                    selectedId={selectedId}
                                    selectedType={selectedType}
                                    selectedTaskId={selectedTaskId}
                                    onUpdateTask={handleUpdateTask}
                                    onTaskClick={handleTaskClick}
                                    onToggleComplete={handleToggleComplete}
                                    onDeleteTask={handleDeleteTask}
                                    onQuickAdd={handleQuickAdd}
                                    // Selection props
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
                                projects={projectsWithCounts}
                                selectedId={selectedId}
                                selectedType={selectedType}
                                onUpdateTask={handleUpdateTask}
                                onTaskClick={handleTaskClick}
                                onAddTaskWithDate={handleAddTaskWithDate}
                                onToggleComplete={handleToggleComplete}
                                // Selection props
                                isSelectionMode={selection.isSelectionMode}
                                selectedIds={selection.selectedIds}
                                onToggleSelect={toggleTask}
                            />
                        )}
                    </main>

                    {/* Drag Overlay */}
                    <TaskDragOverlay projects={projectsWithCounts} />
                </div>
            </DragProvider>

            {/* Project Modal */}
            <ProjectModal
                isOpen={isProjectModalOpen}
                onClose={handleProjectModalClose}
                onSave={handleProjectSave}
                onDelete={handleProjectDelete}
                project={editingProject}
            />

            {/* Delete Project Dialog */}
            <DeleteProjectDialog
                isOpen={isDeleteDialogOpen}
                onClose={handleDeleteDialogClose}
                onConfirm={handleDeleteConfirm}
                project={projectToDelete}
            />

            {/* Add Task Modal */}
            <AddTaskModal
                isOpen={isAddTaskModalOpen}
                onClose={handleAddTaskModalClose}
                onAddTask={handleAddTaskFromModal}
                projects={projectsWithCounts}
                defaultProjectId={addTaskPrefillProjectId || modalDefaultProjectId}
                defaultDueDate={addTaskPrefillDueDate || modalDefaultDueDate}
                prefillTitle={addTaskPrefillTitle}
            />

            {/* Task Detail Panel */}
            <TaskDetailPanel
                isOpen={isDetailPanelOpen}
                task={selectedTask}
                projects={projectsWithCounts}
                isCompleted={isSelectedTaskCompleted}
                onClose={handleCloseDetailPanel}
                onUpdateTask={handleUpdateTask}
                onToggleComplete={handleToggleComplete}
                onDeleteTask={handleDeleteTask}
                onDuplicateTask={handleDuplicateTask}
                onSkipOccurrence={handleSkipOccurrence}
                onStopRepeating={handleStopRepeating}
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
        </>
    )
}
