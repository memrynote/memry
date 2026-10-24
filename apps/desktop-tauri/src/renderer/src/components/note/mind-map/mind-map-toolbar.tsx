/**
 * The map's own controls.
 *
 * Deliberately NOT the note's overflow menu: that menu stays the note's menu in
 * both modes, because the same button in the same place doing different work
 * depending on the mode is exactly how someone deletes a note by accident. The
 * map's actions live in the map.
 *
 * Presentational only — it takes a list of actions and draws them. It imports
 * nothing from the drawing library, so it stays in the main renderer bundle and
 * renders in a plain test without pulling a canvas chunk in. The list is data
 * rather than fixed props so a later action (saving the map as a canvas) is one
 * more entry, not a new prop and a new slot.
 *
 * A flex row above the drawing rather than a corner overlay: the drawing
 * library pins its own islands to the physical corners and does not mirror them
 * for an RTL app, so a pinned control cluster would collide with them in one
 * reading direction or the other. A row lets `justify-end` follow the reading
 * direction on its own, with nothing to overlap.
 */

import { Button } from '@/components/ui/button'
import type { AppIcon } from '@/lib/icons'

export interface MindMapToolbarAction {
  /** Stable within the toolbar; also the control's test id suffix. */
  id: string
  /** Translated. Used as both the tooltip and the accessible name. */
  label: string
  icon: AppIcon
  onSelect: () => void
  /** True while the drawing surface has not handed its controls up yet. */
  disabled?: boolean
}

interface MindMapToolbarProps {
  actions: readonly MindMapToolbarAction[]
  /** Translated; names the group for a screen reader. */
  label: string
}

export function MindMapToolbar({ actions, label }: MindMapToolbarProps): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      data-testid="mind-map-toolbar"
      className="flex flex-none items-center justify-end gap-0.5 px-3 py-2"
    >
      {actions.map((action) => (
        <Button
          key={action.id}
          variant="ghost"
          size="icon-sm"
          onClick={action.onSelect}
          disabled={action.disabled}
          title={action.label}
          aria-label={action.label}
          data-testid={`mind-map-toolbar-${action.id}`}
        >
          <action.icon className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      ))}
    </div>
  )
}
