import { useMemo } from "react"
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
import { cn } from "@/lib/utils"
import { useDragContext } from "@/contexts/drag-context"
import type { Project } from "@/data/tasks-data"
import type { Task } from "@/data/sample-tasks"

// ============================================================================
// TYPES
// ============================================================================

interface ProjectSidebarProps {
    tasks: Task[]
    projects: Project[]
    selectedProjectId: string | null
    onProjectSelect: (projectId: string) => void
    onProjectEdit?: (project: Project) => void
    onProjectArchive?: (project: Project) => void
    onProjectDelete?: (projectId: string) => void
    onCreateProject?: () => void
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
        id: `project-sidebar-${project.id}`,
        data: {
            type: "project",
            projectId: project.id,
            project,
        },
    })

    const showAsDropZone = dragState.isDragging

    return (
        <button
            type="button"
            ref={setNodeRef}
            onClick={onClick}
            className={cn(
                "group relative flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                "hover:bg-accent",
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
        </button>
    )
}

// ============================================================================
// PROJECT SIDEBAR COMPONENT
// ============================================================================

export const ProjectSidebar = ({
    tasks,
    projects,
    selectedProjectId,
    onProjectSelect,
    onProjectEdit,
    onProjectArchive,
    onProjectDelete,
    onCreateProject,
    className,
}: ProjectSidebarProps): React.JSX.Element => {
    // Filter to active (non-archived) projects
    const activeProjects = useMemo(() => {
        return projects.filter((p) => !p.isArchived)
    }, [projects])

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

    return (
        <div className={cn("w-64 shrink-0 border-r border-border flex flex-col overflow-hidden", className)}>
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
                                isActive={selectedProjectId === project.id}
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
    )
}

export default ProjectSidebar
