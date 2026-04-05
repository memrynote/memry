import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTaskBlockData } from './use-task-block-data'
import { useTasksOptional } from '@/contexts/tasks'
import { tasksService } from '@/services/tasks-service'
import type { Priority } from '@/data/sample-tasks'
import { defaultStatuses, type Status } from '@/data/tasks-data'
import { InlineStatusPopover } from '@/components/tasks/inline-status-popover'
import { InlinePriorityPopover } from '@/components/tasks/inline-priority-popover'
import { formatDueDate } from '@/lib/task-utils/task-formatting'

interface TaskBlockRendererProps {
  block: { id: string; props: { taskId: string; title: string; checked: boolean } }
  editor: any
  contentRef: React.Ref<HTMLDivElement>
}

const DB_PRIORITY_MAP: Record<number, Priority> = {
  0: 'none',
  1: 'low',
  2: 'medium',
  3: 'high',
  4: 'urgent'
}

const PRIORITY_REVERSE: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

export const TaskBlockRenderer: FC<TaskBlockRendererProps> = ({ block, editor, contentRef }) => {
  const { taskId, title, checked } = block.props
  const { task, isLoading, isDeleted } = useTaskBlockData(taskId)
  const tasksCtx = useTasksOptional()
  const syncingRef = useRef(false)

  const [isEditingTitle, setIsEditingTitle] = useState(true)
  const [editTitle, setEditTitle] = useState(title)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const displayTitle = task?.title ?? title
  const isCompleted = task ? !!task.completedAt : checked

  const priorityNum =
    typeof task?.priority === 'number'
      ? task.priority
      : typeof task?.priority === 'string'
        ? (PRIORITY_REVERSE[task.priority] ?? 0)
        : 0
  const priority: Priority = DB_PRIORITY_MAP[priorityNum] ?? 'none'

  const projects = tasksCtx?.projects ?? []
  const project = projects.find((p) => p.id === task?.projectId)
  const statuses: Status[] = (project?.statuses as Status[]) ?? defaultStatuses
  const statusId = task?.statusId ?? statuses[0]?.id ?? ''

  const dueDate = task?.dueDate ? new Date(task.dueDate) : null
  const dueTime = (task as any)?.dueTime ?? null
  const formattedDate = formatDueDate(dueDate, dueTime)
  const isOverdue = formattedDate?.status === 'overdue' && !isCompleted

  const currentStatus = statuses.find((s) => s.id === statusId)
  const statusColor = currentStatus?.color || '#6B7280'

  const dueDateDisplay = (() => {
    if (isCompleted) return { text: 'Done', colorStyle: statusColor }
    if (!formattedDate) return null
    if (isOverdue) return { text: formattedDate.label, colorClass: 'text-destructive' }
    return { text: formattedDate.label, colorClass: 'text-text-tertiary' }
  })()

  // Sync block props with DB
  useEffect(() => {
    if (!task || syncingRef.current) return
    const needsUpdate =
      task.title !== block.props.title || !!task.completedAt !== block.props.checked
    if (needsUpdate) {
      syncingRef.current = true
      editor.updateBlock(block, {
        props: { ...block.props, title: task.title, checked: !!task.completedAt }
      })
      if (!isEditingTitle) setEditTitle(task.title)
      syncingRef.current = false
    }
  }, [task, block, editor, isEditingTitle])

  // Title editing
  const saveTitleToDb = useCallback(
    async (newTitle: string) => {
      if (!taskId || !newTitle.trim()) return
      editor.updateBlock(block, { props: { ...block.props, title: newTitle.trim() } })
      await tasksService.update({ id: taskId, title: newTitle.trim() })
    },
    [taskId, block, editor]
  )

  const handleTitleChange = useCallback(
    (value: string) => {
      setEditTitle(value)
      if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
      titleSaveTimeoutRef.current = setTimeout(() => void saveTitleToDb(value), 600)
    },
    [saveTitleToDb]
  )

  const handleTitleBlur = useCallback(() => {
    if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
    if (editTitle.trim()) void saveTitleToDb(editTitle)
    setIsEditingTitle(false)
  }, [editTitle, saveTitleToDb])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleTitleBlur()
      }
    },
    [handleTitleBlur]
  )

  const handleTitleClick = useCallback(() => {
    setIsEditingTitle(true)
    setEditTitle(displayTitle)
    setTimeout(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.setSelectionRange(
        titleInputRef.current.value.length,
        titleInputRef.current.value.length
      )
    }, 0)
  }, [displayTitle])

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.setSelectionRange(
        titleInputRef.current.value.length,
        titleInputRef.current.value.length
      )
    }
  }, [isEditingTitle])

  useEffect(() => {
    return () => {
      if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
    }
  }, [])

  // Status change
  const handleStatusChange = useCallback(
    async (newStatusId: string) => {
      if (!taskId) return
      await tasksService.update({ id: taskId, statusId: newStatusId })
    },
    [taskId]
  )

  const handleToggleComplete = useCallback(async () => {
    if (!taskId) return
    const newChecked = !isCompleted
    editor.updateBlock(block, { props: { ...block.props, checked: newChecked } })
    if (newChecked) {
      await tasksService.complete({ id: taskId })
    } else {
      await tasksService.uncomplete(taskId)
    }
  }, [taskId, isCompleted, block, editor])

  // Priority change
  const handlePriorityChange = useCallback(
    async (newPriority: Priority) => {
      if (!taskId) return
      await tasksService.update({ id: taskId, priority: PRIORITY_REVERSE[newPriority] ?? 0 })
    },
    [taskId]
  )

  const handleRemoveGhost = useCallback(() => {
    editor.removeBlocks([block])
  }, [block, editor])

  // Loading state
  if (!taskId) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className="flex items-center gap-3 rounded-md border border-dashed border-stone-300 px-6 py-[7px] text-sm text-muted-foreground dark:border-stone-600"
      >
        <Loader2 className="size-4 animate-spin" />
        Creating task...
      </div>
    )
  }

  // Ghost state
  if (isDeleted) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className="flex items-center gap-3 rounded-md bg-stone-100 px-6 py-[7px] text-sm text-muted-foreground opacity-60 dark:bg-stone-800/50"
      >
        <AlertTriangle className="size-4 text-amber-500" />
        <span className="line-through">{displayTitle}</span>
        <span className="text-xs">Task deleted</span>
        <button
          type="button"
          onClick={handleRemoveGhost}
          className="ml-auto rounded p-0.5 hover:bg-stone-200 dark:hover:bg-stone-700"
        >
          <X className="size-3" />
        </button>
      </div>
    )
  }

  return (
    <div
      ref={contentRef}
      contentEditable={false}
      className={cn(
        'group flex items-center gap-3 rounded-md py-[7px] px-6 transition-colors outline-none [&_*]:outline-none',
        'hover:bg-accent/60'
      )}
    >
      <style>{`
        .bn-formatting-toolbar:empty { display: none !important; }
        .bn-block-content[data-content-type="taskBlock"] { cursor: default; }
        .bn-block[data-id]:has([data-content-type="taskBlock"]) { border: none !important; outline: none !important; box-shadow: none !important; }
        .bn-block[data-id]:has([data-content-type="taskBlock"]):focus-within { border: none !important; outline: none !important; box-shadow: none !important; }
        .bn-block-content[data-content-type="taskBlock"]:focus { outline: none !important; border: none !important; }
        [data-content-type="taskBlock"] * { outline: none !important; }
      `}</style>

      {/* Status (cycles through project statuses) */}
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <InlineStatusPopover
          statusId={statusId}
          statuses={statuses}
          isCompleted={isCompleted}
          onStatusChange={handleStatusChange}
          onToggleComplete={handleToggleComplete}
        />
      </div>

      {/* Priority */}
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        <InlinePriorityPopover priority={priority} onPriorityChange={handlePriorityChange} />
      </div>

      {/* Title — editable */}
      {isEditingTitle ? (
        <input
          ref={titleInputRef}
          type="text"
          value={editTitle}
          onChange={(e) => handleTitleChange(e.target.value)}
          onBlur={handleTitleBlur}
          onKeyDown={handleTitleKeyDown}
          className={cn(
            'grow shrink min-w-0 bg-transparent text-[13px] font-medium outline-none',
            'text-foreground/90 placeholder:text-muted-foreground'
          )}
          placeholder="Task name..."
        />
      ) : (
        <span
          onClick={handleTitleClick}
          className={cn(
            'grow shrink min-w-0 truncate text-[13px] font-medium cursor-text',
            isCompleted
              ? 'text-muted-foreground/60 line-through decoration-1 [text-underline-position:from-font]'
              : 'text-foreground/90'
          )}
        >
          {displayTitle || 'Untitled task'}
        </span>
      )}

      {project && (
        <div className="flex items-center shrink-0 gap-[5px]">
          <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: project.color }} />
          <div className="text-[11px] text-text-tertiary leading-3.5 truncate max-w-[100px]">
            {project.name}
          </div>
        </div>
      )}

      {/* Due date — right side */}
      {dueDateDisplay && (
        <div
          className={cn(
            'text-[11px] shrink-0 text-right leading-3.5 whitespace-nowrap',
            'colorClass' in dueDateDisplay && dueDateDisplay.colorClass
          )}
          style={'colorStyle' in dueDateDisplay ? { color: dueDateDisplay.colorStyle } : undefined}
        >
          {dueDateDisplay.text}
        </div>
      )}

      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new CustomEvent('task-block:open-detail', { detail: { taskId } }))
        }}
        className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent/80"
        title="Open in task panel"
      >
        <ArrowUpRight className="size-3 text-muted-foreground" />
      </button>

      {isLoading && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
    </div>
  )
}
