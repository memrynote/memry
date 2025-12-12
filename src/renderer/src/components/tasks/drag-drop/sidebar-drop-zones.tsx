import { useDroppable } from "@dnd-kit/core"
import { Trash2, Archive, Settings } from "lucide-react"

import { cn } from "@/lib/utils"
import { useDragContext } from "@/contexts/drag-context"
import { getIconByName } from "@/components/icon-picker"
import type { Project } from "@/data/tasks-data"

// ============================================================================
// TYPES
// ============================================================================

interface DroppableProjectItemProps {
  project: Project
  isSelected: boolean
  onClick: () => void
  onEdit?: (project: Project) => void
}

interface TrashDropZoneProps {
  className?: string
}

interface ArchiveDropZoneProps {
  className?: string
}

interface SidebarDropZonesProps {
  className?: string
}

// ============================================================================
// DROPPABLE PROJECT ITEM
// ============================================================================

/**
 * A project item in the sidebar that acts as a drop zone
 * Tasks can be dragged onto this to change their project
 */
export const DroppableProjectItem = ({
  project,
  isSelected,
  onClick,
  onEdit,
}: DroppableProjectItemProps): React.JSX.Element => {
  const { dragState } = useDragContext()

  const { setNodeRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    data: {
      type: "project",
      projectId: project.id,
      project,
    },
  })

  // Only show as drop zone when dragging
  const showAsDropZone = dragState.isDragging

  // Get the icon component
  const IconComponent = getIconByName(project.icon)

  const handleClick = (): void => {
    onClick()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onClick()
    }
  }

  const handleEditClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onEdit?.(project)
  }

  const handleEditKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      e.stopPropagation()
      onEdit?.(project)
    }
  }

  return (
    <div
      ref={setNodeRef}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`${project.name}, ${project.taskCount} tasks`}
      aria-pressed={isSelected}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-150",
        "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isSelected && "bg-accent border-l-3 border-l-primary font-medium",
        // Drop zone styling
        showAsDropZone && "border border-dotted border-muted-foreground/40",
        isOver && "bg-primary/10 ring-2 ring-primary shadow-sm"
      )}
    >
      {/* Project Icon or Color Dot */}
      {IconComponent ? (
        <IconComponent
          className="size-4 shrink-0"
          style={{ color: project.color }}
          aria-hidden="true"
        />
      ) : (
        <span
          className="size-3 shrink-0 rounded-full"
          style={{ backgroundColor: project.color }}
          aria-hidden="true"
        />
      )}

      {/* Project Name */}
      <span className="flex-1 truncate text-left text-text-secondary">
        {project.name}
      </span>

      {/* Drop indicator */}
      {isOver && (
        <span className="text-xs text-primary font-medium shrink-0">
          Drop here
        </span>
      )}

      {/* Settings Icon (visible on hover, hidden when dropping) */}
      {!isOver && onEdit && (
        <button
          type="button"
          onClick={handleEditClick}
          onKeyDown={handleEditKeyDown}
          tabIndex={0}
          aria-label={`Edit ${project.name}`}
          className={cn(
            "shrink-0 rounded p-0.5 text-text-tertiary opacity-0 transition-opacity",
            "hover:bg-accent hover:text-text-secondary",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "group-hover:opacity-100"
          )}
        >
          <Settings className="size-3.5" />
        </button>
      )}

      {/* Task Count - hide when showing drop indicator */}
      {!isOver && (
        <span className="shrink-0 text-xs text-text-tertiary">{project.taskCount}</span>
      )}
    </div>
  )
}

// ============================================================================
// TRASH DROP ZONE
// ============================================================================

/**
 * A drop zone for deleting tasks
 * Only visible when dragging
 */
export const TrashDropZone = ({
  className,
}: TrashDropZoneProps): React.JSX.Element => {
  const { dragState, dragCount } = useDragContext()

  const { setNodeRef, isOver } = useDroppable({
    id: "trash",
    data: {
      type: "trash",
    },
  })

  // Only show when dragging
  if (!dragState.isDragging) {
    return <></>
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center gap-2 px-3 py-2.5 mx-2 rounded-lg",
        "border-2 border-dashed transition-all duration-200",
        isOver
          ? "border-destructive bg-destructive/10 text-destructive"
          : "border-muted-foreground/30 text-muted-foreground",
        className
      )}
    >
      <Trash2 className="size-4" />
      <span className="text-sm font-medium">
        {isOver
          ? `Delete ${dragCount} task${dragCount !== 1 ? "s" : ""}`
          : "Drop to delete"}
      </span>
    </div>
  )
}

// ============================================================================
// ARCHIVE DROP ZONE
// ============================================================================

/**
 * A drop zone for archiving tasks
 * Only visible when dragging
 */
export const ArchiveDropZone = ({
  className,
}: ArchiveDropZoneProps): React.JSX.Element => {
  const { dragState, dragCount } = useDragContext()

  const { setNodeRef, isOver } = useDroppable({
    id: "archive",
    data: {
      type: "archive",
    },
  })

  // Only show when dragging
  if (!dragState.isDragging) {
    return <></>
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex items-center gap-2 px-3 py-2.5 mx-2 rounded-lg",
        "border-2 border-dashed transition-all duration-200",
        isOver
          ? "border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : "border-muted-foreground/30 text-muted-foreground",
        className
      )}
    >
      <Archive className="size-4" />
      <span className="text-sm font-medium">
        {isOver
          ? `Archive ${dragCount} task${dragCount !== 1 ? "s" : ""}`
          : "Drop to archive"}
      </span>
    </div>
  )
}

// ============================================================================
// SIDEBAR DROP ZONES CONTAINER
// ============================================================================

/**
 * Container for trash and archive drop zones
 * Shows at the bottom of the sidebar when dragging
 */
export const SidebarDropZones = ({
  className,
}: SidebarDropZonesProps): React.JSX.Element => {
  const { dragState } = useDragContext()

  // Only show when dragging
  if (!dragState.isDragging) {
    return <></>
  }

  return (
    <div
      className={cn(
        "border-t border-border pt-3 pb-2 space-y-2",
        "animate-in slide-in-from-bottom-2 duration-200",
        className
      )}
    >
      <ArchiveDropZone />
      <TrashDropZone />
    </div>
  )
}

export default SidebarDropZones










