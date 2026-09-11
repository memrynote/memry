/**
 * InsertExistingAttachmentDialog — embed a file the vault already stores (#2077).
 *
 * The point is that nothing is copied: picking a row asks main for the block
 * props that point at the bytes where they already live
 * (`attachments/<ownerNoteId>/<file>`), so the same PDF can sit in two notes
 * without a second copy in the vault and without a second upload.
 *
 * @module components/note/content-area/insert-existing-attachment-dialog
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { VaultAttachmentEntry } from '@memry/rpc/notes'
import { useT } from '@memry/i18n/renderer'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { File, FileText, Image } from '@/lib/icons'

/** What main hands back for a picked attachment; the block props come from it. */
export interface InsertedAttachment {
  url: string
  name: string
  size: number
  mimeType: string
  type: 'image' | 'file'
}

/**
 * The BlockNote block for an attachment that is already in the vault.
 *
 * Lives here rather than in ContentArea so it can be tested without mounting
 * the editor, and written out rather than calling `createFileBlockContent`
 * because `file-block.tsx` pulls in react-pdf at module load — naming a block
 * type must not drag a PDF renderer in with it.
 */
export function buildInsertedAttachmentBlock(result: InsertedAttachment) {
  if (result.type === 'image') {
    return {
      type: 'image' as const,
      props: { url: result.url, caption: result.name, previewWidth: 600 }
    }
  }
  return {
    type: 'file' as const,
    props: {
      url: result.url,
      name: result.name,
      size: result.size,
      mimeType: result.mimeType
    }
  }
}

export interface InsertExistingAttachmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The note that will carry the new block. */
  noteId: string
  /** Called with the resolved block props once the user picks a row. */
  onInsert: (result: InsertedAttachment) => void
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function rowIcon(entry: VaultAttachmentEntry): React.ReactNode {
  if (entry.type === 'image') return <Image className="h-5 w-5 shrink-0 text-muted-foreground" />
  if (entry.mimeType === 'application/pdf')
    return <FileText className="h-5 w-5 shrink-0 text-red-500" />
  return <File className="h-5 w-5 shrink-0 text-muted-foreground" />
}

/** Stable key: the identity of a stored blob is its folder plus its name. */
export function attachmentKey(entry: { ownerNoteId: string; filename: string }): string {
  return `${entry.ownerNoteId}/${entry.filename}`
}

/** Case-insensitive match over what the row actually shows. */
export function filterVaultAttachments(
  entries: VaultAttachmentEntry[],
  query: string
): VaultAttachmentEntry[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return entries
  return entries.filter(
    (entry) =>
      entry.displayName.toLowerCase().includes(trimmed) ||
      (entry.ownerNoteTitle?.toLowerCase().includes(trimmed) ?? false)
  )
}

export function InsertExistingAttachmentDialog({
  open,
  onOpenChange,
  noteId,
  onInsert
}: InsertExistingAttachmentDialogProps) {
  const { t } = useT('notes')
  const [entries, setEntries] = useState<VaultAttachmentEntry[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  // Reopening — even on the same note — flips `loading` back on during render
  // rather than from an effect, the way NoteAttachmentsDialog does.
  const openKey = open ? noteId : null
  const [loadedKey, setLoadedKey] = useState(openKey)
  if (openKey !== loadedKey) {
    setLoadedKey(openKey)
    if (openKey !== null) {
      setLoading(true)
      setQuery('')
    }
  }

  useEffect(() => {
    if (!open) return
    let cancelled = false
    notesService
      .listVaultAttachments()
      .then((rows) => {
        if (!cancelled) setEntries(rows)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setEntries([])
        toast.error(extractErrorMessage(err, t('editor.insertExistingAttachment.loadFailed')))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `t` is not identity-stable across renders; the dialog reloads on open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const visible = useMemo(() => filterVaultAttachments(entries, query), [entries, query])

  const pick = useCallback(
    async (entry: VaultAttachmentEntry) => {
      try {
        const result = await notesService.insertExistingAttachment(
          noteId,
          entry.ownerNoteId,
          entry.filename
        )
        onInsert(result)
        onOpenChange(false)
      } catch (err) {
        toast.error(extractErrorMessage(err, t('editor.insertExistingAttachment.insertFailed')))
      }
    },
    [noteId, onInsert, onOpenChange, t]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="insert-existing-attachment-dialog">
        <DialogHeader>
          <DialogTitle>{t('editor.insertExistingAttachment.title')}</DialogTitle>
          <DialogDescription>{t('editor.insertExistingAttachment.description')}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('editor.insertExistingAttachment.searchPlaceholder')}
          data-testid="insert-existing-attachment-search"
        />
        {!loading && visible.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t('editor.insertExistingAttachment.empty')}
          </p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {visible.map((entry) => (
              <li key={attachmentKey(entry)}>
                <button
                  type="button"
                  data-testid="insert-existing-attachment-row"
                  onClick={() => void pick(entry)}
                  className="flex w-full items-center gap-3 rounded-md border border-border p-2 text-start hover:bg-accent"
                >
                  {rowIcon(entry)}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={entry.displayName}>
                      {entry.displayName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.ownerNoteTitle
                        ? `${entry.ownerNoteTitle} · ${formatFileSize(entry.size)}`
                        : formatFileSize(entry.size)}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
