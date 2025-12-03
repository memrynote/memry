import { useState, useMemo, useCallback } from "react"
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
import { getIconByName } from "@/components/icon-picker"
import { cn } from "@/lib/utils"
import {
    getFilteredTasks,
    getTaskCounts,
    formatTaskSubtitle,
    getDefaultTodoStatus,
    getDefaultDoneStatus,
    startOfDay,
} from "@/lib/task-utils"
import {
    taskViews,
    initialProjects,
    LIST_ONLY_VIEWS,
    type TaskView,
    type Project,
    type ViewMode,
} from "@/data/tasks-data"
import { sampleTasks, createDefaultTask, type Task, type Priority } from "@/data/sample-tasks"
import { addDays } from "@/lib/task-utils"

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

interface TasksProjectNavItemProps {
    project: Project
    isSelected: boolean
    onSelect: (id: string) => void
    onEdit: (project: Project) => void
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
// PROJECT NAV ITEM COMPONENT (with edit button on hover)
// ============================================================================

const TasksProjectNavItem = ({
    project,
    isSelected,
    onSelect,
    onEdit,
}: TasksProjectNavItemProps): React.JSX.Element => {
    const handleClick = (): void => {
        onSelect(project.id)
    }

    const handleKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onSelect(project.id)
        }
    }

    const handleEditClick = (e: React.MouseEvent): void => {
        e.stopPropagation()
        onEdit(project)
    }

    const handleEditKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            e.stopPropagation()
            onEdit(project)
        }
    }

    // Get the icon component
    const IconComponent = getIconByName(project.icon)

    return (
        <div
            role="button"
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            aria-label={`${project.name}, ${project.taskCount} tasks`}
            aria-pressed={isSelected}
            className={cn(
                "group flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected && "bg-accent border-l-3 border-l-primary font-medium"
            )}
        >
            {/* Project Icon or Color Dot */}
            {IconComponent ? (
                <IconComponent
                    className="size-4 shrink-0"
                    style={{ color: project.color }}
                    aria-hidden="true"
                />
            ) : (
                <span
                    className="size-3 shrink-0 rounded-full"
                    style={{ backgroundColor: project.color }}
                    aria-hidden="true"
                />
            )}

            {/* Project Name */}
            <span className="flex-1 truncate text-left text-text-secondary">
                {project.name}
            </span>

            {/* Settings Icon (visible on hover) */}
            <button
                type="button"
                onClick={handleEditClick}
                onKeyDown={handleEditKeyDown}
                tabIndex={0}
                aria-label={`Edit ${project.name}`}
                className={cn(
                    "shrink-0 rounded p-0.5 text-text-tertiary opacity-0 transition-opacity",
                    "hover:bg-accent hover:text-text-secondary",
                    "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "group-hover:opacity-100"
                )}
            >
                <Settings className="size-3.5" />
            </button>

            {/* Task Count */}
            <span className="shrink-0 text-xs text-text-tertiary">{project.taskCount}</span>
        </div>
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
                    <TasksProjectNavItem
                        key={project.id}
                        project={project}
                        isSelected={selectedType === "project" && selectedId === project.id}
                        onSelect={onSelect}
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

    // Modal states
    const [isProjectModalOpen, setIsProjectModalOpen] = useState(false)
    const [editingProject, setEditingProject] = useState<Project | null>(null)
    const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
    const [projectToDelete, setProjectToDelete] = useState<Project | null>(null)
    const [isAddTaskModalOpen, setIsAddTaskModalOpen] = useState(false)
    const [addTaskPrefillTitle, setAddTaskPrefillTitle] = useState("")

    // Task Detail Panel states
    const [isDetailPanelOpen, setIsDetailPanelOpen] = useState(false)
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

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

    // Derived: filtered tasks for current selection
    const filteredTasks = useMemo(() => {
        return getFilteredTasks(tasks, selectedId, selectedType, projectsWithCounts)
    }, [tasks, selectedId, selectedType, projectsWithCounts])

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
        return formatTaskSubtitle(taskCounts, selectedId, selectedType)
    }, [taskCounts, selectedId, selectedType])

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

    const handleAddTask = (): void => {
        // Open the add task modal
        setAddTaskPrefillTitle("")
        setIsAddTaskModalOpen(true)
    }

    const handleOpenAddTaskModal = useCallback((prefillTitle: string): void => {
        setAddTaskPrefillTitle(prefillTitle)
        setIsAddTaskModalOpen(true)
    }, [])

    const handleAddTaskModalClose = (): void => {
        setIsAddTaskModalOpen(false)
        setAddTaskPrefillTitle("")
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

            // Find the project and get default status
            const project = projectsWithCounts.find((p) => p.id === projectId)
            const defaultStatus = project ? getDefaultTodoStatus(project) : null
            const statusId = defaultStatus?.id || project?.statuses[0]?.id || "p-todo"

            const newTask = createDefaultTask(projectId, statusId, title, dueDate)
            // Apply priority from parsed data
            newTask.priority = priority

            setTasks((prev) => [...prev, newTask])
        },
        [selectedId, selectedType, selectedProject, projectsWithCounts]
    )

    const handleToggleComplete = useCallback(
        (taskId: string): void => {
            setTasks((prev) =>
                prev.map((task) => {
                    if (task.id !== taskId) return task

                    // Find the project and its statuses
                    const project = projectsWithCounts.find((p) => p.id === task.projectId)
                    if (!project) return task

                    const currentStatus = project.statuses.find((s) => s.id === task.statusId)
                    if (!currentStatus) return task

                    // Toggle between todo and done
                    if (currentStatus.type === "done") {
                        // Move back to first todo status
                        const todoStatus = getDefaultTodoStatus(project)
                        return {
                            ...task,
                            statusId: todoStatus?.id || task.statusId,
                            completedAt: null,
                        }
                    } else {
                        // Move to first done status
                        const doneStatus = getDefaultDoneStatus(project)
                        return {
                            ...task,
                            statusId: doneStatus?.id || task.statusId,
                            completedAt: new Date(),
                        }
                    }
                })
            )
        },
        [projectsWithCounts]
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

    return (
        <>
            <div className={cn("flex h-full", className)}>
                {/* Left Column - Navigation */}
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

                    {/* Content Body - Task List */}
                    {activeView === "list" && (
                        <TaskList
                            tasks={filteredTasks}
                            projects={projectsWithCounts}
                            selectedId={selectedId}
                            selectedType={selectedType}
                            selectedTaskId={selectedTaskId}
                            onToggleComplete={handleToggleComplete}
                            onTaskClick={handleTaskClick}
                            onQuickAdd={handleQuickAdd}
                            onOpenModal={handleOpenAddTaskModal}
                        />
                    )}

                    {/* Placeholder for Kanban and Calendar views */}
                    {activeView !== "list" && (
                        <div className="flex flex-1 items-center justify-center p-6">
                            <div className="text-center">
                                <p className="text-lg text-text-secondary">
                                    {activeView === "kanban" ? "Kanban" : "Calendar"} view
                                </p>
                                <p className="mt-2 text-sm text-text-tertiary">(coming soon)</p>
                            </div>
                        </div>
                    )}
                </main>
            </div>

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
                defaultProjectId={modalDefaultProjectId}
                defaultDueDate={modalDefaultDueDate}
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
            />
        </>
    )
}
