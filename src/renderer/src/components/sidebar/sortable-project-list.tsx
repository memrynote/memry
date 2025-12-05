import { useCallback } from "react"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { restrictToVerticalAxis, restrictToParentElement } from "@dnd-kit/modifiers"
import { SortableProjectItem } from "./sortable-project-item"
import { ProjectsEmptyState } from "./projects-empty-state"
import { ProjectsSkeleton } from "./projects-skeleton"
import type { Project } from "@/data/tasks-data"

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
  onCreateProject,
}: SortableProjectListProps): React.JSX.Element => {
  // Configure sensors for drag detection
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // Minimum drag distance before activation
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Handle drag end - reorder projects
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event

      if (over && active.id !== over.id) {
        const oldIndex = projects.findIndex((p) => p.id === active.id)
        const newIndex = projects.findIndex((p) => p.id === over.id)

        if (oldIndex !== -1 && newIndex !== -1) {
          const reorderedProjects = arrayMove(projects, oldIndex, newIndex)
          onProjectsReorder(reorderedProjects)
        }
      }
    },
    [projects, onProjectsReorder]
  )

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
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
    >
      <SortableContext
        items={projects.map((p) => p.id)}
        strategy={verticalListSortingStrategy}
      >
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
    </DndContext>
  )
}

export default SortableProjectList

