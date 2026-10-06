/**
 * "Show Tasks" on a sidebar folder or note: opens Tasks filtered to the tasks
 * filed there. Shared by both notes-tree renderers so the two menus cannot
 * drift. The filter it sets is the same Location filter the Tasks filter menu
 * offers, so the user can widen or clear it there.
 */

import { CheckSquare } from '@/lib/icons'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useTabActions } from '@/contexts/tabs'
import { tasksTabForLocation } from '@/lib/tasks-location-tab'
import { useT } from '@memry/i18n/renderer'

interface ShowTasksMenuItemProps {
  location: { folderPath: string } | { noteId: string }
}

export function ShowTasksMenuItem({ location }: ShowTasksMenuItemProps): React.JSX.Element {
  const { t } = useT('notes')
  const { openTab } = useTabActions()

  return (
    // Titled 'Tasks' like the other Tasks tabs the sidebar opens.
    <ContextMenuItem onClick={() => openTab(tasksTabForLocation(location, 'Tasks'))}>
      <CheckSquare className="me-2 h-4 w-4" />
      {t('tree.actions.showTasks')}
    </ContextMenuItem>
  )
}
