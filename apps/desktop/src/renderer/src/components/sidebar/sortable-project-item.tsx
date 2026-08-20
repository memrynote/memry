import { useCallback, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { PROJECT_SORT_DRAG_TYPE } from './sidebar-drag-types'
import { CSS } from '@dnd-kit/utilities'
import { toast } from 'sonner'
import { Settings } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar
} from '@/components/ui/sidebar'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { OpenTargetMenuItems } from '@/components/sidebar/open-target-menu-items'
import { createTabFromSidebarItem } from '@/contexts/tabs/helpers'
import { useOpenTarget } from '@/hooks/use-open-target'
import { useOptionalDragContext } from '@/contexts/drag-context'
import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import { extractErrorMessage } from '@/lib/ipc-error'
import { linkSidebarItemToProject } from '@/lib/link-sidebar-item-to-project'
import { notesService } from '@/services/notes-service'
import { tasksService } from '@/services/tasks-service'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { Project } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

interface SortableProjectItemProps {
  project: Project
  isActive: boolean
  onClick: (e: React.MouseEvent) => void
  onEdit: (project: Project) => void
  onArchive: (project: Project) => void
  onDelete: (projectId: string) => void
  /** Reordering only applies in the manual sort mode; a sorted list is not draggable. */
  reorderDisabled?: boolean
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
  onArchive: _onArchive,
  onDelete: _onDelete,
  reorderDisabled = false
}: SortableProjectItemProps): React.JSX.Element => {
  const { t: tPhaseF } = useT('notes')
  const { t: tTasks } = useT('tasks')
  const { isMobile: _isMobile } = useSidebar()

  const dragContext = useOptionalDragContext()
  const dragState = dragContext?.dragState ?? { isDragging: false }

  // Sortable for reordering projects
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging: isSortableDragging
  } = useSortable({
    id: project.id,
    disabled: reorderDisabled,
    // Named so a drag can be identified as "a project being reordered" rather
    // than inferred from the absence of a type, which every other untyped
    // sortable in the app would also match.
    data: { type: PROJECT_SORT_DRAG_TYPE, projectId: project.id }
  })

  // While a project is being dragged to reorder, the row must NOT advertise
  // itself as a task drop target: dnd-kit would resolve `over` to this
  // droppable's `project-<id>`, the reorder never sees a project id to drop
  // next to, and the drop falls through to "0 tasks moved".
  const { active } = useDndContext()
  const isReorderingAProject = active?.data?.current?.type === PROJECT_SORT_DRAG_TYPE

  // Droppable for receiving tasks
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({
    id: `project-${project.id}`,
    disabled: isReorderingAProject,
    data: {
      type: 'project',
      projectId: project.id,
      project
    }
  })

  // dnd-kit stops reporting `isOver` for a disabled droppable, but the drop-here
  // affordance is guarded explicitly too: a project being dragged to reorder
  // must never look like it is about to swallow tasks.
  const showTaskDropTarget = isOver && !isReorderingAProject

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
  const showAsDropZone = dragState.isDragging && !isSortableDragging && !isReorderingAProject

  // Native HTML5 drop target for sidebar notes/files dragged from the notes tree
  const [isNoteDragOver, setIsNoteDragOver] = useState(false)

  const handleNoteDragOver = useCallback((e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsNoteDragOver(true)
  }, [])

  const handleNoteDragLeave = useCallback((): void => {
    setIsNoteDragOver(false)
  }, [])

  const handleNoteDrop = useCallback(
    (e: React.DragEvent): void => {
      if (!e.dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)) return
      e.preventDefault()
      setIsNoteDragOver(false)
      void (async () => {
        try {
          const linked = await linkSidebarItemToProject(e.dataTransfer, project.id, {
            getFile: (id) => notesService.getFile(id),
            link: (input) => tasksService.linkProjectItem(input)
          })
          if (linked) toast.success(tTasks('addToProject.toastSuccess', { name: project.name }))
        } catch (error) {
          trackRendererError('project_link_drop', error)
          toast.error(extractErrorMessage(error, tTasks('addToProject.toastError')))
        }
      })()
    },
    [project.id, project.name, tTasks]
  )

  // The same tab the context menu's "Open in New Tab" builds — middle-click is
  // that command as a gesture, opening in the background (mousedown: middle
  // never produces `click`).
  const { openInNewTab } = useOpenTarget()
  const projectTab = createTabFromSidebarItem({
    type: 'project',
    title: project.name,
    icon: 'folder',
    path: `/project/${project.id}`,
    entityId: project.id
  })
  const handleMiddleClick = (e: React.MouseEvent): void => {
    if (e.button !== 1) return
    e.preventDefault()
    openInNewTab(projectTab, { background: true })
  }

  return (
    <SidebarMenuItem
      ref={setRefs}
      style={style}
      onDragOver={handleNoteDragOver}
      onDragLeave={handleNoteDragLeave}
      onDrop={handleNoteDrop}
      className={cn(
        // Matches the notes tree row rhythm: 4px inset + 1px gutter between rows
        'group/project relative ms-1 pb-px transition-all duration-150',
        isSortableDragging && 'opacity-50 z-50',
        // Drop zone visual feedback
        showAsDropZone && 'border border-dotted border-muted-foreground/40 rounded-md',
        showTaskDropTarget && 'bg-primary/10 ring-2 ring-primary rounded-md shadow-sm',
        isNoteDragOver && 'bg-primary/10 ring-2 ring-primary rounded-md shadow-sm'
      )}
      {...attributes}
      {...listeners}
    >
      {/* Drop indicator when hovering */}
      {showTaskDropTarget && (
        <span className="absolute end-2 top-1/2 -translate-y-1/2 text-xs text-primary font-medium z-10">
          {tPhaseF('phaseF.componentsSidebarSortableProjectItem.dropHere')}
        </span>
      )}

      {/* Geometry mirrors TreeNodeTrigger so projects read as one list with the notes tree */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={project.name}
            isActive={isActive}
            onClick={onClick}
            onMouseDown={handleMiddleClick}
            className="h-7 gap-1.5 rounded-[5px] py-0 ps-1"
          >
            {/* Leading block mirrors the tree: expander slot + icon slot */}
            <span className="flex shrink-0 items-center gap-0.5" aria-hidden="true">
              <span className="size-4" />
              <span className="flex size-5 items-center justify-center">
                <span
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: project.color }}
                />
              </span>
            </span>
            {/* flex-1 keeps the fade mask over the row's trailing space, so short names stay crisp */}
            <span className="sidebar-label-fade flex-1 text-[13px] leading-4 font-medium">
              {project.name}
            </span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <OpenTargetMenuItems tab={projectTab} />
        </ContextMenuContent>
      </ContextMenu>

      {/* Task count badge - hide when showing drop indicator */}
      {!showTaskDropTarget && (
        <SidebarMenuBadge className={cn('top-1', !isActive && 'group-hover/project:hidden')}>
          {project.taskCount > 0 ? project.taskCount : ''}
        </SidebarMenuBadge>
      )}

      {/* Edit project button - hide when drop zone active */}
      {!showAsDropZone && (
        <SidebarMenuAction
          showOnHover
          className={cn(
            'top-1',
            !isActive && 'opacity-0 group-hover/project:opacity-100',
            isActive && 'hidden'
          )}
          onClick={(e) => {
            e.stopPropagation()
            onEdit(project)
          }}
        >
          <Settings className="size-4 text-muted-foreground" />
          <span className="sr-only">
            {tPhaseF('phaseF.componentsSidebarSortableProjectItem.editProject')}
          </span>
        </SidebarMenuAction>
      )}
    </SidebarMenuItem>
  )
}

export default SortableProjectItem
