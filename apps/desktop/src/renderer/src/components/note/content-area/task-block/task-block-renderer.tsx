import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { Check, AlertTriangle, Loader2, X, Calendar, Flag, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTaskBlockData } from './use-task-block-data'
import { useTasksOptional } from '@/contexts/tasks'
import { tasksService } from '@/services/tasks-service'
import { PRIORITY_CSS_VARS, type Priority } from '@/data/sample-tasks'

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

const PRIORITY_NUM_MAP: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4
}

const PRIORITY_OPTIONS: { value: number; label: string; color: string | null }[] = [
  { value: 0, label: 'None', color: null },
  { value: 1, label: 'Low', color: 'var(--task-priority-low)' },
  { value: 2, label: 'Medium', color: 'var(--task-priority-medium)' },
  { value: 3, label: 'High', color: 'var(--task-priority-high)' },
  { value: 4, label: 'Urgent', color: 'var(--task-priority-urgent)' }
]

export const TaskBlockRenderer: FC<TaskBlockRendererProps> = ({ block, editor, contentRef }) => {
  const { taskId, title, checked } = block.props
  const { task, isLoading, isDeleted } = useTaskBlockData(taskId)
  const tasksCtx = useTasksOptional()
  const syncingRef = useRef(false)

  const [showPriorityPicker, setShowPriorityPicker] = useState(false)
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const dateInputRef = useRef<HTMLInputElement>(null)

  const displayTitle = task?.title ?? title
  const displayChecked = task ? !!task.completedAt : checked

  useEffect(() => {
    if (!task || syncingRef.current) return
    const needsUpdate =
      task.title !== block.props.title || !!task.completedAt !== block.props.checked
    if (needsUpdate) {
      syncingRef.current = true
      editor.updateBlock(block, {
        props: {
          ...block.props,
          title: task.title,
          checked: !!task.completedAt
        }
      })
      syncingRef.current = false
    }
  }, [task, block, editor])

  const handleToggle = useCallback(async () => {
    if (!taskId) return
    const newChecked = !displayChecked
    editor.updateBlock(block, { props: { ...block.props, checked: newChecked } })
    if (newChecked) {
      await tasksService.complete({ id: taskId })
    } else {
      await tasksService.uncomplete(taskId)
    }
  }, [taskId, displayChecked, block, editor])

  const handleRemoveGhost = useCallback(() => {
    editor.removeBlocks([block])
  }, [block, editor])

  const handleTitleClick = useCallback(() => {
    if (taskId) {
      window.dispatchEvent(new CustomEvent('task-block:open-detail', { detail: { taskId } }))
    }
  }, [taskId])

  const handlePriorityChange = useCallback(
    async (value: number) => {
      if (!taskId) return
      setShowPriorityPicker(false)
      await tasksService.update({ id: taskId, priority: value })
    },
    [taskId]
  )

  const handleProjectChange = useCallback(
    async (projectId: string) => {
      if (!taskId) return
      setShowProjectPicker(false)
      await tasksService.update({ id: taskId, projectId })
    },
    [taskId]
  )

  const handleDueDateChange = useCallback(
    async (dateStr: string) => {
      if (!taskId) return
      setShowDatePicker(false)
      await tasksService.update({ id: taskId, dueDate: dateStr || null })
    },
    [taskId]
  )

  if (!taskId) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className="flex items-center gap-2 rounded-md border border-dashed border-stone-300 px-3 py-2 text-sm text-muted-foreground dark:border-stone-600"
      >
        <Loader2 className="size-4 animate-spin" />
        Creating task...
      </div>
    )
  }

  if (isDeleted) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className="flex items-center gap-2 rounded-md bg-stone-100 px-3 py-2 text-sm text-muted-foreground opacity-60 dark:bg-stone-800/50"
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

  const priorityNum =
    typeof task?.priority === 'number'
      ? task.priority
      : typeof task?.priority === 'string'
        ? (PRIORITY_NUM_MAP[task.priority] ?? 0)
        : 0
  const priorityKey = DB_PRIORITY_MAP[priorityNum] ?? 'none'
  const priorityVars = PRIORITY_CSS_VARS[priorityKey]

  const projects = tasksCtx?.projects ?? []
  const projectName = projects.find((p) => p.id === task?.projectId)?.name ?? 'Inbox'

  const dueDate = task?.dueDate ? new Date(task.dueDate) : null
  const isOverdue = dueDate instanceof Date && dueDate < new Date() && !displayChecked

  const formatDue = (d: Date | null): string => {
    if (!d || !(d instanceof Date)) return 'No date'
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const dueDateIso = task?.dueDate
    ? typeof task.dueDate === 'string'
      ? task.dueDate.slice(0, 10)
      : ''
    : ''

  return (
    <div
      ref={contentRef}
      contentEditable={false}
      className={cn(
        'my-0.5 flex items-center gap-2 rounded-md border border-stone-200 px-3 py-1.5 transition-colors dark:border-stone-700/50',
        'hover:bg-stone-50 dark:hover:bg-stone-800/50',
        displayChecked && 'opacity-50'
      )}
    >
      {/* Checkbox */}
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          'flex size-[18px] shrink-0 items-center justify-center rounded border transition-colors',
          displayChecked
            ? 'border-tint bg-tint text-white'
            : 'border-stone-300 hover:border-tint dark:border-stone-600'
        )}
        aria-label={displayChecked ? 'Mark incomplete' : 'Mark complete'}
      >
        {displayChecked && <Check className="size-3" strokeWidth={3} />}
      </button>

      {/* Title */}
      <button
        type="button"
        onClick={handleTitleClick}
        className={cn(
          'min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline',
          displayChecked && 'text-muted-foreground line-through'
        )}
      >
        {displayTitle}
      </button>

      {/* Inline controls — always visible */}
      <div className="flex shrink-0 items-center gap-1">
        {/* Priority */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowPriorityPicker(!showPriorityPicker)}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
              'hover:bg-stone-100 dark:hover:bg-stone-700',
              priorityKey !== 'none' ? 'font-medium' : 'text-muted-foreground'
            )}
            title="Priority"
          >
            {priorityVars ? (
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: priorityVars.text }}
              />
            ) : (
              <Flag className="size-3 text-stone-400" />
            )}
            <span className="hidden sm:inline">{priorityKey === 'none' ? '' : priorityKey}</span>
          </button>
          {showPriorityPicker && (
            <div className="absolute right-0 top-full z-50 mt-1 rounded-md border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-800">
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handlePriorityChange(opt.value)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-xs transition-colors',
                    'hover:bg-stone-100 dark:hover:bg-stone-700',
                    priorityNum === opt.value && 'bg-stone-100 dark:bg-stone-700'
                  )}
                >
                  {opt.color ? (
                    <span className="size-2 rounded-full" style={{ backgroundColor: opt.color }} />
                  ) : (
                    <span className="size-2 rounded-full bg-stone-300 dark:bg-stone-600" />
                  )}
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Due date */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setShowDatePicker(!showDatePicker)
              setTimeout(() => dateInputRef.current?.showPicker?.(), 50)
            }}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors',
              'hover:bg-stone-100 dark:hover:bg-stone-700',
              isOverdue
                ? 'font-medium text-red-500'
                : dueDate
                  ? 'text-foreground'
                  : 'text-muted-foreground'
            )}
            title="Due date"
          >
            <Calendar className="size-3" />
            <span className="tabular-nums">{formatDue(dueDate)}</span>
          </button>
          {showDatePicker && (
            <div className="absolute right-0 top-full z-50 mt-1">
              <input
                ref={dateInputRef}
                type="date"
                value={dueDateIso}
                onChange={(e) => handleDueDateChange(e.target.value)}
                onBlur={() => setShowDatePicker(false)}
                className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs shadow-lg dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          )}
        </div>

        {/* Project */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowProjectPicker(!showProjectPicker)}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors',
              'hover:bg-stone-100 dark:hover:bg-stone-700'
            )}
            title="Project"
          >
            <Folder className="size-3" />
            <span className="max-w-[60px] truncate">{projectName}</span>
          </button>
          {showProjectPicker && (
            <div className="absolute right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-800">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleProjectChange(p.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1 text-xs transition-colors',
                    'hover:bg-stone-100 dark:hover:bg-stone-700',
                    task?.projectId === p.id && 'bg-stone-100 dark:bg-stone-700'
                  )}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {isLoading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
    </div>
  )
}
