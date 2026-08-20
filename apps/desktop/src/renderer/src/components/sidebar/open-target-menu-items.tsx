/**
 * OpenTargetMenuItems
 *
 * The "Open in New Tab" / "Open to the Side" pair, shared by every sidebar row
 * that opens a tab — notes, folders, canvases, canvas folders, projects, tags,
 * bookmarks and the top-level nav.
 *
 * These live at the top of each menu, above the item's own commands: opening is
 * the most frequent thing you do to a sidebar row, and it is where both browsers
 * and editors put it.
 */

import { ArrowUpRight, Columns2 } from '@/lib/icons'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useOpenTarget } from '@/hooks/use-open-target'
import type { OpenTargetTab } from '@/hooks/use-open-target'
import { useT } from '@memry/i18n/renderer'

/**
 * The menu-item shape these rows render as. Radix items read their own menu's
 * context, so a `ContextMenuItem` placed inside a DropdownMenu throws — the
 * surrounding menu picks the component, same contract as BookmarkMenuItem.
 */
type OpenTargetMenuItemComponent = React.ComponentType<{
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void
  children?: React.ReactNode
}>

interface OpenTargetMenuItemsProps {
  /** The tab this row would open, exactly as a plain click would build it. */
  tab: OpenTargetTab
  /** Defaults to the context-menu item, which is where these rows started life. */
  component?: OpenTargetMenuItemComponent
}

export function OpenTargetMenuItems({
  tab,
  component: Item = ContextMenuItem
}: OpenTargetMenuItemsProps): React.JSX.Element {
  const { t } = useT('notes')
  const { openInNewTab, openToTheSide } = useOpenTarget()

  return (
    <>
      {/* Singletons (Home, Inbox, Calendar, …) used to hide this row; since
          #1644 an explicit "Open in New Tab" mints a genuine second copy for
          them too — the command is never inert, so it is never hidden. */}
      <Item onClick={() => openInNewTab(tab)}>
        <ArrowUpRight className="me-2 h-4 w-4" />
        {t('tree.actions.openInNewTab')}
      </Item>
      <Item onClick={() => openToTheSide(tab)}>
        <Columns2 className="me-2 h-4 w-4" />
        {t('tree.actions.openToTheSide')}
      </Item>
    </>
  )
}

export default OpenTargetMenuItems
