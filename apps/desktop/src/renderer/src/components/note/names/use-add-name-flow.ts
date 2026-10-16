import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { NamedNote } from '@/lib/note-name-rank'
import { notesService } from '@/services/notes-service'
import { createWikiLinkInlineContent } from '../content-area/wiki-link'

/** The two editor calls the flow makes; the note's BlockNote editor satisfies it. */
interface NameFlowEditor {
  focus(): void
  insertInlineContent(content: unknown, options?: { updateSelection?: boolean }): void
}

export function useAddNameFlow(editor: NameFlowEditor) {
  const { t } = useT('notes')
  const [name, setName] = useState<string | null>(null)

  const close = useCallback(() => {
    setName(null)
    editor.focus()
  }, [editor])

  const pick = useCallback(
    async (note: NamedNote, target: string) => {
      const added = name
      setName(null)
      if (added === null) return
      try {
        await notesService.editAliases({ id: note.id, add: [added], remove: [] })
      } catch (error) {
        toast.error(extractErrorMessage(error, t('names.saveFailed')))
        editor.focus()
        return
      }
      editor.focus()
      editor.insertInlineContent([createWikiLinkInlineContent(target, added), ' '], {
        updateSelection: true
      })
    },
    [editor, name, t]
  )

  return { requestAddName: setName, dialogProps: { name, onClose: close, onPick: pick } }
}
