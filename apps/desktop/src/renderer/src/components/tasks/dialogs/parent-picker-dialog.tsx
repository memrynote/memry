import { useState, useMemo } from 'react'
import { Search, FolderKanban } from 'lucide-react'

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
import { TaskCheckbox } from '@/components/tasks/task-badges'
import { getPotentialParents } from '@/lib/subtask-utils'
import type { Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'

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
          'w-full flex items-center gap-3 px-3 py-2.5 rounded-sm text-left',
          'hover:bg-accent transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
      >
        <TaskCheckbox checked={isCompleted} onChange={() => {}} />
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
          <DialogTitle>Make subtask of...</DialogTitle>
          <DialogDescription>Select a task to make "{task.title}" a subtask of.</DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
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
                    Same Project{currentProject ? ` (${currentProject.name})` : ''}
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
                    Other Projects
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
