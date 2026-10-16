import { useCallback } from 'react'
import type { CommandIdsOf } from '@memry/contracts/commands'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands, type CommandImpl } from '@/commands'
import { useActiveTab, useTabActions } from '@/contexts/tabs'
import { TASKS_VIEW_STATE_KEYS } from '../tasks-view-state'

export type TasksCommandId = CommandIdsOf<'tasks'>

interface TasksCommandInput {
  hasSelection: boolean
  bulkComplete: () => void | Promise<void>
  /** Opens the page's confirm dialog. Deleting itself waits for its confirm. */
  openBulkDelete: () => void
}

/**
 * The owner of every `tasks.*` command, registered per tab. The bulk commands
 * run what the floating bulk bar and its ⌘Enter / ⌘⌫ keys run, and exist only
 * while tasks are selected. Returns `focusQuickAdd`, which the empty state's
 * "Add task" button runs too.
 */
export function useTasksCommands(input: TasksCommandInput): { focusQuickAdd: () => void } {
  const { t } = useT('tasks')
  const { saveTabState } = useTabActions()
  const activeTab = useActiveTab()

  // A direct tab write: the nonce is stamped by OTHER surfaces (the sidebar's
  // "Tasks" click, the empty state's "Add task") and is read live off the tab,
  // which a `useState`-shaped hook does not do.
  const focusQuickAdd = useCallback(() => {
    if (!activeTab?.id) return
    saveTabState(activeTab.id, {
      viewState: { [TASKS_VIEW_STATE_KEYS.focusQuickAddAt]: Date.now() }
    })
  }, [activeTab?.id, saveTabState])

  const commands: Record<TasksCommandId, CommandImpl> = {
    'tasks.newTask': { label: t('quickAdd.label'), run: focusQuickAdd },
    'tasks.bulkComplete': { enabled: input.hasSelection, run: input.bulkComplete },
    'tasks.bulkDelete': { enabled: input.hasSelection, run: input.openBulkDelete }
  }

  useTabCommands('tasks', commands)
  return { focusQuickAdd }
}
