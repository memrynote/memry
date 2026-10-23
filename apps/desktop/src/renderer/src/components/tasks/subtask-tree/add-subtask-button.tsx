import { useT } from '@memry/i18n/renderer'

import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useSubtaskTree } from './subtask-tree-context'
import { useTaskExpansion } from './task-expansion-context'

interface AddSubtaskButtonProps {
  taskId: string
  className?: string
}

/**
 * The row's hover "+": opens a draft subtask under the row, expanding it first
 * so the draft lands below the existing subtasks.
 */
export const AddSubtaskButton = ({
  taskId,
  className
}: AddSubtaskButtonProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const tree = useSubtaskTree()
  const expansion = useTaskExpansion()
  if (!tree || !tree.canAddUnder(taskId)) return null

  const handleClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    expansion?.expand(taskId)
    tree.openDraft(taskId)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={t('subtaskTree.addSubtask')}
      title={t('subtaskTree.addSubtask')}
      data-testid="add-subtask-button"
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-sm text-text-tertiary',
        'opacity-0 transition-opacity group-hover/addable:opacity-100',
        'hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100',
        className
      )}
    >
      <Plus className="size-3.5" />
    </button>
  )
}
