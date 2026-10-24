import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { isMetadataEditableRow } from '@/components/folder-view/row-metadata-editability'
import type { NoteIconChange, NoteWithProperties } from './use-folder-view'

interface UseFolderNoteIconsOptions {
  notes: NoteWithProperties[]
  selectedNoteIds: readonly string[]
  updateNoteIcons: (changes: readonly NoteIconChange[]) => Promise<NoteIconChange[]>
}

interface UseFolderNoteIconsResult {
  /** Set or clear one row's icon. */
  setRowIcon: (noteId: string, emoji: string | null) => void
  /** Apply one icon to the selection and offer Undo. */
  setSelectionIcon: (emoji: string | null) => Promise<void>
}

export function useFolderNoteIcons({
  notes,
  selectedNoteIds,
  updateNoteIcons
}: UseFolderNoteIconsOptions): UseFolderNoteIconsResult {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')

  // Writes only the notes whose icon actually changes: a PDF/image row has no
  // metadata the main process will write, and a note already on this icon
  // would only spend a sync push. Resolves to the Undo changes.
  const applyIcon = useCallback(
    async (noteIds: readonly string[], emoji: string | null) => {
      const ids = new Set(noteIds)
      const changes = notes
        .filter((note) => ids.has(note.id) && isMetadataEditableRow(note) && note.emoji !== emoji)
        .map((note) => ({ noteId: note.id, emoji }))
      return changes.length > 0 ? updateNoteIcons(changes) : []
    },
    [notes, updateNoteIcons]
  )

  const setRowIcon = useCallback(
    (noteId: string, emoji: string | null) => void applyIcon([noteId], emoji),
    [applyIcon]
  )

  const setSelectionIcon = useCallback(
    async (emoji: string | null) => {
      const undo = await applyIcon(selectedNoteIds, emoji)
      if (undo.length === 0) return
      toast.success(t('bulkActions.iconUpdated', { count: undo.length }), {
        duration: 10000,
        action: {
          label: tCommon('action.undo'),
          onClick: () => void updateNoteIcons(undo)
        }
      })
    },
    [applyIcon, selectedNoteIds, updateNoteIcons, t, tCommon]
  )

  return { setRowIcon, setSelectionIcon }
}
