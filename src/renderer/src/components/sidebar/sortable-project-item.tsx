import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Settings } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { Project } from "@/data/tasks-data"

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
 */
export const SortableProjectItem = ({
  project,
  isActive,
  onClick,
  onEdit,
  onArchive,
  onDelete,
}: SortableProjectItemProps): React.JSX.Element => {
  const { isMobile } = useSidebar()

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <SidebarMenuItem
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/project relative",
        isDragging && "opacity-50 z-50"
      )}
    >
      {/* Drag Handle - visible on hover */}
      <button
        type="button"
        className={cn(
          "absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1",
          "p-0.5 rounded opacity-0 group-hover/project:opacity-100",
          "cursor-grab active:cursor-grabbing",
          "text-sidebar-foreground/40 hover:text-sidebar-foreground/70",
          "transition-opacity focus-visible:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
        {...attributes}
        {...listeners}
        tabIndex={-1}
        aria-label={`Drag to reorder ${project.name}`}
      >
        <GripVertical className="size-3" />
      </button>

      <SidebarMenuButton
        tooltip={project.name}
        isActive={isActive}
        onClick={onClick}
      >
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{ backgroundColor: project.color }}
          aria-hidden="true"
        />
        <span className="truncate">{project.name}</span>
      </SidebarMenuButton>

      {/* Task count badge */}
      <SidebarMenuBadge className={cn(
        !isActive && "group-hover/project:hidden"
      )}>
        {project.taskCount > 0 ? project.taskCount : ""}
      </SidebarMenuBadge>

      {/* Edit project button */}
      <SidebarMenuAction
        showOnHover
        className={cn(
          !isActive && "opacity-0 group-hover/project:opacity-100",
          isActive && "hidden"
        )}
        onClick={(e) => {
          e.stopPropagation()
          onEdit(project)
        }}
      >
        <Settings className="size-4 text-muted-foreground" />
        <span className="sr-only">Edit project</span>
      </SidebarMenuAction>
    </SidebarMenuItem>
  )
}

export default SortableProjectItem


