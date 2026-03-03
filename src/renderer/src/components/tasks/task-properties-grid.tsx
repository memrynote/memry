import { useMemo } from 'react'

import { ProjectSelect } from './project-select'
import { StatusSelect } from './status-select'
import { DueDatePicker } from './due-date-picker'
import { PrioritySelect } from './priority-select'
import { cn } from '@/lib/utils'
import { getDefaultTodoStatus } from '@/lib/task-utils'
import type { Task, Priority } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface TaskPropertiesGridProps {
  task: Task
  projects: Project[]
  onUpdateProject: (projectId: string) => void
  onUpdateStatus: (statusId: string) => void
  onUpdateDueDate: (dueDate: Date | null) => void
  onUpdateDueTime: (dueTime: string | null) => void
  onUpdatePriority: (priority: Priority) => void
  isCompleted: boolean
  className?: string
}

// ============================================================================
// PROPERTY FIELD COMPONENT
// ============================================================================

interface PropertyFieldProps {
  label: string
  children: React.ReactNode
}

const PropertyField = ({ label, children }: PropertyFieldProps): React.JSX.Element => {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

// ============================================================================
// TASK PROPERTIES GRID COMPONENT
// ============================================================================

export const TaskPropertiesGrid = ({
  task,
  projects,
  onUpdateProject,
  onUpdateStatus,
  onUpdateDueDate,
  onUpdateDueTime,
  onUpdatePriority,
  isCompleted,
  className
}: TaskPropertiesGridProps): React.JSX.Element => {
  // Get current project
  const currentProject = useMemo(() => {
    return projects.find((p) => p.id === task.projectId)
  }, [projects, task.projectId])

  // Get statuses for current project
  const currentStatuses = useMemo(() => {
    return currentProject?.statuses || []
  }, [currentProject])

  // Handle project change - also update status
  const handleProjectChange = (projectId: string): void => {
    const newProject = projects.find((p) => p.id === projectId)
    if (newProject) {
      // Map status to equivalent type in new project
      const currentStatus = currentStatuses.find((s) => s.id === task.statusId)
      const newStatus =
        newProject.statuses.find((s) => s.type === currentStatus?.type) ||
        getDefaultTodoStatus(newProject)

      onUpdateProject(projectId)
      if (newStatus && newStatus.id !== task.statusId) {
        onUpdateStatus(newStatus.id)
      }
    }
  }

  return (
    <div className={cn('grid grid-cols-2 gap-4', className)}>
      {/* Project */}
      <PropertyField label="Project">
        <ProjectSelect value={task.projectId} onChange={handleProjectChange} projects={projects} />
      </PropertyField>

      {/* Status */}
      <PropertyField label="Status">
        <StatusSelect value={task.statusId} onChange={onUpdateStatus} statuses={currentStatuses} />
      </PropertyField>

      {/* Due Date */}
      <PropertyField label="Due Date">
        <DueDatePicker
          date={task.dueDate}
          time={task.dueTime}
          onDateChange={(date) => {
            onUpdateDueDate(date)
          }}
          onTimeChange={(time) => {
            onUpdateDueTime(time)
          }}
        />
      </PropertyField>

      {/* Priority (hidden when completed) */}
      <PropertyField label="Priority">
        {!isCompleted ? (
          <PrioritySelect value={task.priority} onChange={onUpdatePriority} />
        ) : (
          <div className="flex h-9 items-center px-3 text-sm text-muted-foreground">—</div>
        )}
      </PropertyField>
    </div>
  )
}

export default TaskPropertiesGrid
