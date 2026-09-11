import { getI18n } from 'react-i18next'
/**
 * Row Context Menu
 *
 * Secondary-click context menu for table rows in folder view.
 * Supports single note actions and bulk actions for multi-select.
 *
 * Under tag scope rows can be tasks or inbox items, so the note-only
 * actions (delete, move) are gated on row kind — `notesService` would
 * otherwise receive an id it cannot resolve.
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
  Smile,
  Trash2,
  X
} from '@/lib/icons'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { lazy, Suspense, useState } from 'react'

const LazyEmojiPicker = lazy(async () => ({
  default: (await import('@/components/note/note-title/EmojiPicker')).EmojiPicker
}))

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
  /** Callback to set (or clear, with `null`) the row's icon */
  onSetIcon?: (noteId: string, icon: string | null) => void
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
  onDelete,
  onSetIcon
}: RowContextMenuProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const fileActions = useFileActionLabels()

  // The picker is hosted in a centred dialog rather than a popover: a context
  // menu has no stable element to anchor to (the row spans the whole table),
  // and a dialog is the one placement that can never land off screen.
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false)

  // Delete and Move to Folder are notes-only IPCs (notesService.delete /
  // notesService.move). Folder view rows are always notes (kind absent),
  // but tag view can show task and inbox rows too — those must never offer
  // (or invoke) these actions.
  const isNote = (note.kind ?? 'note') === 'note'

  // The bulk items act on `selectedNoteIds` (the note-only subset of the
  // selection), so they must be labelled with that count and hidden entirely
  // when the selection holds no notes — otherwise a task-only selection would
  // offer "Delete 0 Notes".
  const selectedNoteCount = selectedNoteIds.length

  // Determine if we should show bulk actions
  const showBulkActions = isPartOfSelection && selectedCount > 1 && selectedNoteCount > 0

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
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToOpenInExternalEditor')
        )
      )
    }
  }

  const handleRevealInFinder = async (): Promise<void> => {
    try {
      await notesService.revealInFinder(note.id)
    } catch (err) {
      log.error('Failed to reveal in Finder', err)
      toast.error(
        extractErrorMessage(err, getI18n().getFixedT(null, 'common')('fileActions.revealFailed'))
      )
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
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToCopyLink')
        )
      )
    }
  }

  const handleSetIcon = (icon: string | null): void => {
    if (!isNote) return
    onSetIcon?.(note.id, icon)
  }

  const handleDelete = (): void => {
    if (!isNote) return
    onDelete?.([note.id])
  }

  // Move to folder actions
  const handleMoveToFolder = (): void => {
    if (!isNote) return
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
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {showBulkActions ? (
            // Bulk actions menu (multi-select)
            <>
              <ContextMenuItem onClick={handleBulkMoveToFolder}>
                <FolderInput className="me-2 h-4 w-4" />
                Move {selectedNoteCount} Notes to Folder...
                <ContextMenuShortcut>⇧⌘M</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={handleBulkDelete}>
                <Trash2 className="me-2 h-4 w-4" />
                {tPhaseF('phaseF.componentsFolderViewRowContextMenu.delete')}
                {selectedNoteCount} {tPhaseF('phaseF.componentsFolderViewRowContextMenu.notes')}
              </ContextMenuItem>
            </>
          ) : (
            // Single note actions menu
            <>
              {/* Open actions */}
              <ContextMenuItem onClick={handleOpen}>
                <FileText className="me-2 h-4 w-4" />

                {tPhaseF('phaseF.componentsFolderViewRowContextMenu.open')}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleOpenInNewTab}>
                <FileText className="me-2 h-4 w-4" />
                Open in New Tab
                <ContextMenuShortcut>⌘↵</ContextMenuShortcut>
              </ContextMenuItem>

              <ContextMenuSeparator />

              {/* External actions */}
              <ContextMenuItem onClick={() => void handleOpenExternal()}>
                <ExternalLink className="me-2 h-4 w-4" />

                {tPhaseF('phaseF.componentsFolderViewRowContextMenu.openInExternalEditor')}
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void handleRevealInFinder()}>
                <FolderOpen className="me-2 h-4 w-4" />

                {fileActions.revealInFolder}
              </ContextMenuItem>
              <ContextMenuItem onClick={handleRevealInSidebar}>
                <PanelLeft className="me-2 h-4 w-4" />

                {tPhaseF('phaseF.componentsFolderViewRowContextMenu.revealInSidebar')}
              </ContextMenuItem>

              <ContextMenuSeparator />

              {/* Utility actions */}
              <ContextMenuItem onClick={() => void handleCopyLink()}>
                <Link className="me-2 h-4 w-4" />

                {tPhaseF('phaseF.componentsFolderViewRowContextMenu.copyLink')}
              </ContextMenuItem>
              {isNote && onSetIcon && (
                <ContextMenuItem onClick={() => setIsIconPickerOpen(true)}>
                  <Smile className="me-2 h-4 w-4" />
                  {tPhaseF('tree.actions.setIcon')}
                </ContextMenuItem>
              )}
              {isNote && onSetIcon && note.emoji && (
                <ContextMenuItem onClick={() => handleSetIcon(null)}>
                  <X className="me-2 h-4 w-4" />
                  {tPhaseF('tree.actions.removeIcon')}
                </ContextMenuItem>
              )}
              {isNote && (
                <ContextMenuItem onClick={handleMoveToFolder}>
                  <FolderInput className="me-2 h-4 w-4" />
                  Move to Folder...
                  <ContextMenuShortcut>⇧⌘M</ContextMenuShortcut>
                </ContextMenuItem>
              )}

              {isNote && (
                <>
                  <ContextMenuSeparator />

                  {/* Destructive actions */}
                  <ContextMenuItem variant="destructive" onClick={handleDelete}>
                    <Trash2 className="me-2 h-4 w-4" />

                    {tPhaseF('phaseF.componentsFolderViewRowContextMenu.delete2')}
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={isIconPickerOpen} onOpenChange={setIsIconPickerOpen}>
        <DialogContent className="w-auto max-w-none border-0 bg-transparent p-0 shadow-none">
          <DialogHeader className="sr-only">
            <DialogTitle>{tPhaseF('tree.actions.setIcon')}</DialogTitle>
          </DialogHeader>
          <Suspense fallback={null}>
            <LazyEmojiPicker
              isOpen
              embedded
              onClose={() => setIsIconPickerOpen(false)}
              onSelect={(icon) => handleSetIcon(icon)}
              onRemove={() => handleSetIcon(null)}
              hasEmoji={!!note.emoji}
            />
          </Suspense>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default RowContextMenu
