/**
 * The canvas tree's row menu — described once, rendered twice.
 *
 * A row needs its actions in two places: a context menu, and a
 * focusable "⋯" button. The button is not a nicety. Radix opens a context menu
 * only from a native `contextmenu` event, macOS keyboards have no context-menu
 * key, and HTML5 drag and drop has no keyboard path either — so without this
 * dropdown, renaming, moving, duplicating or deleting a canvas is impossible
 * without a mouse.
 *
 * Two hand-maintained copies of a nine-item menu would drift, so the items are
 * data (`CanvasMenuEntry[]`) that each row builds ONCE and both menus render.
 * The renderers below know how to draw an entry; only the row knows what the
 * entries are.
 *
 * @module components/sidebar/canvas-tree/canvas-row-menu
 */

import * as React from 'react'
import { MoreHorizontal, type AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { BookmarkMenuItem } from '@/components/sidebar/bookmark-menu-item'
import { CANVAS_ROW_INDENT_PX } from './folder-options'

/** One row of a "Move to folder" submenu. `depth` draws the hierarchy. */
export interface CanvasMenuSubItem {
  id: string
  label: string
  depth: number
  /** The folder the item already sits in. Greyed AND inert — see below. */
  disabled: boolean
  onSelect: () => void
}

export type CanvasMenuEntry =
  | { kind: 'separator'; id: string }
  | {
      kind: 'item'
      id: string
      label: string
      icon: AppIcon
      destructive?: boolean
      onSelect: () => void
    }
  | { kind: 'bookmark'; id: string; itemType: string; itemId: string }
  | {
      kind: 'submenu'
      id: string
      label: string
      icon: AppIcon
      testId?: string
      items: CanvasMenuSubItem[]
    }

const DESTRUCTIVE_CLASS = 'text-destructive focus:text-destructive'

/** What a row knows about the overlays it owns. */
export interface RowMenuState {
  /** True while ANY menu, submenu or picker belonging to the row is on screen. */
  anyOpen: boolean
  pickerOpen: boolean
  setPickerOpen: (open: boolean) => void
  setActionsOpen: (open: boolean) => void
  setContextOpen: (open: boolean) => void
}

/**
 * Tracks every overlay a row owns, so the row can make its own shortcuts inert
 * while one is open.
 *
 * Radix portals its menus, but the content is still a React CHILD of the row,
 * and React synthetic events propagate through the React TREE rather than the
 * DOM tree — so `Delete` pressed on a menu item also reached the row's
 * `onKeyDown` and fired the destructive action the user was only navigating
 * past. Shared by both rows because a guard that covered one of them would be
 * the same bug on the other.
 */
export function useRowMenuState(): RowMenuState {
  const [pickerOpen, setPickerOpen] = React.useState(false)
  const [actionsOpen, setActionsOpen] = React.useState(false)
  const [contextOpen, setContextOpen] = React.useState(false)

  return {
    anyOpen: pickerOpen || actionsOpen || contextOpen,
    pickerOpen,
    setPickerOpen,
    setActionsOpen,
    setContextOpen
  }
}

/**
 * Both `disabled` and a guarded handler: Radix greys the item and skips it
 * during keyboard navigation, but it does not gate an `onClick` we hand it —
 * only `pointer-events: none` stops the mouse. Moving a canvas into the folder
 * it already sits in would be a no-op write that still bumps `updatedAt` and
 * syncs.
 */
function selectSubItem(item: CanvasMenuSubItem): void {
  if (!item.disabled) item.onSelect()
}

export function CanvasContextMenuBody({
  entries
}: {
  entries: CanvasMenuEntry[]
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'separator') return <ContextMenuSeparator key={entry.id} />

        if (entry.kind === 'bookmark') {
          return (
            <BookmarkMenuItem
              key={entry.id}
              itemType={entry.itemType}
              itemId={entry.itemId}
              component={ContextMenuItem}
            />
          )
        }

        if (entry.kind === 'submenu') {
          return (
            <ContextMenuSub key={entry.id}>
              <ContextMenuSubTrigger>
                <entry.icon className="me-2 h-4 w-4" />
                {entry.label}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent data-testid={entry.testId}>
                {entry.items.map((item) => (
                  <ContextMenuItem
                    key={item.id}
                    disabled={item.disabled}
                    onClick={() => selectSubItem(item)}
                  >
                    <span style={{ paddingInlineStart: `${item.depth * CANVAS_ROW_INDENT_PX}px` }}>
                      {item.label}
                    </span>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )
        }

        return (
          <ContextMenuItem
            key={entry.id}
            className={entry.destructive ? DESTRUCTIVE_CLASS : undefined}
            onClick={entry.onSelect}
          >
            <entry.icon className="me-2 h-4 w-4" />
            {entry.label}
          </ContextMenuItem>
        )
      })}
    </>
  )
}

export function CanvasDropdownMenuBody({
  entries
}: {
  entries: CanvasMenuEntry[]
}): React.JSX.Element {
  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'separator') return <DropdownMenuSeparator key={entry.id} />

        if (entry.kind === 'bookmark') {
          return (
            <BookmarkMenuItem
              key={entry.id}
              itemType={entry.itemType}
              itemId={entry.itemId}
              component={DropdownMenuItem}
            />
          )
        }

        if (entry.kind === 'submenu') {
          return (
            <DropdownMenuSub key={entry.id}>
              <DropdownMenuSubTrigger>
                <entry.icon className="me-2 h-4 w-4" />
                {entry.label}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent data-testid={entry.testId}>
                {entry.items.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    disabled={item.disabled}
                    onClick={() => selectSubItem(item)}
                  >
                    <span style={{ paddingInlineStart: `${item.depth * CANVAS_ROW_INDENT_PX}px` }}>
                      {item.label}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }

        return (
          <DropdownMenuItem
            key={entry.id}
            className={entry.destructive ? DESTRUCTIVE_CLASS : undefined}
            onClick={entry.onSelect}
          >
            <entry.icon className="me-2 h-4 w-4" />
            {entry.label}
          </DropdownMenuItem>
        )
      })}
    </>
  )
}

export interface CanvasRowActionsProps {
  /** Accessible name. Icon-only, so this is the ONLY name the control has. */
  label: string
  entries: CanvasMenuEntry[]
  /**
   * Reports the menu opening and closing.
   *
   * The row needs to know: this content is a React CHILD of the row, and React
   * synthetic events propagate through the React tree even across a portal, so
   * a keystroke aimed at the open menu still reaches the row's own `keydown`.
   * Without this the row cannot tell "the user pressed Delete on me" from "the
   * user is arrowing through my menu".
   */
  onOpenChange?: (open: boolean) => void
}

/**
 * The keyboard path into a row's actions.
 *
 * Hover-reveal like the rest of the sidebar, but `opacity-0` only — never
 * `hidden`, never `display:none`. A control that exists only on hover is still
 * mouse-only, so focus and an open menu both bring it back into view, and Tab
 * reaches it either way.
 */
export function CanvasRowActions({
  label,
  entries,
  onOpenChange
}: CanvasRowActionsProps): React.JSX.Element {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="canvas-row-actions"
          aria-label={label}
          title={label}
          // The row's own click opens the canvas or toggles the folder; asking
          // for the menu is not asking for either.
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded text-sidebar-muted',
            'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            'opacity-0 transition-opacity',
            'group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100',
            'focus-visible:opacity-100 data-[state=open]:opacity-100'
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      {/*
        Nothing chosen in here is also a click on the row.

        Radix portals this content out of the row's DOM subtree, but it stays a
        React CHILD of the row and React synthetic events propagate through the
        REACT tree — so every item's click also reached the row's own `onClick`
        and opened the canvas (or toggled the folder) the user had only asked
        for a menu on. Stopped once, at the boundary, for the same reason the
        keydown leak is guarded once on the row: a per-item fix is a list that
        the next item added silently falls off.
      */}
      <DropdownMenuContent
        align="end"
        data-testid="canvas-row-actions-menu"
        onClick={(event) => event.stopPropagation()}
      >
        <CanvasDropdownMenuBody entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
