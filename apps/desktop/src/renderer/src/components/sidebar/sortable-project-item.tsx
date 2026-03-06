import { useSortable } from '@dnd-kit/sortable'
import { useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Settings } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import { useDragContext } from '@/contexts/drag-context'
import type { Project } from '@/data/tasks-data'

interface SortableProjectItemProps {
  project: Project
  isActive: boolean
  onClick: (e: React.MouseEvent) => void
  onEdit: (project: Project) => void
  onArchive: (project: Project) => void
  onDelete: (projectId: string) => void
}

/**
 * A draggable project item for the sidebar
 * Supports drag-to-reorder with visual feedback
 * Also acts as a drop zone for tasks to move them to this project
 */
export const SortableProjectItem = ({
  project,
  isActive,
  onClick,
  onEdit,
  onArchive,
  onDelete
}: SortableProjectItemProps): React.JSX.Element => {
  const { isMobile } = useSidebar()

  // Try to get drag context - may not be available if not wrapped in DragProvider
  let dragState = { isDragging: false }
  try {
    const context = useDragContext()
    dragState = context.dragState
  } catch {
    // Not in DragProvider context - that's okay, just no drop zone features
  }

  // Sortable for reordering projects
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging: isSortableDragging
  } = useSortable({ id: project.id })

  // Droppable for receiving tasks
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    data: {
      type: 'project',
      projectId: project.id,
      project
    }
  })

  // Combine refs
  const setRefs = (node: HTMLLIElement | null): void => {
    setSortableRef(node)
    setDroppableRef(node)
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  // Show as drop zone when a task is being dragged (not a project)
  const showAsDropZone = dragState.isDragging && !isSortableDragging

  return (
    <SidebarMenuItem
      ref={setRefs}
      style={style}
      className={cn(
        'group/project relative transition-all duration-150',
        isSortableDragging && 'opacity-50 z-50',
        // Drop zone visual feedback
        showAsDropZone && 'border border-dotted border-muted-foreground/40 rounded-md',
        isOver && 'bg-primary/10 ring-2 ring-primary rounded-md shadow-sm'
      )}
      {...attributes}
      {...listeners}
    >
      {/* Drop indicator when hovering */}
      {isOver && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-primary font-medium z-10">
          Drop here
        </span>
      )}

      <SidebarMenuButton tooltip={project.name} isActive={isActive} onClick={onClick}>
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: project.color }}
          aria-hidden="true"
        />
        <span className="truncate">{project.name}</span>
      </SidebarMenuButton>

      {/* Task count badge - hide when showing drop indicator */}
      {!isOver && (
        <SidebarMenuBadge className={cn(!isActive && 'group-hover/project:hidden')}>
          {project.taskCount > 0 ? project.taskCount : ''}
        </SidebarMenuBadge>
      )}

      {/* Edit project button - hide when drop zone active */}
      {!showAsDropZone && (
        <SidebarMenuAction
          showOnHover
          className={cn(
            !isActive && 'opacity-0 group-hover/project:opacity-100',
            isActive && 'hidden'
          )}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(project)
          }}
        >
          <Settings className="size-4 text-muted-foreground" />
          <span className="sr-only">Edit project</span>
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  )
}

export default SortableProjectItem
