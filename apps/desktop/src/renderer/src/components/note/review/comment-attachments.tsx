import { lazy, Suspense, useState } from 'react'
import { FileText, Paperclip } from '@/lib/icons'
import { ImageViewer } from '@/components/viewers/image-viewer'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useT } from '@memry/i18n/renderer'
import type { CriticMarkupCommentAttachmentRef, CriticMarkupMark } from '@memry/shared'

// react-pdf is heavy and hard-crashes at module load outside a real DOM
// (pdf.js needs DOMMatrix), so lazy-load it — it only mounts when a PDF is
// opened, and it keeps review-card's static import graph clean for jsdom tests.
const PdfViewer = lazy(() =>
  import('@/components/viewers/pdf-viewer').then((m) => ({ default: m.PdfViewer }))
)

export type CommentAttachmentKind = 'image' | 'pdf' | 'file'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Classify a comment attachment for display. `mimeType`/`type` are optional on
 * older/normalized attachments, so fall back to the filename extension.
 */
export function classifyCommentAttachment(
  attachment: CriticMarkupCommentAttachmentRef
): CommentAttachmentKind {
  const ext = fileExtension(attachment.name)
  if (
    attachment.type === 'image' ||
    attachment.mimeType?.startsWith('image/') ||
    IMAGE_EXTENSIONS.has(ext)
  ) {
    return 'image'
  }
  if (attachment.mimeType === 'application/pdf' || ext === 'pdf') return 'pdf'
  return 'file'
}

/**
 * Renders a comment's attachments. Images show inline thumbnails; clicking an
 * image or PDF opens the in-app viewer (Esc / click-outside / X to close). Other
 * files open in the OS default app. Never a bare `<a href="memry-file://…">`,
 * which would drive a main-frame navigation and trap the app (issue #799).
 */
export function CommentAttachments({ mark }: { mark: CriticMarkupMark }): React.JSX.Element | null {
  const { t } = useT('notes')
  const [active, setActive] = useState<CriticMarkupCommentAttachmentRef | null>(null)

  if (!mark.attachments?.length) return null

  return (
    <div className="critic-review-attachments">
      {mark.attachments.map((attachment) => {
        const kind = classifyCommentAttachment(attachment)

        if (kind === 'image') {
          return (
            <button
              key={attachment.id}
              type="button"
              className="inline-flex max-w-full overflow-hidden rounded-md border border-border bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('comments.openImageAria', { name: attachment.name })}
              onClick={() => setActive(attachment)}
            >
              <img
                src={attachment.path}
                alt={attachment.name}
                loading="lazy"
                className="max-h-32 max-w-full object-cover"
              />
            </button>
          )
        }

        return (
          <button
            key={attachment.id}
            type="button"
            className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-muted/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('comments.openAttachmentAria', { name: attachment.name })}
            onClick={() => {
              if (kind === 'pdf') {
                setActive(attachment)
              } else {
                window.open(attachment.path, '_blank', 'noopener,noreferrer')
              }
            }}
          >
            {kind === 'pdf' ? (
              <FileText className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <Paperclip className="size-3 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{attachment.name}</span>
          </button>
        )
      })}

      <Dialog open={active !== null} onOpenChange={(open) => !open && setActive(null)}>
        {active && (
          <DialogContent
            aria-describedby={undefined}
            className="flex h-[88vh] w-full max-w-[92vw] flex-col gap-0 p-0"
          >
            <DialogTitle className="sr-only">{active.name}</DialogTitle>
            {classifyCommentAttachment(active) === 'image' ? (
              <ImageViewer src={active.path} alt={active.name} className="min-h-0 flex-1" />
            ) : (
              <Suspense fallback={null}>
                <PdfViewer src={active.path} className="min-h-0 flex-1" />
              </Suspense>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
