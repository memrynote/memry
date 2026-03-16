import { useMemo, useState, useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'

import { cn } from '@/lib/utils'
import { ScrollArea } from '@/components/ui/scroll-area'
import { KanbanCard } from './kanban-card'
import { KanbanCardEdit } from './kanban-card-edit'
import { KanbanEmptyColumn } from './kanban-empty-column'
import { getIconByName } from '@/components/icon-picker'
import { startOfDay, isBefore } from '@/lib/task-utils'
import type { Task } from '@/data/sample-tasks'
import type { Project, Status, StatusType } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

export interface KanbanColumnData {
  id: string
  title: string
  color: string
  icon?: string
  type: 'status' | 'project' | 'weekday'
  statusType?: StatusType
  date?: Date
}

interface KanbanColumnProps {
  column: KanbanColumnData
  tasks: Task[]
  allTasks: Task[]
  projects: Project[]
  showProject: boolean
  selectedTaskId: string | null
  focusedTaskId: string | null
  editingTaskId: string | null
  statuses: Status[]
  getTaskIsCompleted: (task: Task) => boolean
  onTaskClick: (taskId: string) => void
  onTaskDoubleClick: (taskId: string) => void
  onQuickAdd: (title: string, columnId: string) => void
  onEditSave: (taskId: string, updates: Partial<Task>) => void
  onEditCancel: () => void
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
}

const MAX_VISIBLE_DONE = 5

// ============================================================================
// KANBAN COLUMN
// ============================================================================

export const KanbanColumn = ({
  column,
  tasks,
  allTasks,
  projects,
  showProject,
  selectedTaskId,
  focusedTaskId,
  editingTaskId,
  statuses,
  getTaskIsCompleted,
  onTaskClick,
  onTaskDoubleClick,
  onQuickAdd,
  onEditSave,
  onEditCancel,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect
}: KanbanColumnProps): React.JSX.Element => {
  const [isAddingTask, setIsAddingTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)

  const droppableData =
    column.type === 'project'
      ? {
          type: 'project' as const,
          projectId: column.id,
          project: { id: column.id, name: column.title }
        }
      : column.type === 'weekday'
        ? {
            type: 'weekday' as const,
            date: column.date,
            label: column.title
          }
        : {
            type: 'column' as const,
            columnId: column.id,
            column
          }

  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: droppableData
  })

  const isDoneColumn = column.statusType === 'done'
  const today = startOfDay(new Date())

  const isTaskOverdue = useCallback(
    (task: Task): boolean => {
      if (!task.dueDate) return false
      return isBefore(startOfDay(task.dueDate), today)
    },
    [today]
  )

  const visibleTasks = useMemo(() => {
    if (!isDoneColumn || showAllDone) return tasks
    return tasks.slice(0, MAX_VISIBLE_DONE)
  }, [tasks, isDoneColumn, showAllDone])

  const hiddenDoneCount =
    isDoneColumn && !showAllDone ? Math.max(0, tasks.length - MAX_VISIBLE_DONE) : 0

  const taskIds = useMemo(() => visibleTasks.map((t) => t.id), [visibleTasks])

  const handleAddClick = (): void => setIsAddingTask(true)

  const handleAddSubmit = (): void => {
    if (newTaskTitle.trim()) {
      onQuickAdd(newTaskTitle.trim(), column.id)
      setNewTaskTitle('')
    }
    setIsAddingTask(false)
  }

  const handleAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddSubmit()
    } else if (e.key === 'Escape') {
      setNewTaskTitle('')
      setIsAddingTask(false)
    }
  }

  const handleAddBlur = (): void => {
    if (newTaskTitle.trim()) handleAddSubmit()
    else setIsAddingTask(false)
  }

  const getProject = (projectId: string): Project | null => {
    return projects.find((p) => p.id === projectId) || null
  }

  const IconComponent = column.icon ? getIconByName(column.icon) : null

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex h-full min-w-[250px] flex-1 flex-col gap-2.5 transition-colors',
        isOver && 'bg-primary/[0.03] rounded-lg'
      )}
    >
      {/* Column Header */}
      <div className="flex items-center justify-between pb-2.5 border-b border-border px-1">
        <div className="flex items-center gap-2">
          {column.type === 'project' && IconComponent ? (
            <IconComponent
              className="size-3 shrink-0"
              style={{ color: column.color }}
              aria-hidden="true"
            />
          ) : (
            <div
              className="rounded-full shrink-0 size-2"
              style={{ backgroundColor: column.color }}
              aria-hidden="true"
            />
          )}
          <span className="text-[13px] tracking-[-0.01em] font-heading font-semibold text-foreground leading-4">
            {column.title}
          </span>
          <span className="text-[11px] text-text-tertiary leading-3.5">{tasks.length}</span>
        </div>

        {!isDoneColumn && (
          <button
            type="button"
            onClick={handleAddClick}
            className="text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            aria-label={`Add task to ${column.title}`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 3v8M3 7h8"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Card List */}
      <ScrollArea className="flex-1">
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          <div className="flex min-h-[100px] flex-col gap-2.5">
            {visibleTasks.length === 0 && tasks.length === 0 ? (
              <KanbanEmptyColumn
                columnType={column.type}
                isDone={isDoneColumn}
                isDropTarget={isOver}
              />
            ) : (
              visibleTasks.map((task) => {
                const isCompleted = getTaskIsCompleted(task)
                const isOverdue = isTaskOverdue(task) && !isCompleted
                const isEditing = editingTaskId === task.id
                const isCheckedForSelection = selectedIds?.has(task.id) ?? false

                if (isEditing) {
                  return (
                    <KanbanCardEdit
                      key={`edit-${task.id}`}
                      task={task}
                      statuses={statuses}
                      onSave={onEditSave}
                      onCancel={onEditCancel}
                    />
                  )
                }

                return (
                  <KanbanCard
                    key={task.id}
                    task={task}
                    columnId={column.id}
                    allTasks={allTasks}
                    project={getProject(task.projectId)}
                    showProject={showProject}
                    isSelected={selectedTaskId === task.id}
                    isFocused={focusedTaskId === task.id}
                    isCompleted={isCompleted}
                    isOverdue={isOverdue}
                    onClick={() => onTaskClick(task.id)}
                    onDoubleClick={() => onTaskDoubleClick(task.id)}
                    isSelectionMode={isSelectionMode}
                    isCheckedForSelection={isCheckedForSelection}
                    onToggleSelect={onToggleSelect}
                  />
                )
              })
            )}
          </div>
        </SortableContext>
      </ScrollArea>

      {/* "N more completed tasks" for done column */}
      {hiddenDoneCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAllDone(true)}
          className="flex items-center justify-center rounded-md py-2 px-2.5 text-[12px] text-text-tertiary hover:text-muted-foreground transition-colors"
        >
          {hiddenDoneCount} more completed task{hiddenDoneCount !== 1 ? 's' : ''}
        </button>
      )}

      {/* Footer - Add Task (hidden for done columns) */}
      {!isDoneColumn && (
        <div className="pt-0.5">
          {isAddingTask ? (
            <input
              type="text"
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={handleAddKeyDown}
              onBlur={handleAddBlur}
              placeholder="Task title..."
              autoFocus
              className={cn(
                'w-full rounded-lg border border-border bg-card px-3.5 py-2.5 text-[13px]',
                'placeholder:text-muted-foreground/40',
                'focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-border'
              )}
            />
          ) : (
            <button
              type="button"
              onClick={handleAddClick}
              className="flex items-center rounded-md py-2 px-2.5 gap-1.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                <path
                  d="M6.5 2.5v8M2.5 6.5h8"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              <span className="text-[12px] leading-4">Add task</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default KanbanColumn
