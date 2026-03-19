import { useMemo, useState } from 'react'
import {
  ChevronDown,
  Plus,
  Pencil,
  Archive,
  Trash2,
  MoreHorizontal,
  FolderKanban
} from '@/lib/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
  const [open, setOpen] = useState(false)

  const activeProjects = useMemo(() => {
    return projects.filter((p) => !p.isArchived)
  }, [projects])

  const selectedProject = useMemo(() => {
    return activeProjects.find((p) => p.id === selectedProjectId) ?? null
  }, [activeProjects, selectedProjectId])

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

  const handleSelect = (projectId: string): void => {
    onProjectSelect(projectId)
    setOpen(false)
  }

  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="justify-between gap-2 px-3 py-2 h-9 min-w-[180px] max-w-[280px]"
          >
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
            <ChevronDown className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[280px] p-0">
          {activeProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
              <FolderKanban className="size-8 text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground mb-3">No projects yet</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onCreateProject?.()
                  setOpen(false)
                }}
              >
                <Plus className="size-4 mr-1" />
                Create project
              </Button>
            </div>
          ) : (
            <div className="py-1">
              {activeProjects.map((project) => (
                <div
                  key={project.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelect(project.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleSelect(project.id)
                    }
                  }}
                  className={cn(
                    'group flex w-full items-center justify-between gap-2 px-3 py-2 text-sm cursor-pointer transition-colors',
                    'hover:bg-accent focus-visible:outline-none focus-visible:bg-accent',
                    selectedProjectId === project.id && 'bg-accent'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className="size-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: project.color }}
                    />
                    <span className="truncate font-medium">{project.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {projectTaskCounts[project.id] > 0 && (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {projectTaskCounts[project.id]}
                      </span>
                    )}
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
                            onProjectEdit?.(project)
                            setOpen(false)
                          }}
                        >
                          <Pencil className="mr-2 size-4" />
                          Edit project
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => {
                            onProjectArchive?.(project)
                            setOpen(false)
                          }}
                        >
                          <Archive className="mr-2 size-4" />
                          Archive project
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            onProjectDelete?.(project.id)
                            setOpen(false)
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 size-4" />
                          Delete project
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

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
