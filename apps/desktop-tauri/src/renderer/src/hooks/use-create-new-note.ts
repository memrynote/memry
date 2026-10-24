import { useCallback } from 'react'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { useTabActions } from '@/contexts/tabs'
import { useSelectedFolder } from '@/contexts/selected-folder-context'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useOpenPage } from '@/hooks/use-open-target'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { NEW_NOTE_TITLE, markNewNoteTitlePending } from '@/lib/new-note-title'
import { revealNoteInSidebar } from '@/lib/reveal-in-sidebar'
import { getVaultSwitchState } from '@/lib/vault-switch-state'
import { notesService } from '@/services/notes-service'

const log = createLogger('NewNote')

interface CreateNewNoteOptions {
  /** Open the note as a new tab in this pane, whatever the open-in-new-tab preference says. */
  inNewTabOf?: { groupId: string }
  /**
   * Create the note in exactly this folder (`''` is the vault root), whatever the
   * sidebar selection or "create in selected folder" say. The folder context menu
   * and the per-folder shortcuts name their folder this way.
   */
  folder?: string
}

/**
 * The one "new note" gesture: `nav.newNote` (⌘N, the sidebar buttons and File →
 * New Note, all through `runCommand`), the sidebar tree's "New note" actions and
 * the per-folder shortcuts all create here. The tab bar's "+" menu names its pane,
 * because that gesture asks for a new tab in that pane.
 *
 * It creates the note in the folder it is given, else in the folder selected in
 * the sidebar when "create in selected folder" is on, else lets main pick
 * `defaultNoteFolder`. Main gives a note in a folder that folder's default
 * template. The note opens through the open-in-new-tab preference (#1644), with
 * its title field empty and focused (#3323), and the sidebar reveals wherever it
 * landed. A failure is logged and shown as a toast.
 *
 * Call it from a component that stays mounted while the sidebar is collapsed:
 * the selected folder is read from `SelectedFolderProvider`, not from the tree.
 */
export function useCreateNewNote(): (options?: CreateNewNoteOptions) => Promise<void> {
  const { selectedFolder } = useSelectedFolder()
  const { settings } = useGeneralSettings()
  const { openPage } = useOpenPage()
  const { openTab } = useTabActions()
  const createInSelectedFolder = settings.createInSelectedFolder

  return useCallback(
    async ({ inNewTabOf, folder: targetFolder } = {}) => {
      // A switch leaves the old workspace on screen while main opens the next
      // vault, so a note created now would land in a vault this tab is not in.
      if (getVaultSwitchState().pending !== null) return

      const folder = targetFolder ?? (createInSelectedFolder ? selectedFolder : '')

      try {
        const result = await notesService.create({
          title: NEW_NOTE_TITLE,
          content: '',
          folder: folder || undefined
        })

        if (result.success && result.note) {
          markNewNoteTitlePending(result.note.id)
          const tab = {
            type: 'note',
            title: result.note.title,
            icon: 'file-text',
            emoji: result.note.emoji,
            path: `/note/${result.note.id}`,
            entityId: result.note.id,
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false
          } as const
          if (inNewTabOf) openTab(tab, { groupId: inNewTabOf.groupId })
          else openPage(tab)
          // The folder may have come from `defaultNoteFolder` rather than the
          // selection, so the created note is what says where to look.
          revealNoteInSidebar(result.note.id)
        }
      } catch (error) {
        log.error('Failed to create new note', error)
        toast.error(
          extractErrorMessage(
            error,
            getI18n().getFixedT(null, 'common')('phaseI.errors.failedToCreateNote')
          )
        )
      }
    },
    [createInSelectedFolder, selectedFolder, openPage, openTab]
  )
}
