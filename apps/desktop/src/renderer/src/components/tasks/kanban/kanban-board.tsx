import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react'

import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import type { Task } from '@/data/sample-tasks'
import type { Project, SortField } from '@/data/tasks-data'
import { KanbanColumn } from './kanban-column'
import { KanbanDragOverlay } from './kanban-drag-overlay'
import { buildColumnConfig } from './kanban-columns'

interface KanbanBoardProps {
  tasks: Task[]
  projects: Project[]
  selectedId: string
  selectedType: 'view' | 'project'
  selectedProjectId: string | null
  sortField: SortField
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void
  onToggleComplete: (taskId: string) => void
  onTaskClick?: (taskId: string) => void
  onQuickAdd?: (title: string, columnId: string) => void
  isSelectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (taskId: string) => void
}

export const KanbanBoard = ({
  tasks,
  projects,
  selectedType,
  selectedProjectId,
  sortField,
  onToggleComplete,
  onTaskClick,
  onQuickAdd,
  isSelectionMode = false,
  selectedIds,
  onToggleSelect
}: KanbanBoardProps): React.JSX.Element => {
  const showProjectBadge = !selectedProjectId
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null)
  const boardRef = useRef<HTMLDivElement>(null)

  const { columns, tasksByColumn } = useMemo(
    () => buildColumnConfig(tasks, projects, selectedType, selectedProjectId, sortField),
    [tasks, projects, selectedType, selectedProjectId, sortField]
  )

  const flatTaskList = useMemo(() => {
    const result: { taskId: string; columnIndex: number }[] = []
    columns.forEach((col, colIdx) => {
      const colTasks = tasksByColumn.get(col.id) || []
      colTasks.forEach((t) => result.push({ taskId: t.id, columnIndex: colIdx }))
    })
    return result
  }, [columns, tasksByColumn])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      const currentIndex = flatTaskList.findIndex((item) => item.taskId === focusedTaskId)

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault()
          const nextIndex = currentIndex < flatTaskList.length - 1 ? currentIndex + 1 : 0
          setFocusedTaskId(flatTaskList[nextIndex]?.taskId ?? null)
          break
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault()
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : flatTaskList.length - 1
          setFocusedTaskId(flatTaskList[prevIndex]?.taskId ?? null)
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          if (currentIndex < 0 || flatTaskList.length === 0) break
          const currentColIdx = flatTaskList[currentIndex].columnIndex
          const prevColIdx = currentColIdx > 0 ? currentColIdx - 1 : columns.length - 1
          const firstInPrevCol = flatTaskList.find((item) => item.columnIndex === prevColIdx)
          if (firstInPrevCol) setFocusedTaskId(firstInPrevCol.taskId)
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          if (currentIndex < 0 || flatTaskList.length === 0) break
          const currentColIdx = flatTaskList[currentIndex].columnIndex
          const nextColIdx = currentColIdx < columns.length - 1 ? currentColIdx + 1 : 0
          const firstInNextCol = flatTaskList.find((item) => item.columnIndex === nextColIdx)
          if (firstInNextCol) setFocusedTaskId(firstInNextCol.taskId)
          break
        }
        case ' ': {
          e.preventDefault()
          if (focusedTaskId) onToggleComplete(focusedTaskId)
          break
        }
        case 'Enter': {
          e.preventDefault()
          if (focusedTaskId) onTaskClick?.(focusedTaskId)
          break
        }
        case 'Escape': {
          e.preventDefault()
          setFocusedTaskId(null)
          break
        }
      }
    },
    [focusedTaskId, flatTaskList, columns, onToggleComplete, onTaskClick]
  )

  useEffect(() => {
    if (!focusedTaskId && flatTaskList.length > 0) {
      setFocusedTaskId(flatTaskList[0].taskId)
    }
  }, []) // Only on mount

  return (
    <div
      ref={boardRef}
      className="flex h-full flex-col outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Kanban board"
    >
      <ScrollArea className="h-full">
        <div className="flex gap-3 p-4 pb-8 h-full">
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              tasks={tasksByColumn.get(column.id) || []}
              allTasks={tasks}
              projects={projects}
              focusedTaskId={focusedTaskId}
              isSelectionMode={isSelectionMode}
              selectedIds={selectedIds}
              onTaskClick={onTaskClick}
              onToggleComplete={onToggleComplete}
              onToggleSelect={onToggleSelect}
              onQuickAdd={onQuickAdd}
              showProjectBadge={showProjectBadge}
            />
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      <KanbanDragOverlay projects={projects} allTasks={tasks} />
    </div>
  )
}
