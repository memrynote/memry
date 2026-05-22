import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  Comment,
  CommentAnchorInput,
  CommentMentionKind,
  CommentMentionRef
} from '@/services/comments-service'
import { notesService } from '@/services/notes-service'
import { RefPicker } from '@/agent-chat/ref-picker'
import {
  MentionIcon,
  mentionColorForKind,
  type MentionAttachment,
  type MentionIconSpec
} from '@/agent-chat/mention-icons'
import { useMemryLinkNavigation } from '@/agent-chat/messages/memry-links'
import { ArrowUp, AtSign, Check, FileText, Paperclip, PenLine, Trash2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  attachmentFileName,
  AttachmentPreviewButton,
  CommentAttachmentPreviewDialog
} from './comment-attachments'
import { useT } from '@memry/i18n/renderer'

export interface CommentRailRect {
  id: string
  top: number
  height: number
}

interface CommentsRailProps {
  targetId: string
  comments: Comment[]
  commentRects: CommentRailRect[]
  draftAnchor: CommentAnchorInput | null
  draftTop: number | null
  activeCommentId: string | null
  className?: string
  onSaveDraft: (
    anchor: CommentAnchorInput,
    body: string,
    attachmentRefs: string[],
    mentionRefs: CommentMentionRef[]
  ) => Promise<void>
  onCancelDraft: () => void
  onCommentClick: (comment: Comment) => void
  onUpdateComment?: (comment: Comment, body: string) => Promise<void>
  onDeleteComment?: (comment: Comment) => Promise<void>
}

interface CommentComposerProps {
  targetId: string
  anchor: CommentAnchorInput
  onSave: (
    body: string,
    attachmentRefs: string[],
    mentionRefs: CommentMentionRef[]
  ) => Promise<void>
  onCancel: () => void
}

interface CommentCardProps {
  comment: Comment
  active: boolean
  orphaned: boolean
  onClick: () => void
  onUpdate?: (comment: Comment, body: string) => Promise<void>
  onDelete?: (comment: Comment) => Promise<void>
}

interface RailItem {
  key: string
  top: number
  estimatedHeight: number
  render: (top: number) => React.JSX.Element
}

interface ActiveMentionQuery {
  start: number
  end: number
  query: string
}

const RAIL_OFFSET_PX = 24
const RAIL_WIDTH_PX = 284
const RAIL_GAP_PX = 10
const ORPHAN_TOP_PX = 0

const allowedMentionKinds = new Set<CommentMentionKind>([
  'note',
  'journal',
  'task',
  'inbox',
  'calendar_event',
  'project',
  'folder'
])

function findActiveMentionQuery(value: string, caret: number): ActiveMentionQuery | null {
  const beforeCaret = value.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(beforeCaret)
  if (!match) return null
  const atIndex = beforeCaret.lastIndexOf('@')
  if (atIndex < 0) return null
  return { start: atIndex, end: caret, query: match[2] ?? '' }
}

function mentionIconForKind(kind: CommentMentionKind): MentionIconSpec {
  switch (kind) {
    case 'note':
      return { kind: 'note' }
    case 'journal':
      return { kind: 'journal' }
    case 'task':
      return { kind: 'task' }
    case 'inbox':
      return { kind: 'inbox' }
    case 'calendar_event':
      return { kind: 'calendar_event' }
    case 'project':
      return { kind: 'project' }
    case 'folder':
      return { kind: 'folder' }
  }
}

function toMentionRef(attachment: MentionAttachment): CommentMentionRef | null {
  const kind = attachment.kind as CommentMentionKind
  if (!allowedMentionKinds.has(kind)) return null
  return { kind, refId: attachment.ref_id, label: attachment.label }
}

function dedupeMentionRefs(mentions: CommentMentionRef[]): CommentMentionRef[] {
  const seen = new Set<string>()
  return mentions.filter((mention) => {
    const key = `${mention.kind}:${mention.refId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function mentionHref(mention: CommentMentionRef): string {
  const id = encodeURIComponent(mention.refId)
  if (mention.kind === 'calendar_event') return `memry://calendar/event/${id}`
  return `memry://${mention.kind}/${id}`
}

function estimateCommentHeight(comment: Comment, orphaned: boolean): number {
  const bodyLines = Math.max(1, Math.ceil(comment.body.length / 42))
  const mentions = comment.mentionRefs.length > 0 ? 28 : 0
  const attachments = comment.attachmentRefs.length > 0 ? 62 : 0
  const orphan = orphaned ? 18 : 0
  return 76 + bodyLines * 18 + mentions + attachments + orphan
}

function stackRailItems(items: RailItem[]): Array<RailItem & { stackedTop: number }> {
  let nextTop = 0
  return [...items]
    .sort((a, b) => a.top - b.top)
    .map((item) => {
      const stackedTop = Math.max(item.top, nextTop)
      nextTop = stackedTop + item.estimatedHeight + RAIL_GAP_PX
      return { ...item, stackedTop }
    })
}

function MentionChip({
  mention,
  onClick
}: {
  mention: CommentMentionRef
  onClick?: () => void
}): React.JSX.Element {
  const chip = (
    <>
      <MentionIcon icon={mentionIconForKind(mention.kind)} className="size-3" />
      <span className="truncate">{mention.label}</span>
    </>
  )

  const className = cn(
    'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
    mentionColorForKind(mention.kind)
  )

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
      >
        {chip}
      </button>
    )
  }

  return <span className={className}>{chip}</span>
}

export function CommentComposer({
  targetId,
  anchor,
  onSave,
  onCancel
}: CommentComposerProps): React.JSX.Element {
  const { t } = useT('notes')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [body, setBody] = useState('')
  const [mentionRefs, setMentionRefs] = useState<CommentMentionRef[]>([])
  const [attachmentRefs, setAttachmentRefs] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeMention, setActiveMention] = useState<ActiveMentionQuery | null>(null)
  const [pickerItems, setPickerItems] = useState<MentionAttachment[]>([])
  const [selectedPickerIndex, setSelectedPickerIndex] = useState(-1)

  useEffect(() => {
    setBody('')
    setMentionRefs([])
    setAttachmentRefs([])
    setPickerOpen(false)
    setActiveMention(null)
  }, [anchor.selectedQuote, anchor.rangeStart, anchor.rangeEnd])

  const updateMentionQuery = useCallback((value: string, caret: number) => {
    const next = findActiveMentionQuery(value, caret)
    setActiveMention(next)
    setPickerOpen(Boolean(next))
  }, [])

  const handlePickMention = useCallback(
    (attachment: MentionAttachment) => {
      const mention = toMentionRef(attachment)
      if (!mention || !activeMention) return

      const nextBody = `${body.slice(0, activeMention.start)}${body.slice(activeMention.end)}`
      const caret = activeMention.start
      setBody(nextBody)
      setMentionRefs((refs) => dedupeMentionRefs([...refs, mention]))
      setPickerOpen(false)
      setActiveMention(null)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(caret, caret)
      })
    },
    [activeMention, body]
  )

  const handleAttachmentChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> => {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
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
      input.value = ''
      setIsUploading(false)
    }
  }

  const hasContent = body.trim().length > 0 || mentionRefs.length > 0 || attachmentRefs.length > 0
  const saveDisabled = !hasContent || isSaving || isUploading

  const handleSave = async (): Promise<void> => {
    if (saveDisabled) return
    setIsSaving(true)
    try {
      await onSave(body.trim(), attachmentRefs, mentionRefs)
      setBody('')
      setMentionRefs([])
      setAttachmentRefs([])
      setPickerOpen(false)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      data-testid="comment-composer"
      data-marquee-ignore
      className="rounded-md border border-border/80 bg-background p-2 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
    >
      <p
        data-testid="comment-composer-quote"
        className="mb-2 line-clamp-2 text-xs text-muted-foreground"
      >
        {anchor.selectedQuote}
      </p>

      <div className="relative">
        {pickerOpen && activeMention && (
          <RefPicker
            query={activeMention.query}
            selectedIndex={selectedPickerIndex}
            onItemsChange={setPickerItems}
            onPick={handlePickMention}
            onSelectedIndexChange={setSelectedPickerIndex}
            onClose={() => setPickerOpen(false)}
          />
        )}
        <textarea
          ref={textareaRef}
          aria-label={t('editor.comments.composer.bodyAria')}
          placeholder={t('editor.comments.composer.placeholder')}
          value={body}
          onChange={(event) => {
            const value = event.currentTarget.value
            setBody(value)
            updateMentionQuery(value, event.currentTarget.selectionStart)
          }}
          onKeyDown={(event) => {
            if (!pickerOpen) return
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelectedPickerIndex((index) =>
                pickerItems.length === 0 ? -1 : Math.min(index + 1, pickerItems.length - 1)
              )
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedPickerIndex((index) =>
                pickerItems.length === 0 ? -1 : Math.max(index - 1, 0)
              )
            } else if (event.key === 'Enter' && selectedPickerIndex >= 0) {
              event.preventDefault()
              const item = pickerItems[selectedPickerIndex]
              if (item) handlePickMention(item)
            }
          }}
          className="min-h-10 w-full resize-none rounded-md border border-border bg-background px-3 py-2 pe-24 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
        />
        <div className="absolute end-2 top-2 flex items-center gap-1">
          <label
            title={
              isUploading
                ? t('editor.comments.composer.attaching')
                : t('editor.comments.composer.attachFile')
            }
            aria-label={
              isUploading
                ? t('editor.comments.composer.attachingFile')
                : t('editor.comments.composer.attachFile')
            }
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-surface-active hover:text-foreground"
          >
            <Paperclip className="size-4" aria-hidden="true" />
            <input
              type="file"
              multiple
              data-testid="comment-attachment-input"
              className="hidden"
              onChange={(event) => void handleAttachmentChange(event)}
            />
          </label>
          <button
            type="button"
            aria-label={t('editor.comments.composer.mention')}
            title={t('editor.comments.composer.mention')}
            className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-active hover:text-foreground"
            onClick={() => {
              const nextBody = body.endsWith(' ') || body.length === 0 ? `${body}@` : `${body} @`
              setBody(nextBody)
              setActiveMention({
                start: nextBody.lastIndexOf('@'),
                end: nextBody.length,
                query: ''
              })
              setPickerOpen(true)
              requestAnimationFrame(() => textareaRef.current?.focus())
            }}
          >
            <AtSign className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={t('editor.comments.composer.save')}
            title={t('editor.comments.composer.save')}
            disabled={saveDisabled}
            className="inline-flex size-7 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-35"
            onClick={() => void handleSave()}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {(mentionRefs.length > 0 || attachmentRefs.length > 0) && (
        <div className="mt-2 flex flex-col gap-2">
          {mentionRefs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {mentionRefs.map((mention) => (
                <MentionChip key={`${mention.kind}:${mention.refId}`} mention={mention} />
              ))}
            </div>
          )}
          {attachmentRefs.length > 0 && (
            <div className="flex flex-col gap-1">
              {attachmentRefs.map((ref) => (
                <div
                  key={ref}
                  data-testid="comment-attachment-row"
                  className="flex min-w-0 items-center gap-2 rounded border border-border/70 bg-muted px-2 py-1 text-xs"
                >
                  <FileText
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{attachmentFileName(ref)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachmentFileName(ref)}`}
                    className="rounded-full p-0.5 text-muted-foreground hover:bg-surface-active hover:text-foreground"
                    onClick={() => setAttachmentRefs((refs) => refs.filter((item) => item !== ref))}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function CommentCard({
  comment,
  active,
  orphaned,
  onClick,
  onUpdate,
  onDelete
}: CommentCardProps): React.JSX.Element {
  const { t } = useT('notes')
  const navigate = useMemryLinkNavigation()
  const [previewRef, setPreviewRef] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftBody, setDraftBody] = useState(comment.body)
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleSaveEdit = async (): Promise<void> => {
    if (!onUpdate || isSavingEdit || draftBody === comment.body) return
    setIsSavingEdit(true)
    try {
      await onUpdate(comment, draftBody)
      setEditing(false)
    } finally {
      setIsSavingEdit(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!onDelete || isDeleting) return
    setIsDeleting(true)
    try {
      await onDelete(comment)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={t('editor.comments.card.aria')}
        data-testid="comment-card"
        data-active={active ? 'true' : 'false'}
        data-orphaned={orphaned ? 'true' : 'false'}
        data-marquee-ignore
        className={cn(
          'rounded-md border bg-background p-3 text-start shadow-sm outline-none transition-colors',
          active
            ? 'border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950/30'
            : 'border-border/70 hover:bg-surface-active'
        )}
        onClick={() => {
          if (!editing) onClick()
        }}
        onKeyDown={(event) => {
          if (editing) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onClick()
          }
        }}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
            {t('editor.comments.card.authorInitial')}
          </span>
          <span className="min-w-0 flex-1 text-xs font-medium text-foreground">
            {t('editor.comments.card.author')}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t('editor.comments.card.timestampNow')}
          </span>
          {(onUpdate || onDelete) && (
            <div className="ms-auto flex items-center gap-0.5">
              {onUpdate && (
                <button
                  type="button"
                  aria-label={t('editor.comments.card.edit')}
                  title={t('editor.comments.card.edit')}
                  disabled={isSavingEdit || isDeleting}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-surface-active hover:text-foreground disabled:opacity-40"
                  onClick={(event) => {
                    event.stopPropagation()
                    setDraftBody(comment.body)
                    setEditing(true)
                  }}
                >
                  <PenLine className="size-3.5" aria-hidden="true" />
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  aria-label={t('editor.comments.card.delete')}
                  title={t('editor.comments.card.delete')}
                  disabled={isDeleting}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  onClick={(event) => {
                    event.stopPropagation()
                    void handleDelete()
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}
        </div>
        {orphaned && (
          <div className="mb-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            {t('editor.comments.card.anchorNotFound')}
          </div>
        )}
        {editing ? (
          <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
            <textarea
              aria-label={t('editor.comments.card.editBodyAria')}
              value={draftBody}
              onChange={(event) => setDraftBody(event.currentTarget.value)}
              className="min-h-20 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none transition-colors focus:border-primary"
              autoFocus
            />
            <div className="flex justify-end gap-1">
              <button
                type="button"
                aria-label={t('editor.comments.card.cancelEdit')}
                title={t('editor.comments.card.cancelEdit')}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-active hover:text-foreground"
                onClick={(event) => {
                  event.stopPropagation()
                  setDraftBody(comment.body)
                  setEditing(false)
                }}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={t('editor.comments.card.saveEdit')}
                title={t('editor.comments.card.saveEdit')}
                disabled={isSavingEdit || draftBody === comment.body}
                className="inline-flex size-7 items-center justify-center rounded-md bg-foreground text-background transition-opacity disabled:opacity-35"
                onClick={(event) => {
                  event.stopPropagation()
                  void handleSaveEdit()
                }}
              >
                <Check className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : (
          comment.body && (
            <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
              {comment.body}
            </p>
          )
        )}
        {comment.mentionRefs.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {comment.mentionRefs.map((mention) => (
              <MentionChip
                key={`${mention.kind}:${mention.refId}`}
                mention={mention}
                onClick={() => navigate(mentionHref(mention), mention.label)}
              />
            ))}
          </div>
        )}
        {comment.attachmentRefs.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            {comment.attachmentRefs.map((ref) => (
              <AttachmentPreviewButton key={ref} attachmentRef={ref} onPreview={setPreviewRef} />
            ))}
          </div>
        )}
      </div>
      <CommentAttachmentPreviewDialog
        attachmentRef={previewRef}
        open={Boolean(previewRef)}
        onOpenChange={(open) => {
          if (!open) setPreviewRef(null)
        }}
      />
    </>
  )
}

export function CommentsRail({
  targetId,
  comments,
  commentRects,
  draftAnchor,
  draftTop,
  activeCommentId,
  className,
  onSaveDraft,
  onCancelDraft,
  onCommentClick,
  onUpdateComment,
  onDeleteComment
}: CommentsRailProps): React.JSX.Element | null {
  const rectById = useMemo(
    () => new Map(commentRects.map((rect) => [rect.id, rect])),
    [commentRects]
  )

  const items = useMemo<RailItem[]>(() => {
    const orphanedComments = comments.filter((comment) => !rectById.has(comment.id))
    const anchoredComments = comments.filter((comment) => rectById.has(comment.id))

    const nextItems: RailItem[] = orphanedComments.map((comment, index) => ({
      key: comment.id,
      top: ORPHAN_TOP_PX + index * 72,
      estimatedHeight: estimateCommentHeight(comment, true),
      render: (top) => (
        <div
          className="absolute pointer-events-auto"
          style={{
            insetInlineStart: `calc(100% + ${RAIL_OFFSET_PX}px)`,
            top,
            width: RAIL_WIDTH_PX
          }}
        >
          <CommentCard
            comment={comment}
            active={comment.id === activeCommentId}
            orphaned
            onClick={() => onCommentClick(comment)}
            onUpdate={onUpdateComment}
            onDelete={onDeleteComment}
          />
        </div>
      )
    }))

    for (const comment of anchoredComments) {
      const rect = rectById.get(comment.id)
      if (!rect) continue
      nextItems.push({
        key: comment.id,
        top: rect.top,
        estimatedHeight: estimateCommentHeight(comment, false),
        render: (top) => (
          <div
            className="absolute pointer-events-auto"
            style={{
              insetInlineStart: `calc(100% + ${RAIL_OFFSET_PX}px)`,
              top,
              width: RAIL_WIDTH_PX
            }}
          >
            <CommentCard
              comment={comment}
              active={comment.id === activeCommentId}
              orphaned={false}
              onClick={() => onCommentClick(comment)}
              onUpdate={onUpdateComment}
              onDelete={onDeleteComment}
            />
          </div>
        )
      })
    }

    if (draftAnchor) {
      nextItems.push({
        key: 'draft',
        top: draftTop ?? ORPHAN_TOP_PX,
        estimatedHeight: 156,
        render: (top) => (
          <div
            className="absolute pointer-events-auto"
            style={{
              insetInlineStart: `calc(100% + ${RAIL_OFFSET_PX}px)`,
              top,
              width: RAIL_WIDTH_PX
            }}
          >
            <CommentComposer
              targetId={targetId}
              anchor={draftAnchor}
              onSave={(body, attachmentRefs, mentionRefs) =>
                onSaveDraft(draftAnchor, body, attachmentRefs, mentionRefs)
              }
              onCancel={onCancelDraft}
            />
          </div>
        )
      })
    }

    return nextItems
  }, [
    activeCommentId,
    comments,
    draftAnchor,
    draftTop,
    onCancelDraft,
    onCommentClick,
    onDeleteComment,
    onSaveDraft,
    onUpdateComment,
    rectById,
    targetId
  ])

  if (!draftAnchor && comments.length === 0) return null

  return (
    <div
      data-testid="comments-rail"
      data-marquee-ignore
      className={cn('pointer-events-none absolute inset-0 z-40 overflow-visible', className)}
    >
      {stackRailItems(items).map((item) => (
        <Fragment key={item.key}>{item.render(item.stackedTop)}</Fragment>
      ))}
    </div>
  )
}
