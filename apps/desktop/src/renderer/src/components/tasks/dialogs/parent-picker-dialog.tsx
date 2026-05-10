import { useState, useMemo } from 'react'
import { Search, FolderKanban } from '@/lib/icons'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { getPotentialParents } from '@/lib/subtask-utils'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

// ============================================================================
// TYPES
// ============================================================================

interface ParentPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task | null
  allTasks: Task[]
  projects: Project[]
  onSelect: (parentId: string) => void
}

// ============================================================================
// PARENT PICKER DIALOG COMPONENT
// ============================================================================

export const ParentPickerDialog = ({
  open,
  onOpenChange,
  task,
  allTasks,
  projects,
  onSelect
}: ParentPickerDialogProps): React.JSX.Element | null => {
  const { t: tPhaseF } = useT('tasks')
  const [searchQuery, setSearchQuery] = useState('')

  // Get potential parents
  const potentialParents = useMemo(() => {
    if (!task) return []
    return getPotentialParents(task.id, allTasks, task.projectId)
  }, [task, allTasks])

  // Filter by search query
  const filteredParents = useMemo(() => {
    if (!searchQuery.trim()) return potentialParents
    const query = searchQuery.toLowerCase()
    return potentialParents.filter((t) => t.title.toLowerCase().includes(query))
  }, [potentialParents, searchQuery])

  // Group by project
  const groupedParents = useMemo(() => {
    const sameProject: Task[] = []
    const otherProjects: Task[] = []

    filteredParents.forEach((t) => {
      if (task && t.projectId === task.projectId) {
        sameProject.push(t)
      } else {
        otherProjects.push(t)
      }
    })

    return { sameProject, otherProjects }
  }, [filteredParents, task])

  // Get project for a task
  const getProject = (projectId: string): Project | undefined => {
    return projects.find((p) => p.id === projectId)
  }

  if (!task) return null

  const handleSelect = (parentId: string): void => {
    onSelect(parentId)
    onOpenChange(false)
    setSearchQuery('')
  }

  const handleClose = (): void => {
    onOpenChange(false)
    setSearchQuery('')
  }

  const renderTaskItem = (potentialParent: Task): React.JSX.Element => {
    const project = getProject(potentialParent.projectId)
    const isCompleted = !!potentialParent.completedAt

    return (
      <button
        key={potentialParent.id}
        type="button"
        onClick={() => handleSelect(potentialParent.id)}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 rounded-sm text-start',
          'hover:bg-accent transition-colors',
          'focus-visible:outline-none'
        )}
      >
        <span
          aria-hidden="true"
          className="shrink-0 rounded-full transition-all duration-200 size-4"
        >
          {isCompleted ? (
            <span className="size-full rounded-full bg-[#7B9E87] flex items-center justify-center">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path
                  d="M2 5l2.5 2.5L8 3"
                  stroke="#FAFAF8"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          ) : (
            <span className="block size-full rounded-full border-[1.5px] border-[#DAD9D4]" />
          )}
        </span>
        <span
          className={cn(
            'flex-1 truncate text-sm',
            isCompleted && 'line-through text-muted-foreground'
          )}
        >
          {potentialParent.title}
        </span>
        {project && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: project.color }} />
            <span className="truncate max-w-[100px]">{project.name}</span>
          </span>
        )}
      </button>
    )
  }

  const hasResults = filteredParents.length > 0
  const hasSameProject = groupedParents.sameProject.length > 0
  const hasOtherProjects = groupedParents.otherProjects.length > 0

  // Get current project name
  const currentProject = getProject(task.projectId)

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {tPhaseF('phaseF.componentsTasksDialogsParentPickerDialog.makeSubtaskOf')}
          </DialogTitle>
          <DialogDescription>
            {tPhaseF('phaseF.componentsTasksDialogsParentPickerDialog.selectATaskToMake')}
            {task.title}" {tPhaseF('phaseF.componentsTasksDialogsParentPickerDialog.aSubtaskOf')}
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={tPhaseF('phaseF.componentsTasksDialogsParentPickerDialog.searchTasks')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9"
            autoFocus
          />
        </div>

        {/* Task list */}
        <ScrollArea className="h-[300px] -mx-2 px-2">
          {!hasResults ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <FolderKanban className="h-10 w-10 text-muted-foreground/50 mb-2" />
              <p className="text-sm text-muted-foreground">
                {searchQuery
                  ? 'No tasks found matching your search'
                  : 'No available tasks to make this a subtask of'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Same project section */}
              {hasSameProject && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 py-2">
                    {tPhaseF('phaseF.componentsTasksDialogsParentPickerDialog.sameProject')}
                    {currentProject ? ` (${currentProject.name})` : ''}
                  </h4>
                  <div className="space-y-0.5">
                    {groupedParents.sameProject.map(renderTaskItem)}
                  </div>
                </div>
              )}

              {/* Other projects section */}
              {hasOtherProjects && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 py-2">
                    {tPhaseF('phaseF.componentsTasksDialogsParentPickerDialog.otherProjects')}
                  </h4>
                  <div className="space-y-0.5">
                    {groupedParents.otherProjects.map(renderTaskItem)}
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

export default ParentPickerDialog
