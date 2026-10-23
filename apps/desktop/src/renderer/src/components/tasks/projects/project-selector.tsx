import { useMemo } from 'react'
import { Pencil, Archive, Trash2, MoreHorizontal } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { usePickerContext } from '@/components/ui/picker'
import { ProjectPicker } from '@/components/tasks/project-picker'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'
import { useT } from '@memry/i18n/renderer'

interface ProjectSelectorProps {
  tasks: Task[]
  projects: Project[]
  selectedProjectId: string | null
  onProjectSelect: (projectId: string) => void
  onProjectEdit?: (project: Project) => void
  onProjectArchive?: (project: Project) => void
  onProjectDelete?: (projectId: string) => void
  className?: string
}

function ProjectActions({
  project,
  onEdit,
  onArchive,
  onDelete
}: {
  project: Project
  onEdit?: (project: Project) => void
  onArchive?: (project: Project) => void
  onDelete?: (projectId: string) => void
}): React.JSX.Element {
  const { t: tPhaseF } = useT('tasks')
  const { onOpenChange } = usePickerContext()

  return (
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
        <DropdownMenuItem
          onClick={() => {
            onEdit?.(project)
            onOpenChange(false)
          }}
        >
          <Pencil className="me-2 size-4" />

          {tPhaseF('phaseF.componentsTasksProjectsProjectSelector.editProject')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            onArchive?.(project)
            onOpenChange(false)
          }}
        >
          <Archive className="me-2 size-4" />

          {tPhaseF('phaseF.componentsTasksProjectsProjectSelector.archiveProject')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            onDelete?.(project.id)
            onOpenChange(false)
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="me-2 size-4" />

          {tPhaseF('phaseF.componentsTasksProjectsProjectSelector.deleteProject')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const ProjectSelector = ({
  tasks,
  projects,
  selectedProjectId,
  onProjectSelect,
  onProjectEdit,
  onProjectArchive,
  onProjectDelete,
  className
}: ProjectSelectorProps): React.JSX.Element => {
  const activeProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  const selectedProject = useMemo(
    () => activeProjects.find((p) => p.id === selectedProjectId) ?? null,
    [activeProjects, selectedProjectId]
  )

  const projectTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    activeProjects.forEach((project) => {
      const projectTaskList = tasks.filter(
        // Archived tasks are in no list, so they must not be in a badge either.
        (t) => t.projectId === project.id && !t.parentId && !t.archivedAt
      )
      const incompleteCount = projectTaskList.filter((t) => {
        const proj = projects.find((p) => p.id === t.projectId)
        if (!proj) return true
        const status = proj.statuses.find((s) => s.id === t.statusId)
        return status?.type !== 'done'
      }).length
      counts[project.id] = incompleteCount
    })
    return counts
  }, [activeProjects, tasks, projects])

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <ProjectPicker
        value={selectedProjectId}
        onChange={(id) => {
          if (id) onProjectSelect(id)
        }}
        projects={projects}
        showCounts
        taskCountByProject={projectTaskCounts}
        renderItemActions={(project) => (
          <ProjectActions
            project={project}
            onEdit={onProjectEdit}
            onArchive={onProjectArchive}
            onDelete={onProjectDelete}
          />
        )}
        contentWidth={280}
        className="min-w-[180px] max-w-[280px]"
      />

      {selectedProject && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => onProjectEdit?.(selectedProject)}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
