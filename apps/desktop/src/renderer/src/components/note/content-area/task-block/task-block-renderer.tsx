import { type FC, useCallback, useEffect, useRef } from 'react'
import { Check, AlertTriangle, Loader2, X } from 'lucide-react'
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

export const TaskBlockRenderer: FC<TaskBlockRendererProps> = ({ block, editor, contentRef }) => {
  const { taskId, title, checked } = block.props
  const { task, isLoading, isDeleted } = useTaskBlockData(taskId)
  const tasksCtx = useTasksOptional()
  const syncingRef = useRef(false)

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

  if (!taskId) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className="flex items-center gap-2 rounded-md border border-dashed border-stone-300 dark:border-stone-600 px-3 py-2 text-sm text-muted-foreground"
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
        className="flex items-center gap-2 rounded-md bg-stone-100 dark:bg-stone-800/50 px-3 py-2 text-sm text-muted-foreground opacity-60"
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
        ? (({ none: 0, low: 1, medium: 2, high: 3, urgent: 4 } as Record<string, number>)[
            task.priority
          ] ?? 0)
        : 0
  const priorityKey = DB_PRIORITY_MAP[priorityNum] ?? 'none'
  const priorityVars = PRIORITY_CSS_VARS[priorityKey]

  const projectName = tasksCtx?.projects?.find((p) => p.id === task?.projectId)?.name

  const dueDate = task?.dueDate ? new Date(task.dueDate) : null
  const isOverdue = dueDate instanceof Date && dueDate < new Date() && !displayChecked

  const formatDue = (d: Date | null): string | null => {
    if (!d || !(d instanceof Date)) return null
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <div
      ref={contentRef}
      contentEditable={false}
      className={cn(
        'group my-0.5 flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors',
        'hover:bg-stone-50 dark:hover:bg-stone-800/50',
        displayChecked && 'opacity-60'
      )}
    >
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

      <button
        type="button"
        onClick={handleTitleClick}
        className={cn(
          'cursor-pointer text-left text-sm font-medium hover:underline',
          displayChecked && 'text-muted-foreground line-through'
        )}
      >
        {displayTitle}
      </button>

      <div className="ml-auto flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        {priorityVars && (
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: priorityVars.text }}
            title={priorityKey}
          />
        )}
        {formatDue(dueDate) && (
          <span
            className={cn(
              'text-[11px] tabular-nums',
              isOverdue ? 'font-medium text-red-500' : 'text-muted-foreground'
            )}
          >
            {formatDue(dueDate)}
          </span>
        )}
        {projectName && <span className="text-[11px] text-muted-foreground">{projectName}</span>}
      </div>

      {isLoading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
    </div>
  )
}
