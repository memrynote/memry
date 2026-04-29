import { Plus, FolderKanban } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

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
  className
}: ProjectsEmptyStateProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('notes')
  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onCreateProject()
    }
  }

  return (
    <div className={cn('py-4 px-2 text-center', className)}>
      {/* Icon */}
      <div className="flex justify-center mb-2">
        <FolderKanban className="size-8 text-sidebar-foreground/30" />
      </div>

      {/* Message */}
      <p className="text-sm text-sidebar-foreground/60 mb-3">
        {tPhaseF('phaseF.componentsSidebarProjectsEmptyState.noProjectsYet')}
      </p>

      {/* Create button */}
      <button
        type="button"
        onClick={onCreateProject}
        onKeyDown={handleKeyDown}
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md',
          'text-sm text-sidebar-foreground/70 hover:text-sidebar-foreground',
          'hover:bg-sidebar-accent transition-colors',
          'focus-visible:outline-none'
        )}
        tabIndex={0}
        aria-label={tPhaseF('phaseF.componentsSidebarProjectsEmptyState.createYourFirstProject')}
      >
        <Plus className="size-4" />
        <span>{tPhaseF('phaseF.componentsSidebarProjectsEmptyState.createYourFirstProject2')}</span>
      </button>
    </div>
  )
}

export default ProjectsEmptyState
