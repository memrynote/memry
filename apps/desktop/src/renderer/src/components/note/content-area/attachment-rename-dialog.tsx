/**
 * Rename dialog for an attachment block (#1714).
 *
 * The field starts on the name without its extension, selected, because the
 * extension is the one part a rename may not change — main keeps it (and the
 * stored nanoid prefix) whatever the user types, so offering it for editing
 * would promise something the rename cannot deliver.
 */

import { useRef, useState } from 'react'
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

/** `report.pdf` → `['report', '.pdf']`; a dotless name keeps an empty suffix. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
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
  const [base, extension] = splitExtension(currentName)
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
