import { useMemo, useCallback, useEffect } from 'react'
import { Plus, FolderKanban } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { TaskList } from '@/components/tasks/task-list'
import { ProjectSelector } from '@/components/tasks/projects/project-selector'
import { cn } from '@/lib/utils'
import { getFilteredTasks } from '@/lib/task-utils'
import type { Project } from '@/data/tasks-data'
import type { Task, Priority } from '@/data/sample-tasks'

interface ProjectsTabContentProps {
  tasks: Task[]
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
  className
}: ProjectsTabContentProps): React.JSX.Element => {
  const activeProjects = useMemo(() => {
    return projects.filter((p) => !p.isArchived)
  }, [projects])

  const effectiveSelectedProjectId = useMemo(() => {
    if (selectedProjectId && activeProjects.some((p) => p.id === selectedProjectId)) {
      return selectedProjectId
    }
    return activeProjects[0]?.id || null
  }, [selectedProjectId, activeProjects])

  useEffect(() => {
    if (effectiveSelectedProjectId && effectiveSelectedProjectId !== selectedProjectId) {
      onProjectSelect(effectiveSelectedProjectId)
    }
  }, [effectiveSelectedProjectId, selectedProjectId, onProjectSelect])

  const selectedProject = useMemo(() => {
    return activeProjects.find((p) => p.id === effectiveSelectedProjectId) || null
  }, [activeProjects, effectiveSelectedProjectId])

  const projectTasks = useMemo(() => {
    if (!effectiveSelectedProjectId) return []
    return getFilteredTasks(tasks, effectiveSelectedProjectId, 'project', projects)
  }, [tasks, effectiveSelectedProjectId, projects])

  const visibleProjectTasks = useMemo(() => {
    return filteredProjectTasks ?? projectTasks
  }, [filteredProjectTasks, projectTasks])

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
        priority: parsedData?.priority || 'none',
        projectId: effectiveSelectedProjectId
      })
    },
    [onQuickAdd, effectiveSelectedProjectId]
  )

  return (
    <div className={cn('flex flex-1 flex-col overflow-hidden', className)}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <ProjectSelector
          tasks={tasks}
          projects={projects}
          selectedProjectId={effectiveSelectedProjectId}
          onProjectSelect={onProjectSelect}
          onProjectEdit={onProjectEdit}
          onProjectArchive={onProjectArchive}
          onProjectDelete={onProjectDelete}
          onCreateProject={onCreateProject}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedProject ? (
          <TaskList
            tasks={visibleProjectTasks}
            projects={projects}
            selectedId={effectiveSelectedProjectId || ''}
            selectedType="project"
            selectedTaskId={selectedTaskId}
            onToggleComplete={onToggleComplete}
            onUpdateTask={onUpdateTask}
            onToggleSubtaskComplete={onToggleSubtaskComplete}
            onTaskClick={onTaskClick}
            onQuickAdd={handleQuickAdd}
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
            <p className="text-lg font-medium text-foreground mb-2">No project selected</p>
            <p className="text-sm text-muted-foreground mb-4">
              Select a project from the dropdown or create a new one
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
