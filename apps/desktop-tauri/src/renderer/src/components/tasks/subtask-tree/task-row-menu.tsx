import { useT } from '@memry/i18n/renderer'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  CornerDownRight,
  Move,
  PanelRight,
  Plus,
  RotateCcw,
  Trash2,
  ZoomIn
} from '@/lib/icons'
import type { Task } from '@/data/task-model'
import { useSubtaskTree } from './subtask-tree-context'
import { useTaskExpansion } from './task-expansion-context'

interface TaskContextMenuProps {
  task: Task
  /** False for drag overlays, which are pictures of a row and take no input. */
  enabled?: boolean
  /** False where the row has no inline draft to open (kanban cards). */
  canDraft?: boolean
  /** The sibling drawn directly above, when the host knows it: "Indent" nests under it. */
  rowAbove?: Task
  children: React.ReactNode
}

/**
 * The right-click menu of a task row: every action on the task and its place
 * in the tree, each with the shortcut it also has, so neither has to be known
 * to find the other. Without a subtask tree provider the row has no menu.
 */
export const TaskRowMenu = ({
  task,
  enabled = true,
  canDraft = true,
  rowAbove,
  children
}: TaskContextMenuProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const tree = useSubtaskTree()
  const expansion = useTaskExpansion()
  if (!tree || !enabled) return <>{children}</>

  const isDone = task.completedAt !== null
  const hasChildren = task.subtaskIds.length > 0
  const grandparentId = task.parentId ? tree.parentOf(task.parentId) : null
  const canAdd = canDraft && tree.canAddUnder(task.id)
  const canIndent = rowAbove !== undefined && tree.canMoveUnder(task.id, rowAbove.id)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="contents">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60" data-testid="task-context-menu">
        <ContextMenuItem onSelect={() => tree.openTask(task.id)}>
          <PanelRight />
          {t('subtaskTree.menu.open')}
          <ContextMenuShortcut>↵</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => tree.toggleComplete(task.id)}>
          {isDone ? <RotateCcw /> : <CheckCircle2 />}
          {isDone ? t('subtaskTree.menu.reopen') : t('subtaskTree.menu.complete')}
        </ContextMenuItem>

        <ContextMenuSeparator />

        {canAdd && (
          <ContextMenuItem
            onSelect={() => {
              expansion?.expand(task.id)
              tree.openDraft(task.id)
            }}
          >
            <Plus />
            {t('subtaskTree.addSubtask')}
          </ContextMenuItem>
        )}
        {hasChildren && (
          <ContextMenuItem onSelect={() => tree.zoomInto(task.id)}>
            <ZoomIn />
            {t('subtaskTree.menu.zoom')}
            <ContextMenuShortcut>⌘↵</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => tree.openMoveUnder(task.id)}>
          <Move />
          {t('subtaskTree.menu.moveUnder')}
          <ContextMenuShortcut>⇧M</ContextMenuShortcut>
        </ContextMenuItem>
        {canIndent && rowAbove && (
          <ContextMenuItem
            onSelect={() => {
              expansion?.expand(rowAbove.id)
              tree.moveUnder(task.id, rowAbove.id)
            }}
          >
            <CornerDownRight />
            {t('subtaskTree.menu.indent', { title: rowAbove.title })}
          </ContextMenuItem>
        )}
        {task.parentId && grandparentId && (
          <ContextMenuItem onSelect={() => tree.moveUnder(task.id, grandparentId)}>
            <ArrowLeft />
            {t('subtaskTree.menu.outdent')}
          </ContextMenuItem>
        )}
        {task.parentId && (
          <ContextMenuItem onSelect={() => tree.moveUnder(task.id, null)}>
            <ArrowUp />
            {t('subtaskTree.menu.topLevel')}
          </ContextMenuItem>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem variant="destructive" onSelect={() => tree.deleteTask(task.id)}>
          <Trash2 />
          {t('subtaskTree.menu.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
