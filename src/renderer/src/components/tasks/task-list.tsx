import { useMemo } from "react"

import { ScrollArea } from "@/components/ui/scroll-area"
import { TaskGroup, StatusTaskGroup } from "@/components/tasks/task-group"
import { QuickAddInput } from "@/components/tasks/quick-add-input"
import { TaskEmptyState } from "@/components/tasks/task-empty-state"
import { cn } from "@/lib/utils"
import {
    groupTasksByDueDate,
    groupTasksByStatus,
    groupTasksByCompletion,
    dueDateGroupConfig,
    completionGroupConfig,
    type TaskGroupByDate,
    type TaskGroupByCompletion,
} from "@/lib/task-utils"
import type { Task } from "@/data/sample-tasks"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface TaskListProps {
    tasks: Task[]
    projects: Project[]
    selectedId: string
    selectedType: "view" | "project"
    selectedTaskId?: string | null
    onToggleComplete: (taskId: string) => void
    onTaskClick?: (taskId: string) => void
    onQuickAdd: (
        title: string,
        parsedData?: {
            dueDate: Date | null
            priority: import("@/data/sample-tasks").Priority
            projectId: string | null
        }
    ) => void
    onOpenModal?: (prefillTitle: string) => void
    className?: string
}

// ============================================================================
// TASK LIST BY DUE DATE
// ============================================================================

interface TaskListByDueDateProps {
    tasks: Task[]
    projects: Project[]
    showProjectBadge: boolean
    selectedTaskId?: string | null
    onToggleComplete: (taskId: string) => void
    onTaskClick?: (taskId: string) => void
}

const TaskListByDueDate = ({
    tasks,
    projects,
    showProjectBadge,
    selectedTaskId,
    onToggleComplete,
    onTaskClick,
}: TaskListByDueDateProps): React.JSX.Element => {
    const groupedTasks = useMemo(() => groupTasksByDueDate(tasks), [tasks])

    const groupOrder: (keyof TaskGroupByDate)[] = [
        "overdue",
        "today",
        "tomorrow",
        "upcoming",
        "later",
        "noDueDate",
    ]

    return (
        <>
            {groupOrder.map((groupKey) => {
                const config = dueDateGroupConfig[groupKey]
                const tasksInGroup = groupedTasks[groupKey]

                return (
                    <TaskGroup
                        key={groupKey}
                        label={config.label}
                        tasks={tasksInGroup}
                        projects={projects}
                        accentColor={config.accentColor}
                        isMuted={config.isMuted}
                        showProjectBadge={showProjectBadge}
                        selectedTaskId={selectedTaskId}
                        onToggleComplete={onToggleComplete}
                        onTaskClick={onTaskClick}
                    />
                )
            })}
        </>
    )
}

// ============================================================================
// TASK LIST BY COMPLETION DATE
// ============================================================================

interface TaskListByCompletionProps {
    tasks: Task[]
    projects: Project[]
    selectedTaskId?: string | null
    onToggleComplete: (taskId: string) => void
    onTaskClick?: (taskId: string) => void
}

const TaskListByCompletion = ({
    tasks,
    projects,
    selectedTaskId,
    onToggleComplete,
    onTaskClick,
}: TaskListByCompletionProps): React.JSX.Element => {
    const groupedTasks = useMemo(() => groupTasksByCompletion(tasks), [tasks])

    const groupOrder: (keyof TaskGroupByCompletion)[] = ["today", "yesterday", "earlier"]

    return (
        <>
            {groupOrder.map((groupKey) => {
                const config = completionGroupConfig[groupKey]
                const tasksInGroup = groupedTasks[groupKey]

                return (
                    <TaskGroup
                        key={groupKey}
                        label={config.label}
                        tasks={tasksInGroup}
                        projects={projects}
                        accentColor={config.accentColor}
                        isMuted={config.isMuted}
                        showProjectBadge={true}
                        selectedTaskId={selectedTaskId}
                        onToggleComplete={onToggleComplete}
                        onTaskClick={onTaskClick}
                    />
                )
            })}
        </>
    )
}

// ============================================================================
// TASK LIST BY STATUS (PROJECT VIEW)
// ============================================================================

interface TaskListByStatusProps {
    tasks: Task[]
    project: Project
    selectedTaskId?: string | null
    onToggleComplete: (taskId: string) => void
    onTaskClick?: (taskId: string) => void
}

const TaskListByStatus = ({
    tasks,
    project,
    selectedTaskId,
    onToggleComplete,
    onTaskClick,
}: TaskListByStatusProps): React.JSX.Element => {
    const groupedTasks = useMemo(
        () => groupTasksByStatus(tasks, project.statuses),
        [tasks, project.statuses]
    )

    return (
        <>
            {groupedTasks.map((group) => (
                <StatusTaskGroup
                    key={group.status.id}
                    status={group.status}
                    tasks={group.tasks}
                    project={project}
                    selectedTaskId={selectedTaskId}
                    onToggleComplete={onToggleComplete}
                    onTaskClick={onTaskClick}
                />
            ))}
        </>
    )
}

// ============================================================================
// MAIN TASK LIST COMPONENT
// ============================================================================

export const TaskList = ({
    tasks,
    projects,
    selectedId,
    selectedType,
    selectedTaskId,
    onToggleComplete,
    onTaskClick,
    onQuickAdd,
    onOpenModal,
    className,
}: TaskListProps): React.JSX.Element => {
    // Determine if we should show the quick add input
    // Hide for "completed" view since you can't add completed tasks
    const showQuickAdd = selectedId !== "completed"

    // Determine empty state variant
    const getEmptyStateVariant = (): "all" | "today" | "upcoming" | "completed" | "project" => {
        if (selectedType === "project") return "project"
        if (selectedId === "all") return "all"
        if (selectedId === "today") return "today"
        if (selectedId === "upcoming") return "upcoming"
        if (selectedId === "completed") return "completed"
        return "all"
    }

    // Get selected project for project view
    const selectedProject = selectedType === "project"
        ? projects.find((p) => p.id === selectedId)
        : null

    // Check if empty
    const isEmpty = tasks.length === 0

    // Render content based on selection
    const renderContent = (): React.JSX.Element => {
        if (isEmpty) {
            return (
                <TaskEmptyState
                    variant={getEmptyStateVariant()}
                    projectName={selectedProject?.name}
                    onAddTask={() => onQuickAdd("New Task")}
                />
            )
        }

        // Project view - group by status
        if (selectedType === "project" && selectedProject) {
            return (
                <TaskListByStatus
                    tasks={tasks}
                    project={selectedProject}
                    selectedTaskId={selectedTaskId}
                    onToggleComplete={onToggleComplete}
                    onTaskClick={onTaskClick}
                />
            )
        }

        // Completed view - group by completion date
        if (selectedId === "completed") {
            return (
                <TaskListByCompletion
                    tasks={tasks}
                    projects={projects}
                    selectedTaskId={selectedTaskId}
                    onToggleComplete={onToggleComplete}
                    onTaskClick={onTaskClick}
                />
            )
        }

        // Views (All, Today, Upcoming) - group by due date
        return (
            <TaskListByDueDate
                tasks={tasks}
                projects={projects}
                showProjectBadge={true}
                selectedTaskId={selectedTaskId}
                onToggleComplete={onToggleComplete}
                onTaskClick={onTaskClick}
            />
        )
    }

    return (
        <ScrollArea className={cn("flex-1", className)}>
            <div className="p-4">
                {/* Quick Add Input */}
                {showQuickAdd && (
                    <div className="mb-4">
                        <QuickAddInput
                            onAdd={onQuickAdd}
                            onOpenModal={onOpenModal}
                            projects={projects}
                            placeholder="Add task... (use !today !!high #project for quick options)"
                        />
                    </div>
                )}

                {/* Task Groups */}
                {renderContent()}
            </div>
        </ScrollArea>
    )
}

export default TaskList

