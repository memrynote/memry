import { Plus, FolderKanban } from "lucide-react"
import { cn } from "@/lib/utils"

interface ProjectsEmptyStateProps {
  onCreateProject: () => void
  className?: string
}

/**
 * Empty state shown when there are no projects in the sidebar
 * Encourages users to create their first project
 */
export const ProjectsEmptyState = ({
  onCreateProject,
  className,
}: ProjectsEmptyStateProps): React.JSX.Element => {
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      onCreateProject()
    }
  }

  return (
    <div className={cn("py-4 px-2 text-center", className)}>
      {/* Icon */}
      <div className="flex justify-center mb-2">
        <FolderKanban className="size-8 text-sidebar-foreground/30" />
      </div>

      {/* Message */}
      <p className="text-sm text-sidebar-foreground/60 mb-3">
        No projects yet
      </p>

      {/* Create button */}
      <button
        type="button"
        onClick={onCreateProject}
        onKeyDown={handleKeyDown}
        className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md",
          "text-sm text-sidebar-foreground/70 hover:text-sidebar-foreground",
          "hover:bg-sidebar-accent transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
        tabIndex={0}
        aria-label="Create your first project"
      >
        <Plus className="size-4" />
        <span>Create your first project</span>
      </button>
    </div>
  )
}

export default ProjectsEmptyState








