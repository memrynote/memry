/**
 * One canvas row in the sidebar canvas tree, with its actions.
 *
 * The menu is the only keyboard path for organizing canvases — drag and drop
 * offers none — so every placement action has to live in it, including the
 * "Move to folder" submenu. It is reachable two ways: a context menu anywhere on
 * the row, or the focusable "⋯" button. Radix opens a context menu only from a
 * native `contextmenu` event and macOS keyboards cannot produce one, so the
 * button is what makes the row usable without a mouse at all.
 *
 * The items themselves are built ONCE, as data, and handed to both menus; see
 * `canvas-row-menu`.
 *
 * The row is a drag SOURCE only. It never accepts a drop: folders and the root
 * zone are the only places a canvas can land, so there is nothing a drop on a
 * sibling canvas could mean.
 *
 * @module components/sidebar/canvas-tree/canvas-row
 */

import * as React from 'react'
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  FolderInput,
  FolderOpen,
  PenTool,
  Pencil,
  Smile,
  Trash2,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { SidebarMenuItem, SidebarMenuButton } from '@/components/ui/sidebar'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { IconPickerButton } from '@/components/icon-picker-button'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { useT } from '@memry/i18n/renderer'
import type { CanvasSummary } from '@/services/canvas-service'
import { CANVAS_ROW_INDENT_PX, isSameCanvasFolder, type CanvasFolderOption } from './folder-options'
import {
  CanvasContextMenuBody,
  CanvasRowActions,
  useRowMenuState,
  type CanvasMenuEntry
} from './canvas-row-menu'

const CANVAS_ICON_SPACER = <div className="h-4 w-4" />

export interface CanvasRowProps {
  canvas: CanvasSummary
  /** Identity the tree uses to put focus back on this row. */
  rowKey: string
  depth: number
  isActive: boolean
  /** Every folder in the tree, in render order — the Move submenu's contents. */
  folderOptions: CanvasFolderOption[]
  onOpen: (canvas: CanvasSummary) => void
  onRename: (canvas: CanvasSummary) => void
  onDuplicate: (canvas: CanvasSummary) => void
  onSetIcon: (canvas: CanvasSummary, icon: string | null) => void
  onMove: (canvas: CanvasSummary, folder: string | null) => void
  onOpenExternal: (canvas: CanvasSummary) => void
  onRevealInFinder: (canvas: CanvasSummary) => void
  onDelete: (canvas: CanvasSummary) => void
  onDragStart: (event: React.DragEvent, canvas: CanvasSummary) => void
  onDragEnd: () => void
}

export function CanvasRow({
  canvas,
  rowKey,
  depth,
  isActive,
  folderOptions,
  onOpen,
  onRename,
  onDuplicate,
  onSetIcon,
  onMove,
  onOpenExternal,
  onRevealInFinder,
  onDelete,
  onDragStart,
  onDragEnd
}: CanvasRowProps): React.JSX.Element {
  const { t } = useT('common')
  const menus = useRowMenuState()

  const title = canvas.title || t('canvas.untitled')
  const unreadable = canvas.unreadable === true

  const revealEntry: CanvasMenuEntry = {
    kind: 'item',
    id: 'reveal',
    label: t('canvas.actions.revealInFinder'),
    icon: FolderOpen,
    onSelect: () => onRevealInFinder(canvas)
  }
  const deleteEntry: CanvasMenuEntry = {
    kind: 'item',
    id: 'delete',
    label: t('button.delete'),
    icon: Trash2,
    destructive: true,
    onSelect: () => onDelete(canvas)
  }

  // Nothing offered for an unreadable canvas may pretend the document is
  // there: no rename, no duplicate, no move. Find it on disk, or drop the entry.
  const entries: CanvasMenuEntry[] = unreadable
    ? [revealEntry, { kind: 'separator', id: 'sep-delete' }, deleteEntry]
    : [
        {
          kind: 'item',
          id: 'rename',
          label: t('canvas.actions.rename'),
          icon: Pencil,
          onSelect: () => onRename(canvas)
        },
        {
          kind: 'item',
          id: 'duplicate',
          label: t('canvas.actions.duplicate'),
          icon: Copy,
          onSelect: () => onDuplicate(canvas)
        },
        { kind: 'separator', id: 'sep-icon' },
        {
          kind: 'item',
          id: 'set-icon',
          label: t('canvas.actions.setIcon'),
          icon: Smile,
          onSelect: () => menus.setPickerOpen(true)
        },
        ...(canvas.icon
          ? [
              {
                kind: 'item' as const,
                id: 'remove-icon',
                label: t('canvas.actions.removeIcon'),
                icon: X,
                onSelect: () => onSetIcon(canvas, null)
              }
            ]
          : []),
        { kind: 'separator', id: 'sep-move' },
        {
          kind: 'submenu',
          id: 'move',
          label: t('canvas.actions.moveToFolder'),
          icon: FolderInput,
          testId: 'canvas-move-menu',
          items: [
            {
              id: 'root',
              label: t('canvas.actions.moveToRoot'),
              depth: 0,
              disabled: canvas.folder === null,
              onSelect: () => onMove(canvas, null)
            },
            ...folderOptions.map((option) => ({
              id: option.path,
              label: option.name,
              depth: option.depth,
              disabled: isSameCanvasFolder(option.path, canvas.folder),
              onSelect: () => onMove(canvas, option.path)
            }))
          ]
        },
        { kind: 'separator', id: 'sep-external' },
        {
          kind: 'item',
          id: 'open-external',
          label: t('canvas.actions.openExternal'),
          icon: ExternalLink,
          onSelect: () => onOpenExternal(canvas)
        },
        revealEntry,
        { kind: 'separator', id: 'sep-bookmark' },
        { kind: 'bookmark', id: 'bookmark', itemType: 'canvas', itemId: canvas.id },
        { kind: 'separator', id: 'sep-delete' },
        deleteEntry
      ]

  /**
   * The shortcuts a user brings from Finder and Explorer. They fire from the
   * row because focus lives on one of the row's controls, and keydown bubbles
   * to the `<li>` from all of them.
   *
   * Inert while the row owns an open menu or picker: Radix portals that content
   * out of the row's DOM subtree, but it is still a React CHILD of the row and
   * React synthetic events propagate through the REACT tree — so `Delete`
   * pressed while arrowing through the menu also arrived here and destroyed a
   * canvas the user never chose.
   */
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.defaultPrevented || menus.anyOpen) return
    if (event.key === 'F2') {
      if (unreadable) return
      event.preventDefault()
      onRename(canvas)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      onDelete(canvas)
    }
  }

  return (
    <ContextMenu onOpenChange={menus.setContextOpen}>
      <ContextMenuTrigger asChild>
        <SidebarMenuItem
          data-testid="canvas-tree-row"
          data-row-key={rowKey}
          className="flex items-center gap-1"
          style={{ paddingInlineStart: `${depth * CANVAS_ROW_INDENT_PX}px` }}
          onClick={() => onOpen(canvas)}
          onKeyDown={handleKeyDown}
          // A row that cannot open must say why before it is clicked, not after.
          title={unreadable ? t('canvas.unreadable') : undefined}
          // An unreadable canvas is not draggable for the same reason its menu
          // hides "Move to folder": there is no document to file anywhere.
          draggable={!unreadable}
          onDragStart={(event) => onDragStart(event, canvas)}
          onDragEnd={onDragEnd}
        >
          {unreadable ? (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            </span>
          ) : (
            <IconPickerButton
              leading={CANVAS_ICON_SPACER}
              hasIcon={!!canvas.icon}
              onIconChange={(icon) => onSetIcon(canvas, icon)}
              ariaLabel={t('canvas.actions.setIcon')}
              pickerOpen={menus.pickerOpen}
              onPickerOpenChange={menus.setPickerOpen}
            >
              {canvas.icon ? (
                <NoteIconDisplay value={canvas.icon} className="text-sm leading-none" />
              ) : (
                <PenTool className="h-4 w-4 text-sidebar-foreground" />
              )}
            </IconPickerButton>
          )}

          <SidebarMenuButton isActive={isActive} className="flex-1">
            <span
              className={cn(
                'sidebar-label-fade flex-1 text-[13px] font-medium',
                unreadable
                  ? 'text-muted-foreground line-through decoration-destructive/60'
                  : 'text-sidebar-text-folder'
              )}
            >
              {title}
            </span>
          </SidebarMenuButton>

          <CanvasRowActions
            label={t('canvas.actions.canvasMenu')}
            entries={entries}
            onOpenChange={menus.setActionsOpen}
          />
        </SidebarMenuItem>
      </ContextMenuTrigger>

      <ContextMenuContent data-testid="canvas-tree-menu">
        <CanvasContextMenuBody entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

export default CanvasRow
