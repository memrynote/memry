/**
 * Rename dialog for an attachment block (#1714).
 *
 * The field starts on the name without its extension, selected, because the
 * extension is the one part a rename may not change — main keeps it (and the
 * stored nanoid prefix) whatever the user types, so offering it for editing
 * would promise something the rename cannot deliver.
 */

import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useT } from '@memry/i18n/renderer'
import { useAttachmentNoteId } from './note-file-url-context'

/** What a surface does with a completed rename — see `AttachmentRenameFlow`. */
export type AttachmentRenamedHandler = (next: { url: string; name: string }) => void

/** `report.pdf` → `['report', '.pdf']`; a dotless name keeps an empty suffix. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/** The `{6-char nanoid}-` prefix every stored attachment filename carries. */
const STORED_PREFIX_RE = /^[0-9a-z]{6}-/

/**
 * What the field starts on.
 *
 * An image block often has no display name of its own, so the caller falls back
 * to the STORED filename — which carries the nanoid prefix. Offering that as
 * the editable text made an untouched Rename produce `k3f9x2-k3f9x2-photo.png`,
 * since main puts the prefix back on whatever is typed.
 */
export function renameFieldValue(name: string): string {
  const [base, extension] = splitExtension(name)
  return `${base.replace(STORED_PREFIX_RE, '') || base}${extension}`
}

export function AttachmentRenameDialog({
  open,
  onOpenChange,
  currentName,
  busy,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentName: string
  busy: boolean
  onSubmit: (nextName: string) => void
}) {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const [base, extension] = splitExtension(renameFieldValue(currentName))
  // Mounted per open (the menu renders it only while renaming), so the initial
  // state IS the current name — no effect syncing a prop into state, and no
  // draft surviving from the last block whose menu was open.
  const [value, setValue] = useState(base)
  const inputRef = useRef<HTMLInputElement>(null)

  const trimmed = value.trim()
  const submit = (): void => {
    if (!trimmed || busy) return
    onSubmit(`${trimmed}${extension}`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="attachment-rename-dialog">
        <DialogHeader>
          <DialogTitle>{t('editor.attachmentRename.title')}</DialogTitle>
          <DialogDescription>{t('editor.attachmentRename.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            autoFocus
            value={value}
            aria-label={t('editor.attachmentRename.fieldLabel')}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              submit()
            }}
          />
          {extension && <span className="shrink-0 text-sm text-muted-foreground">{extension}</span>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tCommon('button.cancel')}
          </Button>
          <Button onClick={submit} disabled={!trimmed || busy}>
            {t('editor.attachmentRename.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The rename itself: the IPC call, its in-flight state, and the dialog.
 *
 * Owned by whoever can keep it mounted, which is NOT always the menu. The image
 * surfaces are rendered by the editor only while their menu is open or the
 * pointer is over the image, so a dialog parented to them unmounts the instant
 * the menu closes — the click did nothing at all. Those hosts render this
 * themselves; the file block, whose menu button lives in a card that stays
 * mounted, lets the menu render it.
 */
export function AttachmentRenameFlow({
  url,
  name,
  open,
  onOpenChange,
  onRenamed
}: {
  url: string
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRenamed: AttachmentRenamedHandler
}) {
  const noteId = useAttachmentNoteId()
  const { t } = useT('notes')
  const [busy, setBusy] = useState(false)

  const submit = useCallback(
    (nextName: string) => {
      if (!noteId) return
      setBusy(true)
      window.api.notes
        .renameAttachment(noteId, url, nextName)
        .then((result) => {
          // Disk first, block second: main has already renamed the file, so the
          // block MUST take the result — a block left on the old ref only
          // survives through self-heal.
          onRenamed({ url: result.url, name: result.name })
          onOpenChange(false)
          toast.success(t('editor.attachmentRename.renamed', { name: result.name }))
        })
        .catch((err: unknown) => {
          toast.error(extractErrorMessage(err, t('editor.attachmentRename.failed')))
        })
        .finally(() => setBusy(false))
    },
    [noteId, url, onRenamed, onOpenChange, t]
  )

  if (!open) return null

  return (
    <AttachmentRenameDialog
      open
      onOpenChange={onOpenChange}
      currentName={name}
      busy={busy}
      onSubmit={submit}
    />
  )
}
