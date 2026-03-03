import { useCallback } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { SortableProjectItem } from './sortable-project-item'
import { ProjectsEmptyState } from './projects-empty-state'
import { ProjectsSkeleton } from './projects-skeleton'
import type { Project } from '@/data/tasks-data'

interface SortableProjectListProps {
  projects: Project[]
  activeProjectId: string | null
  isLoading?: boolean
  onProjectClick: (projectId: string) => void
  onProjectEdit: (project: Project) => void
  onProjectArchive: (project: Project) => void
  onProjectDelete: (projectId: string) => void
  onProjectsReorder: (projects: Project[]) => void
  onCreateProject: () => void
}

/**
 * A sortable list of projects in the sidebar
 * Supports drag-to-reorder with persistence
 *
 * NOTE: This component no longer creates its own DndContext.
 * It relies on the parent DragProvider's DndContext for drag-drop functionality.
 * This allows tasks to be dropped onto project items to move them between projects.
 */
export const SortableProjectList = ({
  projects,
  activeProjectId,
  isLoading = false,
  onProjectClick,
  onProjectEdit,
  onProjectArchive,
  onProjectDelete,
  onProjectsReorder,
  onCreateProject
}: SortableProjectListProps): React.JSX.Element => {
  // Handle project click
  const handleProjectClick = useCallback(
    (projectId: string) => (e: React.MouseEvent) => {
      e.preventDefault()
      onProjectClick(projectId)
    },
    [onProjectClick]
  )

  // Show loading skeleton
  if (isLoading) {
    return <ProjectsSkeleton count={3} />
  }

  // Show empty state if no projects
  if (projects.length === 0) {
    return <ProjectsEmptyState onCreateProject={onCreateProject} />
  }

  return (
    <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
      {projects.map((project) => (
        <SortableProjectItem
          key={project.id}
          project={project}
          isActive={activeProjectId === project.id}
          onClick={handleProjectClick(project.id)}
          onEdit={onProjectEdit}
          onArchive={onProjectArchive}
          onDelete={onProjectDelete}
        />
      ))}
    </SortableContext>
  )
}

export default SortableProjectList
