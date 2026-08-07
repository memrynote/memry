/**
 * One folder row in the sidebar canvas tree, with its actions.
 *
 * A canvas folder is a real directory in the vault, so everything this menu
 * offers moves bytes on disk — which is why Delete goes through a confirmation
 * the tree owns rather than firing from here.
 *
 * Like the canvas row, the same items are reachable from the context menu and from the
 * focusable "⋯" button, built once and rendered by both menus; see
 * `canvas-row-menu`.
 *
 * @module components/sidebar/canvas-tree/canvas-folder-row
 */

import * as React from 'react'
import { FilePlus, FolderInput, FolderPlus, Pencil, Smile, Trash2, X } from '@/lib/icons'
import { SidebarMenuItem, SidebarMenuButton } from '@/components/ui/sidebar'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FolderIconButton } from '@/components/folder-icon-button'
import { useT } from '@memry/i18n/renderer'
import {
  canDrop,
  folderSubtreeDepth,
  splitFolderPath,
  type CanvasDragPayload,
  type CanvasTreeFolderNode
} from './canvas-tree-model'
import { CANVAS_ROW_INDENT_PX, isSameCanvasFolder, type CanvasFolderOption } from './folder-options'
import {
  CanvasContextMenuBody,
  CanvasRowActions,
  useRowMenuState,
  type CanvasMenuEntry,
  type CanvasMenuSubItem
} from './canvas-row-menu'

export interface CanvasFolderRowProps {
  node: CanvasTreeFolderNode
  /** Identity the tree uses to put focus back on this row. */
  rowKey: string
  isExpanded: boolean
  /** True while a legal drop is hovering this row — draws the dashed outline. */
  isDropTarget: boolean
  /** Every folder in the tree, in render order — the Move submenu's raw material. */
  folderOptions: CanvasFolderOption[]
  onToggle: (path: string) => void
  onNewCanvas: (path: string) => void
  onNewFolder: (path: string) => void
  /** Takes the node, not the path: a materialized folder needs a row minting first. */
  onSetIcon: (node: CanvasTreeFolderNode, icon: string | null) => void
  onRename: (node: CanvasTreeFolderNode) => void
  /** New parent, `null` for the canvases root. */
  onMove: (node: CanvasTreeFolderNode, parent: string | null) => void
  onDelete: (node: CanvasTreeFolderNode) => void
  onDragStart: (event: React.DragEvent, node: CanvasTreeFolderNode) => void
  onDragEnd: () => void
  onDragOver: (event: React.DragEvent, node: CanvasTreeFolderNode) => void
  onDragLeave: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent, node: CanvasTreeFolderNode) => void
}

export function CanvasFolderRow({
  node,
  rowKey,
  isExpanded,
  isDropTarget,
  folderOptions,
  onToggle,
  onNewCanvas,
  onNewFolder,
  onSetIcon,
  onRename,
  onMove,
  onDelete,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop
}: CanvasFolderRowProps): React.JSX.Element {
  const { t } = useT('common')
  const menus = useRowMenuState()

  /**
   * Targets this folder may legally move to, judged by the SAME `canDrop` the
   * drag layer uses.
   *
   * Reusing it is the point: the menu and the drag must not disagree about
   * which moves exist, and `canDrop` already encodes both rules — a folder may
   * not land in its own subtree (which would detach it), and its DEEPEST
   * descendant still has to fit under the depth cap once the whole subtree
   * rides along.
   */
  const dragPayload: CanvasDragPayload = {
    tree: 'canvas',
    kind: 'folder',
    path: node.path,
    subtreeDepth: folderSubtreeDepth(node),
    materialized: node.materialized
  }
  const currentParent = splitFolderPath(node.path).parent
  const moveItems: CanvasMenuSubItem[] = [
    {
      id: 'root',
      label: t('canvas.actions.moveToRoot'),
      depth: 0,
      // Already at the root: a no-op write that would still bump `updatedAt`.
      disabled: currentParent === null,
      onSelect: () => onMove(node, null)
    },
    ...folderOptions
      .filter((option) => canDrop(dragPayload, option.path))
      .map((option) => ({
        id: option.path,
        label: option.name,
        depth: option.depth,
        disabled: isSameCanvasFolder(option.path, currentParent),
        onSelect: () => onMove(node, option.path)
      }))
  ]

  const entries: CanvasMenuEntry[] = [
    {
      kind: 'item',
      id: 'new-canvas',
      label: t('canvas.actions.newCanvasHere'),
      icon: FilePlus,
      onSelect: () => onNewCanvas(node.path)
    },
    {
      kind: 'item',
      id: 'new-folder',
      label: t('canvas.actions.newFolder'),
      icon: FolderPlus,
      onSelect: () => onNewFolder(node.path)
    },
    { kind: 'separator', id: 'sep-icon' },
    {
      kind: 'item',
      id: 'set-icon',
      label: t('canvas.actions.setIcon'),
      icon: Smile,
      onSelect: () => menus.setPickerOpen(true)
    },
    ...(node.icon
      ? [
          {
            kind: 'item' as const,
            id: 'remove-icon',
            label: t('canvas.actions.removeIcon'),
            icon: X,
            onSelect: () => onSetIcon(node, null)
          }
        ]
      : []),
    { kind: 'separator', id: 'sep-rename' },
    {
      kind: 'item',
      id: 'rename',
      label: t('canvas.actions.rename'),
      icon: Pencil,
      onSelect: () => onRename(node)
    },
    // The ONLY keyboard path to moving a folder: drag and drop offers none.
    { kind: 'separator', id: 'sep-move' },
    {
      kind: 'submenu',
      id: 'move',
      label: t('canvas.actions.moveToFolder'),
      icon: FolderInput,
      testId: 'canvas-folder-move-menu',
      items: moveItems
    },
    { kind: 'separator', id: 'sep-delete' },
    {
      kind: 'item',
      id: 'delete',
      label: t('button.delete'),
      icon: Trash2,
      destructive: true,
      onSelect: () => onDelete(node)
    }
  ]

  /**
   * Finder/Explorer conventions, fired from whichever control in the row has
   * focus — and inert while the row owns an open menu or picker. Radix portals
   * that content, but it stays a React CHILD of the row and React synthetic
   * events propagate through the REACT tree, so a `Delete` aimed at the menu
   * also reached here and deleted the folder the user was navigating past.
   */
  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.defaultPrevented || menus.anyOpen) return
    if (event.key === 'F2') {
      event.preventDefault()
      onRename(node)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      onDelete(node)
    }
  }

  return (
    <ContextMenu onOpenChange={menus.setContextOpen}>
      <ContextMenuTrigger asChild>
        <SidebarMenuItem
          data-testid="canvas-tree-row"
          data-row-key={rowKey}
          className="flex items-center gap-1"
          style={{ paddingInlineStart: `${node.depth * CANVAS_ROW_INDENT_PX}px` }}
          onClick={() => onToggle(node.path)}
          onKeyDown={handleKeyDown}
          draggable
          onDragStart={(event) => onDragStart(event, node)}
          onDragEnd={onDragEnd}
          onDragOver={(event) => onDragOver(event, node)}
          onDragLeave={onDragLeave}
          onDrop={(event) => onDrop(event, node)}
        >
          {/* Same "inside" indicator the notes tree draws, so the two trees feel
              identical. `SidebarMenuItem` is already `relative`. */}
          {isDropTarget && (
            <div
              data-testid="canvas-drop-indicator"
              className="absolute inset-0 rounded-md border-2 border-primary border-dashed bg-primary/10"
              aria-hidden="true"
            />
          )}

          <FolderIconButton
            icon={node.icon}
            isExpanded={isExpanded}
            hasChildren={node.children.length > 0}
            onIconChange={(icon) => onSetIcon(node, icon)}
            pickerOpen={menus.pickerOpen}
            onPickerOpenChange={menus.setPickerOpen}
          />

          <SidebarMenuButton className="flex-1" aria-expanded={isExpanded}>
            <span className="sidebar-label-fade flex-1 text-[13px] font-medium text-sidebar-text-folder">
              {node.name}
            </span>
          </SidebarMenuButton>

          {/* Only while collapsed, the way `SidebarSection` states its own
              count: expanded, the rows themselves are the answer and a badge
              would just be a second one. Informational rather than decorative,
              so it takes the heading token that clears AA at 10px instead of
              `--sidebar-muted`. */}
          {!isExpanded && node.canvasCount > 0 && (
            <span
              data-testid="canvas-folder-count"
              aria-label={t('canvas.folderCanvasCount', { count: node.canvasCount })}
              className="shrink-0 pe-1 text-[10px] leading-3 tabular-nums text-sidebar-section-heading"
            >
              {node.canvasCount}
            </span>
          )}

          <CanvasRowActions
            label={t('canvas.actions.folderMenu')}
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

export default CanvasFolderRow
