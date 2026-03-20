/**
 * Row Context Menu
 *
 * Right-click context menu for table rows in folder view.
 * Supports single note actions and bulk actions for multi-select.
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  FileText,
  ExternalLink,
  FolderOpen,
  FolderInput,
  PanelLeft,
  Link,
  Trash2
} from '@/lib/icons'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Component:RowContextMenu')

interface RowContextMenuProps {
  /** Note data for the row */
  note: NoteWithProperties
  /** Whether this row is part of a multi-selection */
  isPartOfSelection: boolean
  /** Total selected notes count (for bulk actions) */
  selectedCount: number
  /** All selected note IDs (for bulk actions) */
  selectedNoteIds: string[]
  /** Children to wrap (the table row) */
  children: React.ReactNode
  /** Callback when note should be opened */
  onNoteOpen?: (noteId: string) => void
  /** Callback when note should be opened in new tab */
  onOpenInNewTab?: (noteId: string) => void
  /** Callback when note(s) should be moved to folder */
  onMoveToFolder?: (noteIds: string[]) => void
  /** Callback when note(s) should be deleted */
  onDelete?: (noteIds: string[]) => void
}

/**
 * Context menu for table rows with single and bulk actions.
 */
export function RowContextMenu({
  note,
  isPartOfSelection,
  selectedCount,
  selectedNoteIds,
  children,
  onNoteOpen,
  onOpenInNewTab,
  onMoveToFolder,
  onDelete
}: RowContextMenuProps): React.JSX.Element {
  // Determine if we should show bulk actions
  const showBulkActions = isPartOfSelection && selectedCount > 1

  // Single note actions
  const handleOpen = (): void => {
    onNoteOpen?.(note.id)
  }

  const handleOpenInNewTab = (): void => {
    onOpenInNewTab?.(note.id)
  }

  const handleOpenExternal = async (): Promise<void> => {
    try {
      await notesService.openExternal(note.id)
    } catch (err) {
      log.error('Failed to open in external editor', err)
      toast.error(extractErrorMessage(err, 'Failed to open in external editor'))
    }
  }

  const handleRevealInFinder = async (): Promise<void> => {
    try {
      await notesService.revealInFinder(note.id)
    } catch (err) {
      log.error('Failed to reveal in Finder', err)
      toast.error(extractErrorMessage(err, 'Failed to reveal in Finder'))
    }
  }

  const handleRevealInSidebar = (): void => {
    // Use existing reveal-in-sidebar event pattern
    window.dispatchEvent(
      new CustomEvent('reveal-in-sidebar', {
        detail: {
          path: `/notes/${note.id}`,
          entityId: note.id
        }
      })
    )
  }

  const handleCopyLink = async (): Promise<void> => {
    try {
      const link = `memry://note/${note.id}`
      await navigator.clipboard.writeText(link)
    } catch (err) {
      log.error('Failed to copy link', err)
      toast.error(extractErrorMessage(err, 'Failed to copy link'))
    }
  }

  const handleDelete = (): void => {
    onDelete?.([note.id])
  }

  // Move to folder actions
  const handleMoveToFolder = (): void => {
    onMoveToFolder?.([note.id])
  }

  const handleBulkMoveToFolder = (): void => {
    onMoveToFolder?.(selectedNoteIds)
  }

  // Bulk actions
  const handleBulkDelete = (): void => {
    onDelete?.(selectedNoteIds)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {showBulkActions ? (
          // Bulk actions menu (multi-select)
          <>
            <ContextMenuItem onClick={handleBulkMoveToFolder}>
              <FolderInput className="mr-2 h-4 w-4" />
              Move {selectedCount} Notes to Folder...
              <ContextMenuShortcut>⇧⌘M</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={handleBulkDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete {selectedCount} Notes
            </ContextMenuItem>
          </>
        ) : (
          // Single note actions menu
          <>
            {/* Open actions */}
            <ContextMenuItem onClick={handleOpen}>
              <FileText className="mr-2 h-4 w-4" />
              Open
            </ContextMenuItem>
            <ContextMenuItem onClick={handleOpenInNewTab}>
              <FileText className="mr-2 h-4 w-4" />
              Open in New Tab
              <ContextMenuShortcut>⌘↵</ContextMenuShortcut>
            </ContextMenuItem>

            <ContextMenuSeparator />

            {/* External actions */}
            <ContextMenuItem onClick={() => void handleOpenExternal()}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Open in External Editor
            </ContextMenuItem>
            <ContextMenuItem onClick={handleRevealInFinder}>
              <FolderOpen className="mr-2 h-4 w-4" />
              Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem onClick={handleRevealInSidebar}>
              <PanelLeft className="mr-2 h-4 w-4" />
              Reveal in Sidebar
            </ContextMenuItem>

            <ContextMenuSeparator />

            {/* Utility actions */}
            <ContextMenuItem onClick={handleCopyLink}>
              <Link className="mr-2 h-4 w-4" />
              Copy Link
            </ContextMenuItem>
            <ContextMenuItem onClick={handleMoveToFolder}>
              <FolderInput className="mr-2 h-4 w-4" />
              Move to Folder...
              <ContextMenuShortcut>⇧⌘M</ContextMenuShortcut>
            </ContextMenuItem>

            <ContextMenuSeparator />

            {/* Destructive actions */}
            <ContextMenuItem variant="destructive" onClick={handleDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export default RowContextMenu
