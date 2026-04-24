import { useMemo } from 'react'
import { Plus, Pencil, Archive, Trash2, MoreHorizontal, FolderKanban } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Picker, usePickerContext } from '@/components/ui/picker'
import { cn } from '@/lib/utils'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/sample-tasks'

interface ProjectSelectorProps {
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
          <Pencil className="mr-2 size-4" />
          Edit project
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            onArchive?.(project)
            onOpenChange(false)
          }}
        >
          <Archive className="mr-2 size-4" />
          Archive project
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            onDelete?.(project.id)
            onOpenChange(false)
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 size-4" />
          Delete project
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
  onCreateProject,
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
      const projectTaskList = tasks.filter((t) => t.projectId === project.id && !t.parentId)
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
      <Picker value={selectedProjectId} onValueChange={onProjectSelect}>
        <Picker.Trigger variant="button" chevron className="min-w-[180px] max-w-[280px]">
          {selectedProject ? (
            <span className="flex items-center gap-2 min-w-0">
              <span
                className="size-2.5 rounded-full shrink-0"
                style={{ backgroundColor: selectedProject.color }}
              />
              <span className="truncate text-sm font-medium">{selectedProject.name}</span>
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">Select project</span>
          )}
        </Picker.Trigger>
        <Picker.Content width={280} align="start">
          {activeProjects.length === 0 ? (
            <Picker.Empty
              icon={<FolderKanban className="size-8" />}
              message="No projects yet"
              action={
                <Button variant="outline" size="sm" onClick={onCreateProject}>
                  <Plus className="size-4 mr-1" />
                  Create project
                </Button>
              }
            />
          ) : (
            <Picker.List>
              {activeProjects.map((project) => (
                <Picker.Item
                  key={project.id}
                  value={project.id}
                  label={project.name}
                  icon={
                    <span
                      className="size-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                  }
                  trailing={
                    <div className="flex items-center gap-1">
                      {projectTaskCounts[project.id] > 0 && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {projectTaskCounts[project.id]}
                        </span>
                      )}
                      <ProjectActions
                        project={project}
                        onEdit={onProjectEdit}
                        onArchive={onProjectArchive}
                        onDelete={onProjectDelete}
                      />
                    </div>
                  }
                  className="group"
                />
              ))}
            </Picker.List>
          )}
        </Picker.Content>
      </Picker>

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

      <Button variant="ghost" size="icon" className="size-8" onClick={onCreateProject}>
        <Plus className="size-4" />
      </Button>
    </div>
  )
}
