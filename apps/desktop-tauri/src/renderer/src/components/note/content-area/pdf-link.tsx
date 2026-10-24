/**
 * A PDF shown as its file name instead of the inline viewer (#2517).
 *
 * Chosen per block with the `display` prop (default `embed`). The name opens
 * the file in the system viewer; the block's "⋯" menu switches back.
 *
 * @module components/note/content-area/pdf-link
 */

import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { FileText } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAttachmentNoteId } from './note-file-url-context'

interface PdfLinkProps {
  /** The raw stored ref — main resolves and validates it against the vault. */
  url: string
  name: string
  menu: React.ReactNode
}

export function PdfLink({ url, name, menu }: PdfLinkProps) {
  const { t } = useT('notes')
  const noteId = useAttachmentNoteId()

  const open = (): void => {
    if (!noteId) return
    window.api.notes.openAttachmentExternal(noteId, url).catch((err: unknown) => {
      toast.error(extractErrorMessage(err, t('editor.attachmentMenu.openFailed')))
    })
  }

  return (
    <div className="pdf-link group flex max-w-full items-center gap-1.5" data-testid="pdf-link">
      <FileText className="h-4 w-4 shrink-0 text-red-500" />
      <button
        type="button"
        onClick={open}
        title={name}
        className="min-w-0 truncate text-sm underline decoration-border underline-offset-2 hover:decoration-current"
      >
        {name}
      </button>
      {menu}
    </div>
  )
}
