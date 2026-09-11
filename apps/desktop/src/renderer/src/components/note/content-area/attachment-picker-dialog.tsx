/**
 * AttachmentPickerDialog — one surface for every "put a file here" command.
 *
 * `/image`, `/pdf`, `/media`, `/file` all mean the same thing: the user wants a
 * file in the note. Some of those files are already in the vault, so the picker
 * shows both routes in one list — upload a new one, or reference one that is
 * already stored. Referencing copies nothing: main hands back block props that
 * point at `attachments/<ownerNoteId>/<file>`, so the same PDF can sit in two
 * notes without a second blob and without a second upload (#2077).
 *
 * There is deliberately no separate "existing attachment" command. A command
 * per storage location asks the user to know where a file lives before they can
 * ask for it; the kind of file is the only thing they actually know.
 *
 * @module components/note/content-area/attachment-picker-dialog
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { VaultAttachmentEntry } from '@memry/rpc/notes'
import { useT } from '@memry/i18n/renderer'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { File, FileText, Image, Loader2, Music, Search, Upload, Video } from '@/lib/icons'

/**
 * What the caller is asking for. The kind narrows the vault list and the file
 * dialog's `accept`; it never changes what gets inserted, because an upload and
 * a reference produce the same two block types.
 */
export type AttachmentKind = 'image' | 'media' | 'pdf' | 'file'

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

/** The `accept` handed to the OS file dialog for each kind. */
export const ATTACHMENT_ACCEPT: Record<AttachmentKind, string | undefined> = {
  image: 'image/*',
  media: 'image/*,video/*,audio/*',
  pdf: 'application/pdf,.pdf',
  file: undefined
}

/**
 * Whether a stored file belongs under this kind.
 *
 * Matched on the mime type rather than `entry.type`, which only ever says
 * `image` or `file` — a video and a spreadsheet are both `file` there, and
 * `/media` has to tell them apart.
 */
export function attachmentKindMatches(mimeType: string, kind: AttachmentKind): boolean {
  const mime = mimeType.toLowerCase()
  switch (kind) {
    case 'image':
      return mime.startsWith('image/')
    case 'media':
      return mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')
    case 'pdf':
      return mime === 'application/pdf'
    case 'file':
      return true
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function rowIcon(entry: VaultAttachmentEntry): React.ReactNode {
  const mime = entry.mimeType.toLowerCase()
  const className = 'h-4 w-4 shrink-0 text-muted-foreground'
  if (mime.startsWith('image/')) return <Image className={className} />
  if (mime.startsWith('video/')) return <Video className={className} />
  if (mime.startsWith('audio/')) return <Music className={className} />
  if (mime === 'application/pdf') return <FileText className={className} />
  return <File className={className} />
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

export interface AttachmentPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The note that will carry the new block. */
  noteId: string
  /** Narrows the vault list and the OS dialog's file filter. */
  kind: AttachmentKind
  /** Called with the resolved block props once a file is chosen or uploaded. */
  onInsert: (result: InsertedAttachment) => void
}

export function AttachmentPickerDialog({
  open,
  onOpenChange,
  noteId,
  kind,
  onInsert
}: AttachmentPickerDialogProps) {
  const { t } = useT('notes')
  const [entries, setEntries] = useState<VaultAttachmentEntry[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Reopening — even on the same note — flips `loading` back on during render
  // rather than from an effect, the way NoteAttachmentsDialog does.
  const openKey = open ? `${noteId}:${kind}` : null
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
        toast.error(extractErrorMessage(err, t('editor.attachmentPicker.loadFailed')))
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

  const visible = useMemo(
    () =>
      filterVaultAttachments(
        entries.filter((entry) => attachmentKindMatches(entry.mimeType, kind)),
        query
      ),
    [entries, kind, query]
  )

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
        toast.error(extractErrorMessage(err, t('editor.attachmentPicker.insertFailed')))
      }
    },
    [noteId, onInsert, onOpenChange, t]
  )

  const upload = useCallback(
    async (file: File) => {
      setUploading(true)
      try {
        const result = await notesService.uploadAttachment(noteId, file)
        if (!result.success || !result.path) {
          throw new Error(result.error ?? t('editor.attachmentPicker.uploadFailed'))
        }
        onInsert({
          url: result.path,
          name: result.name ?? file.name,
          size: result.size ?? file.size,
          mimeType: result.mimeType ?? file.type,
          type: result.type ?? 'file'
        })
        onOpenChange(false)
      } catch (err) {
        toast.error(extractErrorMessage(err, t('editor.attachmentPicker.uploadFailed')))
      } finally {
        setUploading(false)
      }
    },
    [noteId, onInsert, onOpenChange, t]
  )

  const title = t(`editor.attachmentPicker.title.${kind}`)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A command palette, not a form: no padding, no visible header, and the
          stock corner close button hidden — `esc` is spelled out in the footer
          and an X floating over the search row reads as chrome on every
          platform. The title stays for screen readers. */}
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0 [&>button]:hidden"
        data-testid="attachment-picker-dialog"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <Command shouldFilter={false} className="bg-transparent">
          <div className="flex items-center gap-2.5 border-b px-3.5" data-cmdk-input-wrapper="">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t(`editor.attachmentPicker.placeholder.${kind}`)}
              className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              data-testid="attachment-picker-search"
            />
          </div>

          <CommandList className="max-h-[min(24rem,60vh)] px-1.5 py-1.5">
            <CommandGroup
              heading={t('editor.attachmentPicker.addHeading')}
              className="p-0 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
            >
              <CommandItem
                value="__upload__"
                disabled={uploading}
                onSelect={() => fileInputRef.current?.click()}
                className="h-9 gap-2.5 px-2"
                data-testid="attachment-picker-upload"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Upload className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {uploading
                    ? t('editor.attachmentPicker.uploading')
                    : t(`editor.attachmentPicker.upload.${kind}`)}
                </span>
              </CommandItem>
            </CommandGroup>

            <CommandGroup
              heading={t('editor.attachmentPicker.vaultHeading')}
              className="p-0 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider"
            >
              {visible.map((entry) => (
                <CommandItem
                  key={attachmentKey(entry)}
                  value={attachmentKey(entry)}
                  onSelect={() => void pick(entry)}
                  className="h-9 gap-2.5 px-2"
                  data-testid="attachment-picker-row"
                >
                  {rowIcon(entry)}
                  <span className="truncate" title={entry.displayName}>
                    {entry.displayName}
                  </span>
                  <span className="ms-auto shrink-0 ps-3 text-xs text-muted-foreground">
                    {entry.ownerNoteTitle
                      ? `${entry.ownerNoteTitle} · ${formatFileSize(entry.size)}`
                      : formatFileSize(entry.size)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>

            {/* Not cmdk's `CommandEmpty`: with `shouldFilter={false}` the
                always-present upload row keeps its item count above zero, so it
                would never render. */}
            {!loading && visible.length === 0 && (
              <p
                className="px-2 py-5 text-center text-sm text-muted-foreground"
                data-testid="attachment-picker-empty"
              >
                {query
                  ? t('editor.attachmentPicker.noMatches')
                  : t(`editor.attachmentPicker.empty.${kind}`)}
              </p>
            )}
          </CommandList>

          <div className="flex items-center gap-3 border-t px-3.5 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Kbd>{'\u2191'}</Kbd>
              <Kbd>{'\u2193'}</Kbd>
              {t('editor.attachmentPicker.hint.navigate')}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>{'\u21b5'}</Kbd>
              {t('editor.attachmentPicker.hint.insert')}
            </span>
            <span className="ms-auto flex items-center gap-1.5">
              <Kbd>{'esc'}</Kbd>
              {t('editor.attachmentPicker.hint.close')}
            </span>
          </div>
        </Command>

        {/* The OS dialog is opened from here so no native "Choose File" control
            is ever rendered — that widget is styled by the platform and looks
            like three different buttons on macOS, Windows and Linux. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT[kind]}
          className="hidden"
          data-testid="attachment-picker-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void upload(file)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
