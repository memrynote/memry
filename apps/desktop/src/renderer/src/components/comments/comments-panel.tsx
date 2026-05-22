import { useEffect, useMemo, useState } from 'react'
import type { Comment, CommentAnchorInput, CommentTargetType } from '@/services/comments-service'
import { notesService } from '@/services/notes-service'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface CommentsPanelProps {
  targetType: CommentTargetType
  targetId: string
  comments: Comment[]
  pendingAnchor: CommentAnchorInput | null
  activeCommentId: string | null
  orphanedCommentIds?: string[]
  className?: string
  onSavePending: (body: string, attachmentRefs: string[]) => Promise<void>
  onCancelPending: () => void
  onCommentClick: (comment: Comment) => void
}

export function CommentsPanel({
  targetId,
  comments,
  pendingAnchor,
  activeCommentId,
  orphanedCommentIds = [],
  className,
  onSavePending,
  onCancelPending,
  onCommentClick
}: CommentsPanelProps): React.JSX.Element | null {
  const { t } = useT('notes')
  const [body, setBody] = useState('')
  const [attachmentRefs, setAttachmentRefs] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const orphaned = useMemo(() => new Set(orphanedCommentIds), [orphanedCommentIds])

  useEffect(() => {
    if (pendingAnchor) {
      setBody('')
      setAttachmentRefs([])
    }
  }, [pendingAnchor])

  if (!pendingAnchor && comments.length === 0) return null

  const handleSave = async (): Promise<void> => {
    if (!pendingAnchor || isSaving) return
    setIsSaving(true)
    try {
      await onSavePending(body, attachmentRefs)
      setBody('')
      setAttachmentRefs([])
    } finally {
      setIsSaving(false)
    }
  }

  const handleAttachmentChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const files = Array.from(event.currentTarget.files ?? [])
    if (files.length === 0) return
    setIsUploading(true)
    try {
      const uploaded: string[] = []
      for (const file of files) {
        const result = await notesService.uploadAttachment(targetId, file)
        if (result.success && result.path) uploaded.push(result.path)
      }
      setAttachmentRefs((refs) => [...refs, ...uploaded])
    } finally {
      event.currentTarget.value = ''
      setIsUploading(false)
    }
  }

  return (
    <aside
      data-testid="comments-panel"
      data-marquee-ignore
      className={cn(
        'fixed end-5 top-14 bottom-8 z-50 flex w-80 flex-col overflow-hidden rounded-md border border-border/70 bg-background/95 shadow-xl backdrop-blur',
        className
      )}
    >
      <div className="border-b border-border/60 px-3 py-2">
        <h2 className="text-xs font-medium text-foreground">{t('editor.comments.panel.title')}</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {pendingAnchor && (
          <div
            data-testid="comment-composer"
            className="mb-3 rounded-md border border-amber-300/60 bg-amber-50/80 p-3 dark:border-amber-700/50 dark:bg-amber-950/20"
          >
            <p
              data-testid="comment-composer-quote"
              className="mb-2 line-clamp-3 text-xs text-muted-foreground"
            >
              {pendingAnchor.selectedQuote}
            </p>
            <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
              {t('editor.comments.composer.bodyAria')}
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                className="min-h-24 resize-none rounded-sm border border-border bg-background px-2 py-1.5 text-sm font-normal outline-none focus:border-primary"
              />
            </label>
            {attachmentRefs.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {attachmentRefs.map((ref) => (
                  <span key={ref} className="truncate text-[11px] text-muted-foreground">
                    {ref}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <label className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                {isUploading
                  ? t('editor.comments.composer.attaching')
                  : t('editor.comments.composer.attachFile')}
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => void handleAttachmentChange(event)}
                />
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onCancelPending}
                  className="rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-surface-active"
                >
                  {t('editor.comments.panel.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                  className="rounded-sm bg-foreground px-2.5 py-1 text-xs font-medium text-background disabled:opacity-50"
                >
                  {t('editor.comments.composer.save')}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {comments.map((comment) => {
            const isActive = comment.id === activeCommentId
            const isOrphaned = orphaned.has(comment.id)
            return (
              <button
                key={comment.id}
                type="button"
                data-testid="comment-card"
                data-active={isActive ? 'true' : 'false'}
                data-orphaned={isOrphaned ? 'true' : 'false'}
                onClick={() => onCommentClick(comment)}
                className={cn(
                  'rounded-md border p-3 text-start transition-colors',
                  isActive
                    ? 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/30'
                    : 'border-border/60 bg-background hover:bg-surface-active'
                )}
              >
                <span className="mb-1 block line-clamp-2 text-[11px] text-muted-foreground">
                  {comment.selectedQuote}
                </span>
                <span className="block whitespace-pre-wrap break-words text-sm text-foreground">
                  {comment.body || t('editor.comments.card.noBody')}
                </span>
                {isOrphaned && (
                  <span className="mt-2 block text-[11px] text-amber-700 dark:text-amber-400">
                    {t('editor.comments.card.anchorNotFound')}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
