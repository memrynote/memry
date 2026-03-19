import React, { useState, useMemo } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Download, Plus } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { StatusIcon } from '@/components/tasks/status-icon'
import { PriorityBars, PriorityStar } from '@/components/tasks/task-icons'
import { useDragContext } from '@/contexts/drag-context'
import { priorityConfig, type Priority, type Task } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { SortableKanbanCard } from './kanban-card'
import { KanbanEmptyColumn } from './kanban-empty-column'
import type { KanbanColumnDef } from './kanban-columns'

interface KanbanColumnProps {
  column: KanbanColumnDef
  tasks: Task[]
  allTasks: Task[]
  projects: Project[]
  focusedTaskId?: string | null
  selectedTaskId?: string | null
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onTaskClick?: (taskId: string) => void
  onToggleComplete?: (taskId: string) => void
  onToggleSelect?: (taskId: string) => void
  onQuickAdd?: (title: string, columnId: string) => void
  showProjectBadge?: boolean
}

const MAX_VISIBLE_DONE = 5

const DropPlaceholder = (): React.JSX.Element => (
  <div className="flex flex-col items-center justify-center rounded-md py-8 px-4 gap-1.5 bg-primary/[0.03] border-[1.5px] border-dashed border-primary/40">
    <Download size={20} className="text-primary/50" />
    <span className="text-[12px] text-primary/60 leading-4">Drop here</span>
    <span className="text-[11px] text-center text-primary/35 leading-3.5">
      Release to move task to this column
    </span>
  </div>
)

const KanbanGhostCard = ({ title }: { title: string }): React.JSX.Element => (
  <div
    className="opacity-40 rounded-md py-2 px-2.5 bg-primary/[0.03] border-[1.5px] border-dashed border-primary/30 pointer-events-none"
    aria-hidden="true"
  >
    <span className="text-[12px] text-muted-foreground leading-4 line-clamp-2">{title}</span>
  </div>
)

export const KanbanColumn = ({
  column,
  tasks,
  allTasks,
  projects,
  focusedTaskId,
  selectedTaskId,
  isSelectionMode = false,
  selectedIds,
  onTaskClick,
  onToggleComplete,
  onToggleSelect,
  onQuickAdd,
  showProjectBadge
}: KanbanColumnProps): React.JSX.Element => {
  const [showAllDone, setShowAllDone] = useState(false)
  const [isAddingTask, setIsAddingTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)

  const { dragState } = useDragContext()

  const isDoneColumn = column.statusType === 'done'
  const isDragging = dragState.isDragging
  const hiddenCount =
    isDoneColumn && !showAllDone ? Math.max(0, tasks.length - MAX_VISIBLE_DONE) : 0
  const visibleTasks = isDoneColumn && !showAllDone ? tasks.slice(0, MAX_VISIBLE_DONE) : tasks
  const taskIds = useMemo(() => visibleTasks.map((t) => t.id), [visibleTasks])

  const { setNodeRef, isOver } = useDroppable({
    id: `column-${column.id}`,
    data: {
      type: 'column',
      columnId: column.id,
      sectionId: column.id,
      sectionTaskIds: taskIds,
      column: { title: column.title },
      project: column.project
    }
  })

  const crossColumnOverIndex = useMemo(() => {
    if (!dragState.isDragging || !dragState.overId) return -1
    if (dragState.sourceContainerId === column.id) return -1
    return visibleTasks.findIndex((t) => t.id === dragState.overId)
  }, [dragState.isDragging, dragState.overId, dragState.sourceContainerId, column.id, visibleTasks])

  const isCrossColumnTarget = crossColumnOverIndex !== -1
  const shouldHighlight = isOver || isCrossColumnTarget

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>()
    projects.forEach((p) => map.set(p.id, p))
    return map
  }, [projects])

  const handleAddSubmit = (): void => {
    const title = newTaskTitle.trim()
    if (title && onQuickAdd) {
      onQuickAdd(title, column.id)
    }
    setNewTaskTitle('')
    setIsAddingTask(false)
  }

  const handleAddKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddSubmit()
    } else if (e.key === 'Escape') {
      setNewTaskTitle('')
      setIsAddingTask(false)
    }
  }

  return (
    <div
      className="flex flex-col w-[272px] shrink-0 gap-1.5"
      role="region"
      aria-label={`${column.title} column, ${tasks.length} tasks`}
    >
      {/* Column header — outside the bordered card area */}
      <div className="flex items-center gap-2.5 py-1.5 px-2">
        {column.id.startsWith('priority-') ? (
          column.id === 'priority-urgent' ? (
            <PriorityStar color={priorityConfig.urgent.color!} />
          ) : (
            <PriorityBars priority={column.id.replace('priority-', '') as Priority} />
          )
        ) : column.statusType === 'custom' ? (
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: column.color || 'var(--muted-foreground)' }}
          />
        ) : (
          <StatusIcon type={column.statusType} color={column.color ?? 'var(--muted-foreground)'} />
        )}
        <span
          className={cn(
            'text-[13px]/4 font-medium truncate',
            shouldHighlight ? 'text-text-primary' : 'text-text-secondary'
          )}
        >
          {column.title}
        </span>
        <span className="text-[13px]/4 font-medium text-text-tertiary tabular-nums">
          {tasks.length}
        </span>
        <div className="flex-1" />
        {!isDoneColumn && onQuickAdd && !isDragging && (
          <button
            type="button"
            onClick={() => setIsAddingTask(true)}
            className="p-0.5 rounded text-text-tertiary hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label={`Add task to ${column.title}`}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Card list — bordered container for tasks only */}
      <div
        ref={setNodeRef}
        className={cn(
          'flex flex-col rounded-lg border p-2 gap-1.5 transition-all duration-150',
          shouldHighlight
            ? 'bg-primary/[0.03] border-[1.5px] border-primary/20'
            : 'bg-sidebar border-border'
        )}
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5 min-h-[40px]">
            {visibleTasks.length === 0 && !isAddingTask && !isOver && (
              <KanbanEmptyColumn variant={isDoneColumn ? 'done' : 'default'} isDropTarget={false} />
            )}

            {visibleTasks.length === 0 && !isAddingTask && isOver && <DropPlaceholder />}

            {visibleTasks.map((task, index) => (
              <React.Fragment key={task.id}>
                {index === crossColumnOverIndex && (
                  <KanbanGhostCard title={dragState.draggedTasks[0]?.title ?? ''} />
                )}
                <SortableKanbanCard
                  task={task}
                  columnId={column.id}
                  sectionTaskIds={taskIds}
                  project={projectMap.get(task.projectId)}
                  allTasks={allTasks}
                  isDone={isDoneColumn || task.completedAt !== null}
                  isSelected={selectedTaskId === task.id || selectedIds?.has(task.id)}
                  isFocused={focusedTaskId === task.id}
                  isSelectionMode={isSelectionMode}
                  showProjectBadge={showProjectBadge}
                  onClick={() => onTaskClick?.(task.id)}
                  onToggleComplete={() => onToggleComplete?.(task.id)}
                  onToggleSelect={() => onToggleSelect?.(task.id)}
                />
              </React.Fragment>
            ))}

            {visibleTasks.length > 0 && isOver && !isCrossColumnTarget && <DropPlaceholder />}
          </div>
        </SortableContext>

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllDone(true)}
            className="mt-1 py-1.5 text-[11px] text-text-tertiary hover:text-foreground transition-colors text-center"
          >
            {hiddenCount} more completed
          </button>
        )}

        {showAllDone && isDoneColumn && tasks.length > MAX_VISIBLE_DONE && (
          <button
            type="button"
            onClick={() => setShowAllDone(false)}
            className="mt-0.5 py-1 text-[11px] text-text-tertiary hover:text-foreground transition-colors text-center"
          >
            Show fewer
          </button>
        )}

        {isAddingTask && (
          <div className="mt-0.5">
            <input
              type="text"
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={handleAddKeyDown}
              onBlur={handleAddSubmit}
              placeholder="Task title..."
              autoFocus
              className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] text-foreground placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-primary/40"
            />
          </div>
        )}
      </div>
    </div>
  )
}
