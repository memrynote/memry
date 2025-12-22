import { useMemo, useCallback, useEffect } from "react"
import { useDroppable } from "@dnd-kit/core"
import { Plus, FolderKanban, MoreHorizontal, Pencil, Archive, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TaskList } from "@/components/tasks/task-list"
import { cn } from "@/lib/utils"
import { getFilteredTasks } from "@/lib/task-utils"
import { useDragContext } from "@/contexts/drag-context"
import type { Project } from "@/data/tasks-data"
import type { Task, Priority } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface ProjectsTabContentProps {
    tasks: Task[]
    /** Pre-filtered tasks for the selected project (right panel) */
    filteredProjectTasks?: Task[]
    projects: Project[]
    selectedTaskId: string | null
    selectedProjectId: string | null
    onProjectSelect: (projectId: string) => void
    onToggleComplete: (taskId: string) => void
    onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
    onToggleSubtaskComplete: (taskId: string) => void
    onTaskClick: (taskId: string) => void
    onQuickAdd: (
        title: string,
        parsedData?: {
            dueDate: Date | null
            priority: Priority
            projectId: string | null
            statusId?: string | null
        }
    ) => void
    onOpenModal: (prefillTitle: string) => void
    onProjectEdit?: (project: Project) => void
    onProjectArchive?: (project: Project) => void
    onProjectDelete?: (projectId: string) => void
    onCreateProject?: () => void
    isSelectionMode?: boolean
    selectedIds?: Set<string>
    onToggleSelect?: (taskId: string) => void
    onShiftSelect?: (taskId: string) => void
    onReorderSubtasks?: (parentId: string, subtaskIds: string[]) => void
    onAddSubtask?: (parentId: string, title: string) => void
    className?: string
}

interface ProjectListItemProps {
    project: Project
    isActive: boolean
    taskCount: number
    onClick: () => void
    onEdit?: () => void
    onArchive?: () => void
    onDelete?: () => void
}

// ============================================================================
// PROJECT LIST ITEM COMPONENT
// ============================================================================

const ProjectListItem = ({
    project,
    isActive,
    taskCount,
    onClick,
    onEdit,
    onArchive,
    onDelete,
}: ProjectListItemProps): React.JSX.Element => {
    const { dragState } = useDragContext()

    const { setNodeRef, isOver } = useDroppable({
        id: `projects-tab-project-${project.id}`,
        data: {
            type: "project",
            projectId: project.id,
            project,
        },
    })

    const showAsDropZone = dragState.isDragging

    const handleKeyDown = (e: React.KeyboardEvent): void => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onClick()
        }
    }

    return (
        <div
            role="button"
            tabIndex={0}
            ref={setNodeRef}
            onClick={onClick}
            onKeyDown={handleKeyDown}
            className={cn(
                "group relative flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors cursor-pointer",
                "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isActive && "bg-accent",
                // Drop zone visual feedback
                showAsDropZone && "border border-dotted border-muted-foreground/40",
                isOver && "bg-primary/10 ring-2 ring-primary rounded-md shadow-sm"
            )}
        >
            {/* Drop indicator when hovering */}
            {isOver && showAsDropZone && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-primary font-medium">
                    Drop here
                </span>
            )}
            <div className="flex items-center gap-3 min-w-0">
                {/* Color indicator */}
                <div
                    className="size-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: project.color }}
                />
                {/* Project name */}
                <span className="truncate font-medium">{project.name}</span>
            </div>
            <div className="flex items-center gap-1">
                {/* Task count badge */}
                {!isOver && taskCount > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                        {taskCount}
                    </span>
                )}
                {/* More actions dropdown */}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <MoreHorizontal className="size-3.5" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={onEdit}>
                            <Pencil className="mr-2 size-4" />
                            Edit project
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={onArchive}>
                            <Archive className="mr-2 size-4" />
                            Archive project
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={onDelete}
                            className="text-destructive focus:text-destructive"
                        >
                            <Trash2 className="mr-2 size-4" />
                            Delete project
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    )
}

// ============================================================================
// PROJECTS TAB CONTENT COMPONENT
// ============================================================================

export const ProjectsTabContent = ({
    tasks,
    filteredProjectTasks,
    projects,
    selectedTaskId,
    selectedProjectId,
    onProjectSelect,
    onToggleComplete,
    onUpdateTask,
    onToggleSubtaskComplete,
    onTaskClick,
    onQuickAdd,
    onOpenModal,
    onProjectEdit,
    onProjectArchive,
    onProjectDelete,
    onCreateProject,
    isSelectionMode = false,
    selectedIds = new Set(),
    onToggleSelect,
    onShiftSelect,
    onReorderSubtasks,
    onAddSubtask,
    className,
}: ProjectsTabContentProps): React.JSX.Element => {
    // Filter to active (non-archived) projects
    const activeProjects = useMemo(() => {
        return projects.filter((p) => !p.isArchived)
    }, [projects])

    // Auto-select first project if none selected
    const effectiveSelectedProjectId = useMemo(() => {
        if (selectedProjectId && activeProjects.some((p) => p.id === selectedProjectId)) {
            return selectedProjectId
        }
        return activeProjects[0]?.id || null
    }, [selectedProjectId, activeProjects])

    // Sync auto-selected project back to parent (for Kanban/Calendar view switching)
    useEffect(() => {
        if (effectiveSelectedProjectId && effectiveSelectedProjectId !== selectedProjectId) {
            onProjectSelect(effectiveSelectedProjectId)
        }
    }, [effectiveSelectedProjectId, selectedProjectId, onProjectSelect])

    // Get the selected project
    const selectedProject = useMemo(() => {
        return activeProjects.find((p) => p.id === effectiveSelectedProjectId) || null
    }, [activeProjects, effectiveSelectedProjectId])

    // Get tasks for selected project
    const projectTasks = useMemo(() => {
        if (!effectiveSelectedProjectId) return []
        return getFilteredTasks(tasks, effectiveSelectedProjectId, "project", projects)
    }, [tasks, effectiveSelectedProjectId, projects])

    const visibleProjectTasks = useMemo(() => {
        return filteredProjectTasks ?? projectTasks
    }, [filteredProjectTasks, projectTasks])

    // Get task counts per project
    const projectTaskCounts = useMemo(() => {
        const counts: Record<string, number> = {}
        activeProjects.forEach((project) => {
            const projectTaskList = tasks.filter(
                (t) => t.projectId === project.id && !t.parentId
            )
            // Count incomplete tasks only
            const incompleteCount = projectTaskList.filter((t) => {
                const proj = projects.find((p) => p.id === t.projectId)
                if (!proj) return true
                const status = proj.statuses.find((s) => s.id === t.statusId)
                return status?.type !== "done"
            }).length
            counts[project.id] = incompleteCount
        })
        return counts
    }, [activeProjects, tasks, projects])

    // Handle project quick add with project context
    const handleQuickAdd = useCallback(
        (
            title: string,
            parsedData?: {
                dueDate: Date | null
                priority: Priority
                projectId: string | null
                statusId?: string | null
            }
        ) => {
            onQuickAdd(title, {
                ...parsedData,
                dueDate: parsedData?.dueDate || null,
                priority: parsedData?.priority || "none",
                projectId: effectiveSelectedProjectId,
            })
        },
        [onQuickAdd, effectiveSelectedProjectId]
    )

    return (
        <div className={cn("flex h-full", className)}>
            {/* Left panel - Project list */}
            <div className="w-64 shrink-0 border-r border-border flex flex-col overflow-hidden">
                <div className="p-3 border-b border-border flex items-center justify-between">
                    <h3 className="font-medium text-sm text-foreground">Projects</h3>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={onCreateProject}
                    >
                        <Plus className="size-4" />
                    </Button>
                </div>
                <ScrollArea className="flex-1">
                    <div className="p-2 space-y-0.5">
                        {activeProjects.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                                <FolderKanban className="size-10 text-muted-foreground/50 mb-3" />
                                <p className="text-sm text-muted-foreground mb-3">
                                    No projects yet
                                </p>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onCreateProject}
                                >
                                    <Plus className="size-4 mr-1" />
                                    Create project
                                </Button>
                            </div>
                        ) : (
                            activeProjects.map((project) => (
                                <ProjectListItem
                                    key={project.id}
                                    project={project}
                                    isActive={effectiveSelectedProjectId === project.id}
                                    taskCount={projectTaskCounts[project.id] || 0}
                                    onClick={() => onProjectSelect(project.id)}
                                    onEdit={() => onProjectEdit?.(project)}
                                    onArchive={() => onProjectArchive?.(project)}
                                    onDelete={() => onProjectDelete?.(project.id)}
                                />
                            ))
                        )}
                    </div>
                </ScrollArea>
            </div>

            {/* Right panel - Project tasks */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {selectedProject ? (
                    <TaskList
                        tasks={visibleProjectTasks}
                        projects={projects}
                        selectedId={effectiveSelectedProjectId || ""}
                        selectedType="project"
                        selectedTaskId={selectedTaskId}
                        onToggleComplete={onToggleComplete}
                        onUpdateTask={onUpdateTask}
                        onToggleSubtaskComplete={onToggleSubtaskComplete}
                        onTaskClick={onTaskClick}
                        onQuickAdd={handleQuickAdd}
                        onOpenModal={onOpenModal}
                        isSelectionMode={isSelectionMode}
                        selectedIds={selectedIds}
                        onToggleSelect={onToggleSelect}
                        onShiftSelect={onShiftSelect}
                        onReorderSubtasks={onReorderSubtasks}
                        onAddSubtask={onAddSubtask}
                    />
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center p-8">
                        <FolderKanban className="size-12 text-muted-foreground/50 mb-4" />
                        <p className="text-lg font-medium text-foreground mb-2">
                            No project selected
                        </p>
                        <p className="text-sm text-muted-foreground mb-4">
                            Select a project from the list or create a new one
                        </p>
                        {activeProjects.length === 0 && (
                            <Button onClick={onCreateProject}>
                                <Plus className="size-4 mr-2" />
                                Create your first project
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
