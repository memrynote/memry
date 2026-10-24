import { APP_RAIL_WIDTH_PX } from '@/components/sidebar/app-rail'
import { useSidebar } from '@/components/ui/sidebar'

/** h-9 title row above the sidebar panel and the workspace surface. */
const TITLE_ROW_HEIGHT_PX = 36

/**
 * With the sidebar open, the title row above the rail and sidebar panel has no
 * element of its own, so this strip makes it drag the window (the window
 * controls paint above it). It ends where the workspace card starts: the card's
 * tab bars fill the rest of the row and drag the window themselves, and a drag
 * region painted over their no-drag tabs would eat clicks. Collapsed, the card
 * starts at the rail edge, so no strip is needed.
 */
export function WorkspaceDragStrip(): React.JSX.Element | null {
  const { state } = useSidebar()
  if (state === 'collapsed') return null

  return (
    <div
      aria-hidden="true"
      data-testid="workspace-drag-strip"
      className="drag-region pointer-events-none fixed start-0 top-0"
      style={{
        width: `calc(${APP_RAIL_WIDTH_PX}px + var(--sidebar-width))`,
        height: TITLE_ROW_HEIGHT_PX
      }}
    />
  )
}
