import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { FilePdf, FileText, Image } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'])

export function attachmentFileName(ref: string): string {
  const withoutQuery = ref.split('?')[0] ?? ref
  const last = withoutQuery.split('/').filter(Boolean).at(-1) ?? ref
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function attachmentExtension(ref: string): string {
  const name = attachmentFileName(ref)
  return name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
}

function isImageAttachment(ref: string): boolean {
  return imageExtensions.has(attachmentExtension(ref))
}

function isPdfAttachment(ref: string): boolean {
  return attachmentExtension(ref) === 'pdf'
}

function attachmentSrc(ref: string): string {
  return ref
}

export function AttachmentPreviewButton({
  attachmentRef,
  onPreview
}: {
  attachmentRef: string
  onPreview: (ref: string) => void
}): React.JSX.Element {
  const fileName = attachmentFileName(attachmentRef)
  const image = isImageAttachment(attachmentRef)
  const pdf = isPdfAttachment(attachmentRef)
  const Icon = image ? Image : pdf ? FilePdf : FileText

  if (image) {
    return (
      <button
        type="button"
        className="group overflow-hidden rounded border border-border/70 bg-muted text-start"
        onClick={(event) => {
          event.stopPropagation()
          onPreview(attachmentRef)
        }}
      >
        <img
          src={attachmentSrc(attachmentRef)}
          alt={fileName}
          className="h-24 w-full object-cover transition-opacity group-hover:opacity-90"
        />
      </button>
    )
  }

  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-2 rounded border border-border/70 bg-muted px-2 py-1.5 text-start text-xs text-foreground hover:bg-surface-active"
      onClick={(event) => {
        event.stopPropagation()
        onPreview(attachmentRef)
      }}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{fileName}</span>
    </button>
  )
}

export function CommentAttachmentPreviewDialog({
  attachmentRef,
  open,
  onOpenChange
}: {
  attachmentRef: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const fileName = attachmentRef
    ? attachmentFileName(attachmentRef)
    : t('editor.comments.attachments.fallbackName')
  const src = attachmentRef ? attachmentSrc(attachmentRef) : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="comment-attachment-preview-dialog" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pe-8 text-base">{fileName}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('editor.comments.attachments.previewDescription')}
          </DialogDescription>
        </DialogHeader>
        {attachmentRef && isImageAttachment(attachmentRef) ? (
          <img
            src={src}
            alt={fileName}
            className="max-h-[70vh] w-full rounded border border-border object-contain"
          />
        ) : attachmentRef && isPdfAttachment(attachmentRef) ? (
          <iframe
            title={fileName}
            src={src}
            sandbox="allow-same-origin allow-scripts"
            className="h-[70vh] w-full rounded border border-border"
          />
        ) : (
          <div className="rounded border border-border bg-muted p-4 text-sm text-muted-foreground">
            <p className="mb-2 font-medium text-foreground">{fileName}</p>
            <p className="break-all">{attachmentRef ?? ''}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
