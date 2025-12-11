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
import { getTopLevelTasks } from "@/lib/subtask-utils"
import { useExpandedTasks } from "@/hooks"
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
    onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
    onToggleSubtaskComplete?: (subtaskId: string) => void
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
    // Selection props
    isSelectionMode?: boolean
    selectedIds?: Set<string>
    onToggleSelect?: (taskId: string) => void
    onShiftSelect?: (taskId: string) => void
    // Subtask management props
    onAddSubtask?: (parentId: string, title: string) => void
    onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

// ============================================================================
// TASK LIST BY DUE DATE
// ============================================================================

interface TaskListByDueDateProps {
    tasks: Task[]
    allTasks: Task[] // All tasks for subtask lookup
    projects: Project[]
    showProjectBadge: boolean
    selectedTaskId?: string | null
    onToggleComplete: (taskId: string) => void
    onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
    onToggleSubtaskComplete?: (subtaskId: string) => void
    onTaskClick?: (taskId: string) => void
    // Selection props
    isSelectionMode?: boolean
    selectedIds?: Set<string>
    onToggleSelect?: (taskId: string) => void
    onShiftSelect?: (taskId: string) => void
    // Expand/collapse props
    expandedIds: Set<string>
    onToggleExpand: (taskId: string) => void
    // Subtask management props
    onAddSubtask?: (parentId: string, title: string) => void
    onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

const TaskListByDueDate = ({
    tasks,
    allTasks,
    projects,
    showProjectBadge,
    selectedTaskId,
    onToggleComplete,
    onUpdateTask,
    onToggleSubtaskComplete,
    onTaskClick,
    // Selection props
    isSelectionMode = false,
    selectedIds,
    onToggleSelect,
    onShiftSelect,
    // Expand/collapse props
    expandedIds,
    onToggleExpand,
    // Subtask management props
    onAddSubtask,
    onReorderSubtasks,
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
                        allTasks={allTasks}
                        projects={projects}
                        urgency={config.urgency}
                        accentColor={config.accentColor}
                        isMuted={config.isMuted}
                        showProjectBadge={showProjectBadge}
                        selectedTaskId={selectedTaskId}
                        onToggleComplete={onToggleComplete}
                        onUpdateTask={onUpdateTask}
                        onToggleSubtaskComplete={onToggleSubtaskComplete}
                        onTaskClick={onTaskClick}
                        // Selection props
                        isSelectionMode={isSelectionMode}
                        selectedIds={selectedIds}
                        onToggleSelect={onToggleSelect}
                        onShiftSelect={onShiftSelect}
                        // Expand/collapse props
                        expandedIds={expandedIds}
                        onToggleExpand={onToggleExpand}
                        // Subtask management props
                        onAddSubtask={onAddSubtask}
                        onReorderSubtasks={onReorderSubtasks}
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
    allTasks: Task[] // All tasks for subtask lookup
    projects: Project[]
    selectedTaskId?: string | null
    onToggleComplete: (taskId: string) => void
    onToggleSubtaskComplete?: (subtaskId: string) => void
    onTaskClick?: (taskId: string) => void
    // Selection props
    isSelectionMode?: boolean
    selectedIds?: Set<string>
    onToggleSelect?: (taskId: string) => void
    onShiftSelect?: (taskId: string) => void
    // Expand/collapse props
    expandedIds: Set<string>
    onToggleExpand: (taskId: string) => void
    // Subtask management props
    onAddSubtask?: (parentId: string, title: string) => void
    onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

const TaskListByCompletion = ({
    tasks,
    allTasks,
    projects,
    selectedTaskId,
    onToggleComplete,
    onToggleSubtaskComplete,
    onTaskClick,
    // Selection props
    isSelectionMode = false,
    selectedIds,
    onToggleSelect,
    onShiftSelect,
    // Expand/collapse props
    expandedIds,
    onToggleExpand,
    // Subtask management props
    onAddSubtask,
    onReorderSubtasks,
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
                        allTasks={allTasks}
                        projects={projects}
                        accentColor={config.accentColor}
                        isMuted={config.isMuted}
                        showProjectBadge={true}
                        selectedTaskId={selectedTaskId}
                        onToggleComplete={onToggleComplete}
                        onToggleSubtaskComplete={onToggleSubtaskComplete}
                        onTaskClick={onTaskClick}
                        // Selection props
                        isSelectionMode={isSelectionMode}
                        selectedIds={selectedIds}
                        onToggleSelect={onToggleSelect}
                        onShiftSelect={onShiftSelect}
                        // Expand/collapse props
                        expandedIds={expandedIds}
                        onToggleExpand={onToggleExpand}
                        // Subtask management props
                        onAddSubtask={onAddSubtask}
                        onReorderSubtasks={onReorderSubtasks}
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
    allTasks: Task[] // All tasks for subtask lookup
    project: Project
    selectedTaskId?: string | null
    onToggleComplete: (taskId: string) => void
    onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
    onToggleSubtaskComplete?: (subtaskId: string) => void
    onTaskClick?: (taskId: string) => void
    // Selection props
    isSelectionMode?: boolean
    selectedIds?: Set<string>
    onToggleSelect?: (taskId: string) => void
    onShiftSelect?: (taskId: string) => void
    // Expand/collapse props
    expandedIds: Set<string>
    onToggleExpand: (taskId: string) => void
    // Subtask management props
    onAddSubtask?: (parentId: string, title: string) => void
    onReorderSubtasks?: (parentId: string, newOrder: string[]) => void
}

const TaskListByStatus = ({
    tasks,
    allTasks,
    project,
    selectedTaskId,
    onToggleComplete,
    onUpdateTask,
    onToggleSubtaskComplete,
    onTaskClick,
    // Selection props
    isSelectionMode = false,
    selectedIds,
    onToggleSelect,
    onShiftSelect,
    // Expand/collapse props
    expandedIds,
    onToggleExpand,
    // Subtask management props
    onAddSubtask,
    onReorderSubtasks,
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
                    allTasks={allTasks}
                    project={project}
                    selectedTaskId={selectedTaskId}
                    onToggleComplete={onToggleComplete}
                    onUpdateTask={onUpdateTask}
                    onToggleSubtaskComplete={onToggleSubtaskComplete}
                    onTaskClick={onTaskClick}
                    // Selection props
                    isSelectionMode={isSelectionMode}
                    selectedIds={selectedIds}
                    onToggleSelect={onToggleSelect}
                    onShiftSelect={onShiftSelect}
                    // Expand/collapse props
                    expandedIds={expandedIds}
                    onToggleExpand={onToggleExpand}
                    // Subtask management props
                    onAddSubtask={onAddSubtask}
                    onReorderSubtasks={onReorderSubtasks}
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
    onUpdateTask,
    onToggleSubtaskComplete,
    onTaskClick,
    onQuickAdd,
    onOpenModal,
    className,
    // Selection props
    isSelectionMode = false,
    selectedIds,
    onToggleSelect,
    onShiftSelect,
    // Subtask management props
    onAddSubtask,
    onReorderSubtasks,
}: TaskListProps): React.JSX.Element => {
    // Expand/collapse state with persistence per view
    const storageKey = selectedType === "project" ? `project-${selectedId}` : selectedId
    const { expandedIds, toggleExpanded } = useExpandedTasks({
        storageKey,
        persist: true,
    })

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

    // Check if empty (only count top-level tasks)
    const topLevelTasks = useMemo(() => getTopLevelTasks(tasks), [tasks])
    const isEmpty = topLevelTasks.length === 0

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
                    allTasks={tasks}
                    project={selectedProject}
                    selectedTaskId={selectedTaskId}
                    onToggleComplete={onToggleComplete}
                    onUpdateTask={onUpdateTask}
                    onToggleSubtaskComplete={onToggleSubtaskComplete}
                    onTaskClick={onTaskClick}
                    // Selection props
                    isSelectionMode={isSelectionMode}
                    selectedIds={selectedIds}
                    onToggleSelect={onToggleSelect}
                    onShiftSelect={onShiftSelect}
                    // Expand/collapse props
                    expandedIds={expandedIds}
                    onToggleExpand={toggleExpanded}
                    // Subtask management props
                    onAddSubtask={onAddSubtask}
                    onReorderSubtasks={onReorderSubtasks}
                />
            )
        }

        // Completed view - group by completion date
        if (selectedId === "completed") {
            return (
                <TaskListByCompletion
                    tasks={tasks}
                    allTasks={tasks}
                    projects={projects}
                    selectedTaskId={selectedTaskId}
                    onToggleComplete={onToggleComplete}
                    onToggleSubtaskComplete={onToggleSubtaskComplete}
                    onTaskClick={onTaskClick}
                    // Selection props
                    isSelectionMode={isSelectionMode}
                    selectedIds={selectedIds}
                    onToggleSelect={onToggleSelect}
                    onShiftSelect={onShiftSelect}
                    // Expand/collapse props
                    expandedIds={expandedIds}
                    onToggleExpand={toggleExpanded}
                    // Subtask management props
                    onAddSubtask={onAddSubtask}
                    onReorderSubtasks={onReorderSubtasks}
                />
            )
        }

        // Views (All, Today, Upcoming) - group by due date
        return (
            <TaskListByDueDate
                tasks={tasks}
                allTasks={tasks}
                projects={projects}
                showProjectBadge={true}
                selectedTaskId={selectedTaskId}
                onToggleComplete={onToggleComplete}
                onUpdateTask={onUpdateTask}
                onToggleSubtaskComplete={onToggleSubtaskComplete}
                onTaskClick={onTaskClick}
                // Selection props
                isSelectionMode={isSelectionMode}
                selectedIds={selectedIds}
                onToggleSelect={onToggleSelect}
                onShiftSelect={onShiftSelect}
                // Expand/collapse props
                expandedIds={expandedIds}
                onToggleExpand={toggleExpanded}
                // Subtask management props
                onAddSubtask={onAddSubtask}
                onReorderSubtasks={onReorderSubtasks}
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
                            placeholder="Add task..."
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
