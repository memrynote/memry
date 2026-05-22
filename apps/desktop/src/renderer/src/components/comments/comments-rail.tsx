import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  AgentPromptEditor,
  type AgentPromptEditorHandle,
  type AgentPromptValue
} from '@/agent-chat/agent-prompt-editor'
import type { Comment, CommentAnchorInput, CommentMentionRef } from '@/services/comments-service'
import { notesService } from '@/services/notes-service'
import { RefPicker } from '@/agent-chat/ref-picker'
import type { MentionAttachment } from '@/agent-chat/mention-icons'
import { useMemryLinkNavigation } from '@/agent-chat/messages/memry-links'
import {
  ArrowUp,
  AtSign,
  Check,
  FileText,
  MessageCircle,
  Paperclip,
  PenLine,
  Trash2,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  attachmentFileName,
  AttachmentPreviewButton,
  CommentAttachmentPreviewDialog
} from './comment-attachments'
import { dedupeMentionRefs, toMentionRef } from './comment-compose-utils'
import { renderCommentBodyWithMentions } from './comment-mentions'
import { useCompactCommentsRail } from './use-compact-comments-rail'
import { useT } from '@memry/i18n/renderer'

export interface CommentRailRect {
  id: string
  left: number
  top: number
  width: number
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

const RAIL_OFFSET_PX = 56
const RAIL_WIDTH_PX = 284
const RAIL_GAP_PX = 10
const ORPHAN_TOP_PX = 0

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

function commentMentionRefsFromValue(value: AgentPromptValue): CommentMentionRef[] {
  return dedupeMentionRefs(
    value.attachments.flatMap((attachment) => {
      const mention = toMentionRef(attachment)
      return mention ? [mention] : []
    })
  )
}

export function CommentComposer({
  targetId,
  anchor,
  onSave,
  onCancel
}: CommentComposerProps): React.JSX.Element {
  const { t } = useT('notes')
  const promptEditorRef = useRef<AgentPromptEditorHandle>(null)
  const [body, setBody] = useState('')
  const [mentionRefs, setMentionRefs] = useState<CommentMentionRef[]>([])
  const [attachmentRefs, setAttachmentRefs] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [pickerItems, setPickerItems] = useState<MentionAttachment[]>([])
  const [selectedPickerIndex, setSelectedPickerIndex] = useState(-1)

  useEffect(() => {
    promptEditorRef.current?.clear()
    setBody('')
    setMentionRefs([])
    setAttachmentRefs([])
    setPickerOpen(false)
    setMentionQuery(null)
  }, [anchor.selectedQuote, anchor.rangeStart, anchor.rangeEnd])

  const updatePromptValue = useCallback((value: AgentPromptValue) => {
    setBody(value.text)
    setMentionRefs(commentMentionRefsFromValue(value))
  }, [])

  const closePicker = useCallback(() => {
    setMentionQuery(null)
    setPickerOpen(false)
    setPickerItems([])
    setSelectedPickerIndex(-1)
  }, [])

  const handlePickMention = useCallback(
    (attachment: MentionAttachment) => {
      promptEditorRef.current?.insertMention(attachment)
      closePicker()
    },
    [closePicker]
  )

  const handleMentionKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!pickerOpen) return false

      if (event.key === 'ArrowDown' && pickerItems.length > 0) {
        event.preventDefault()
        setSelectedPickerIndex((index) =>
          pickerItems.length === 0 ? -1 : Math.min(index + 1, pickerItems.length - 1)
        )
        return true
      }

      if (event.key === 'ArrowUp' && pickerItems.length > 0) {
        event.preventDefault()
        setSelectedPickerIndex((index) => (pickerItems.length === 0 ? -1 : Math.max(index - 1, 0)))
        return true
      }

      if (event.key === 'Enter' && !event.shiftKey && pickerItems.length > 0) {
        event.preventDefault()
        const index = selectedPickerIndex >= 0 ? selectedPickerIndex : 0
        const item = pickerItems[index]
        if (item) handlePickMention(item)
        return true
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        closePicker()
        return true
      }

      return false
    },
    [closePicker, handlePickMention, pickerItems, pickerOpen, selectedPickerIndex]
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
    const value = promptEditorRef.current?.getValue()
    const nextBody = value?.text.trim() ?? body.trim()
    const nextMentionRefs = value ? commentMentionRefsFromValue(value) : mentionRefs
    setIsSaving(true)
    try {
      await onSave(nextBody, attachmentRefs, nextMentionRefs)
      promptEditorRef.current?.clear()
      setBody('')
      setMentionRefs([])
      setAttachmentRefs([])
      closePicker()
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
        {pickerOpen && mentionQuery !== null && (
          <RefPicker
            query={mentionQuery}
            selectedIndex={selectedPickerIndex}
            onItemsChange={setPickerItems}
            onPick={handlePickMention}
            onSelectedIndexChange={setSelectedPickerIndex}
            onClose={closePicker}
          />
        )}
        <div
          className="max-h-40 overflow-y-auto [&_.ProseMirror]:!min-h-10 [&_.ProseMirror]:px-2 [&_.ProseMirror]:py-2 [&_.ProseMirror]:pe-24 [&_.ProseMirror]:text-sm"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            if (
              event.target instanceof HTMLElement &&
              event.target.closest('[contenteditable="true"]')
            ) {
              return
            }
            event.preventDefault()
            promptEditorRef.current?.focus()
          }}
        >
          <AgentPromptEditor
            ref={promptEditorRef}
            disabled={isSaving || isUploading}
            placeholder={t('editor.comments.composer.bodyAria')}
            onEscape={onCancel}
            onMentionKeyDown={handleMentionKeyDown}
            onMentionQueryChange={(query) => {
              setMentionQuery(query)
              setPickerOpen(query !== null)
              if (query === null) {
                setPickerItems([])
                setSelectedPickerIndex(-1)
              }
            }}
            onSubmit={() => void handleSave()}
            onValueChange={updatePromptValue}
          />
        </div>
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
              aria-label={
                isUploading
                  ? t('editor.comments.composer.attachingFile')
                  : t('editor.comments.composer.attachFile')
              }
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
              promptEditorRef.current?.insertMentionTrigger()
              setSelectedPickerIndex(-1)
              setPickerOpen(true)
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

      {attachmentRefs.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            {attachmentRefs.map((ref) => (
              <div
                key={ref}
                data-testid="comment-attachment-row"
                className="flex min-w-0 items-center gap-2 rounded border border-border/70 bg-muted px-2 py-1 text-xs"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
  const editDisabled = isSavingEdit || draftBody === comment.body

  const handleSaveEdit = async (): Promise<void> => {
    if (!onUpdate || editDisabled) return
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
          'group translate-x-0 transform-gpu rounded-md border bg-background p-3 text-start shadow-sm outline-none transition-[transform,background-color,border-color,box-shadow] duration-200 ease-out hover:-translate-x-[7px]',
          editing && '-translate-x-[7px]',
          active ? 'border-border/70 bg-background' : 'border-border/70 hover:bg-surface-active'
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
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            {t('editor.comments.card.timestampNow')}
          </span>
          {(onUpdate || onDelete) && (
            <div
              className={cn(
                'ms-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-within:opacity-100',
                editing && 'opacity-100'
              )}
            >
              {onUpdate && (
                <button
                  type="button"
                  aria-label={t('editor.comments.card.edit')}
                  title={t('editor.comments.card.edit')}
                  disabled={isSavingEdit || isDeleting}
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-active hover:text-foreground disabled:opacity-40"
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
                  className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
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
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void handleSaveEdit()
                }
              }}
              className="min-h-20 w-full resize-none rounded-md border-0 bg-transparent px-1 py-1.5 text-sm outline-none focus:ring-0"
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
                disabled={editDisabled}
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
          (comment.body || comment.mentionRefs.length > 0) && (
            <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
              {renderCommentBodyWithMentions({ comment, navigate })}
            </p>
          )
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
  const { t } = useT('notes')
  const isCompact = useCompactCommentsRail()
  const [compactOpenCommentId, setCompactOpenCommentId] = useState<string | null>(null)
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

  if (isCompact) {
    const orderedComments = [...comments].sort((a, b) => {
      const aRect = rectById.get(a.id)
      const bRect = rectById.get(b.id)
      return (aRect?.top ?? ORPHAN_TOP_PX) - (bRect?.top ?? ORPHAN_TOP_PX)
    })

    return (
      <div
        data-testid="comments-rail"
        data-marquee-ignore
        className={cn('pointer-events-none absolute inset-0 z-40 overflow-visible', className)}
      >
        {orderedComments.map((comment, index) => {
          const rect = rectById.get(comment.id)
          const markerTop = rect?.top ?? ORPHAN_TOP_PX + index * 42
          const cardLeft = Math.max(rect?.left ?? 0, 0)
          const cardTop = rect ? rect.top + rect.height + 8 : markerTop + 30
          const isOpen = compactOpenCommentId === comment.id || activeCommentId === comment.id

          return (
            <Fragment key={comment.id}>
              <button
                type="button"
                data-testid="compact-comment-marker"
                aria-label={t('editor.comments.card.aria')}
                className="pointer-events-auto absolute z-40 inline-flex h-6 min-w-9 items-center justify-center gap-1 rounded-full border border-border/70 bg-background/95 px-1.5 text-[10px] font-semibold text-muted-foreground shadow-sm transition-colors hover:bg-surface-active hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  insetInlineEnd: 0,
                  top: markerTop
                }}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setCompactOpenCommentId((current) => (current === comment.id ? null : comment.id))
                  onCommentClick(comment)
                }}
              >
                <MessageCircle className="size-3" aria-hidden="true" />
                <span className="min-w-3 before:content-['+1']" aria-hidden="true" />
              </button>

              {isOpen && (
                <div
                  className="pointer-events-auto absolute z-50"
                  style={{
                    insetInlineStart: cardLeft,
                    top: cardTop,
                    width: `min(${RAIL_WIDTH_PX}px, calc(100% - ${cardLeft}px))`
                  }}
                >
                  <CommentCard
                    comment={comment}
                    active={comment.id === activeCommentId}
                    orphaned={!rect}
                    onClick={() => onCommentClick(comment)}
                    onUpdate={onUpdateComment}
                    onDelete={onDeleteComment}
                  />
                </div>
              )}
            </Fragment>
          )
        })}

        {draftAnchor && (
          <div
            className="pointer-events-auto absolute z-50"
            style={{
              insetInlineStart: 0,
              top: draftTop ?? ORPHAN_TOP_PX,
              width: `min(${RAIL_WIDTH_PX}px, 100%)`
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
        )}
      </div>
    )
  }

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
