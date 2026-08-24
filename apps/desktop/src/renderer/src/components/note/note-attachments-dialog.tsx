/**
 * NoteAttachmentsDialog — every file under this note's `attachments/<noteId>/`
 * folder, from the note menu (#1713). The folder listing is the source of
 * truth (`listAttachments`); the original filenames live only in the block
 * props, so the opener hands in a lookup built from the live editor document.
 *
 * @module components/note/note-attachments-dialog
 */

import { useCallback, useEffect, useState } from 'react'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ExternalLink, File, FileAudio, FileText, FolderOpen, Image } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'

interface AttachmentRow {
  /** On-disk stored name (`{prefix}-{name}` scheme). */
  filename: string
  /** Absolute `memry-file://local/…` URL, accepted by the attachment IPCs. */
  path: string
  size: number
  mimeType: string
  type: 'image' | 'file'
}

interface NoteAttachmentsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  noteId: string
  /**
   * Stored-filename → original filename, from the note's file/image block
   * props. Read once per open; a file no block references simply has no entry.
   */
  getOriginalNames: () => Map<string, string>
}

/** The `{6-char nanoid}-` prefix on stored attachment filenames. */
const STORED_PREFIX_RE = /^[0-9a-z]{6}-/

/**
 * The block-props original name for a stored file. Falls back to a unique
 * 6-char-prefix match so an externally renamed (self-healed) file still shows
 * the name of the block that owns it.
 */
export function lookupOriginalName(
  names: Map<string, string>,
  storedFilename: string
): string | undefined {
  const exact = names.get(storedFilename)
  if (exact) return exact
  if (!STORED_PREFIX_RE.test(storedFilename)) return undefined
  const prefix = storedFilename.slice(0, 7)
  const hits = [...names.entries()].filter(([stored]) => stored.startsWith(prefix))
  return hits.length === 1 ? hits[0][1] : undefined
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function rowIcon(row: AttachmentRow): React.ReactNode {
  if (row.type === 'image') return <Image className="h-5 w-5 shrink-0 text-muted-foreground" />
  if (row.mimeType === 'application/pdf')
    return <FileText className="h-5 w-5 shrink-0 text-red-500" />
  if (row.mimeType.startsWith('audio/'))
    return <FileAudio className="h-5 w-5 shrink-0 text-muted-foreground" />
  return <File className="h-5 w-5 shrink-0 text-muted-foreground" />
}

export function NoteAttachmentsDialog({
  open,
  onOpenChange,
  noteId,
  getOriginalNames
}: NoteAttachmentsDialogProps) {
  const { t } = useT('notes')
  const fileActions = useFileActionLabels()
  const [rows, setRows] = useState<AttachmentRow[]>([])
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setNames(getOriginalNames())
    window.api.notes
      .listAttachments(noteId)
      .then((attachments: AttachmentRow[]) => {
        setRows([...attachments].sort((a, b) => a.filename.localeCompare(b.filename)))
      })
      .catch((err: unknown) => {
        // `t` from useT is not identity-stable across renders; pulling the
        // fallback at call time keeps it out of the effect deps (same pattern
        // as PdfPreview's load-error handler).
        toast.error(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'notes')('editor.attachmentsDialog.loadFailed')
          )
        )
        setRows([])
      })
      .finally(() => setLoading(false))
  }, [open, noteId, getOriginalNames])

  const reveal = useCallback(
    (row: AttachmentRow) => {
      window.api.notes.revealAttachmentInFinder(noteId, row.path).catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('editor.attachmentMenu.revealFailed')))
      })
    },
    [noteId, t]
  )

  const openExternal = useCallback(
    (row: AttachmentRow) => {
      window.api.notes.openAttachmentExternal(noteId, row.path).catch((err: unknown) => {
        toast.error(extractErrorMessage(err, t('editor.attachmentMenu.openFailed')))
      })
    },
    [noteId, t]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="note-attachments-dialog">
        <DialogHeader>
          <DialogTitle>{t('editor.attachmentsDialog.title')}</DialogTitle>
          <DialogDescription>{t('editor.attachmentsDialog.description')}</DialogDescription>
        </DialogHeader>
        {!loading && rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {t('editor.attachmentsDialog.empty')}
          </p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-y-auto">
            {rows.map((row) => {
              const original = lookupOriginalName(names, row.filename)
              return (
                <li
                  key={row.filename}
                  data-testid="note-attachment-row"
                  className="flex items-center gap-3 rounded-md border border-border p-2"
                >
                  {rowIcon(row)}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={original ?? row.filename}>
                      {original ?? row.filename}
                    </p>
                    <p className="truncate text-xs text-muted-foreground" title={row.filename}>
                      {original
                        ? `${t('editor.attachmentMenu.storedAs', { name: row.filename })} · ${formatFileSize(row.size)}`
                        : formatFileSize(row.size)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    title={fileActions.revealInFolder}
                    aria-label={fileActions.revealInFolder}
                    onClick={() => reveal(row)}
                  >
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    title={fileActions.openInDefaultApp}
                    aria-label={fileActions.openInDefaultApp}
                    onClick={() => openExternal(row)}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Stored-filename → original-name map from a live BlockNote document. Walks
 * file and image blocks; the key is the ref's basename, which is the stored
 * filename for every attachment the app wrote itself.
 */
export function collectOriginalNames(editor: unknown): Map<string, string> {
  const map = new Map<string, string>()
  const visit = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      const b = block as {
        type?: string
        props?: { url?: string; name?: string }
        children?: unknown
      }
      if ((b.type === 'file' || b.type === 'image') && b.props?.url && b.props.name) {
        let ref = b.props.url
        try {
          ref = decodeURIComponent(ref)
        } catch {
          // A malformed escape keeps the raw ref; the basename still matches
          // whenever the stored name had nothing to encode.
        }
        const basename = ref.split(/[/\\]/).pop()
        if (basename) map.set(basename, b.props.name)
      }
      visit(b.children)
    }
  }
  visit((editor as { document?: unknown } | null | undefined)?.document)
  return map
}
