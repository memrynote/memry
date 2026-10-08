import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useT } from '@memry/i18n/renderer'

import { cn } from '@/lib/utils'
import { InteractiveStatusIcon } from '@/components/tasks/status-icon'
import { ExpandChevron } from '@/components/tasks/expand-chevron'
import { SubtaskProgressIndicator } from '@/components/tasks/subtask-progress-indicator'
import { AddSubtaskButton } from '@/components/tasks/subtask-tree/add-subtask-button'
import { useSubtaskTree } from '@/components/tasks/subtask-tree/subtask-tree-context'
import type { SubtaskProgress } from '@/lib/subtask-utils'
import type { Task } from '@/data/task-model'
import type { Status } from '@/data/tasks-data'

/** What a sideways drag will do on drop, shown on the dragged row. */
export type SubtaskDropProjection = { kind: 'nest'; parentTitle: string } | { kind: 'out' } | null

interface SortableSubtaskRowProps {
  subtask: Task
  statuses: Status[]
  parentId: string
  /** 1 for a first-level subtask. */
  depth: number
  progress: SubtaskProgress
  isExpanded: boolean
  onToggleExpand?: (taskId: string) => void
  projection?: SubtaskDropProjection
  onToggleComplete: (taskId: string) => void
  onClick?: (taskId: string) => void
  className?: string
}

export const SortableSubtaskRow = ({
  subtask,
  statuses,
  parentId,
  depth,
  progress,
  isExpanded,
  onToggleExpand,
  projection = null,
  onToggleComplete,
  onClick,
  className
}: SortableSubtaskRowProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const tree = useSubtaskTree()
  const isCompleted = !!subtask.completedAt
  const isContext = tree?.contextIds.has(subtask.id) ?? false
  const hasChildren = subtask.subtaskIds.length > 0
  const status = statuses.find((s) => s.id === subtask.statusId)
  const doneStatus = statuses.find((s) => s.type === 'done')
  const statusType = isCompleted
    ? 'done'
    : ((status?.type ?? 'todo') as 'todo' | 'in_progress' | 'done')
  const statusColor = isCompleted
    ? (doneStatus?.color ?? status?.color ?? 'var(--text-tertiary)')
    : (status?.color ?? 'var(--text-tertiary)')

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: subtask.id,
    data: { type: 'subtask', subtask, parentId, sourceType: 'subtask-list' }
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 200ms ease-out'
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && tree && hasChildren) {
      e.preventDefault()
      e.stopPropagation()
      tree.zoomInto(subtask.id)
      return
    }
    if (e.shiftKey && (e.key === 'M' || e.key === 'm') && tree) {
      e.preventDefault()
      e.stopPropagation()
      tree.openMoveUnder(subtask.id)
      return
    }
    if (e.key === 'Enter' && onClick) {
      e.preventDefault()
      onClick(subtask.id)
      return
    }
    if (hasChildren && onToggleExpand) {
      if (e.key === 'ArrowRight' && !isExpanded) {
        e.preventDefault()
        onToggleExpand(subtask.id)
      } else if (e.key === 'ArrowLeft' && isExpanded) {
        e.preventDefault()
        onToggleExpand(subtask.id)
      }
    }
  }

  return (
    <div ref={setNodeRef} style={style} className={cn('group/subtask relative', className)}>
      <div
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={onClick ? 0 : -1}
        onClick={() => onClick?.(subtask.id)}
        onKeyDown={handleKeyDown}
        data-testid="subtask-row"
        data-task-id={subtask.id}
        data-depth={depth}
        className={cn(
          'group/addable flex items-center gap-1 py-1.5 pe-3',
          depth === 1 ? 'ps-6' : 'ps-1',
          'hover:bg-muted rounded-e-sm',
          'transition-colors duration-150',
          onClick && 'focus-visible:outline-none focus-visible:bg-muted',
          isDragging
            ? 'cursor-grabbing opacity-50 shadow-lg ring-2 ring-primary bg-background z-10'
            : ''
        )}
        aria-label={`Subtask: ${subtask.title}${isCompleted ? ', completed' : ''}`}
      >
        <span className="flex w-4 shrink-0 items-center justify-center">
          <ExpandChevron
            isExpanded={isExpanded}
            hasSubtasks={hasChildren && !!onToggleExpand}
            onClick={() => onToggleExpand?.(subtask.id)}
            size="sm"
          />
        </span>

        <span className="flex min-w-0 grow items-center gap-2">
          <span onClick={(e) => e.stopPropagation()} className="flex shrink-0">
            <InteractiveStatusIcon
              type={statusType}
              color={statusColor}
              isCompleted={isCompleted}
              onClick={() => onToggleComplete(subtask.id)}
            />
          </span>

          <span
            className={cn(
              'text-[13px] font-medium truncate',
              isCompleted
                ? 'line-through text-muted-foreground/60 decoration-1'
                : isContext
                  ? 'text-text-tertiary'
                  : 'text-foreground/90'
            )}
          >
            {subtask.title}
          </span>
        </span>

        {projection && (
          <span
            className="shrink-0 rounded-sm bg-foreground px-1.5 py-0.5 text-[11px]/3.5 text-background"
            data-testid="subtask-drop-projection"
          >
            {projection.kind === 'nest'
              ? t('subtaskTree.dropInto', { title: projection.parentTitle })
              : t('subtaskTree.dropOut')}
          </span>
        )}

        {hasChildren && (
          <SubtaskProgressIndicator completed={progress.completed} total={progress.total} />
        )}

        <AddSubtaskButton taskId={subtask.id} />
      </div>
    </div>
  )
}

export default SortableSubtaskRow
