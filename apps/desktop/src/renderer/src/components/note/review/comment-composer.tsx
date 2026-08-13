import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent
} from 'react'

import {
  AgentPromptEditor,
  type AgentPromptEditorHandle,
  type AgentPromptSeedPart,
  type AgentPromptValue
} from '@/agent-chat/agent-prompt-editor'
import { type MentionAttachment } from '@/agent-chat/mention-icons'
import { RefPicker } from '@/agent-chat/ref-picker'
import { Button } from '@/components/ui/button'
import { ArrowUp, AtSign, Loader2, Paperclip, X } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { cn } from '@/lib/utils'
import { notesService } from '@/services/notes-service'
import type { Editor } from '@tiptap/core'
import { useT } from '@memry/i18n/renderer'
import type {
  CriticMarkupCommentAttachmentRef,
  CriticMarkupCommentMentionKind,
  CriticMarkupCommentMentionRef
} from '@memry/shared'
import {
  iconForMention,
  splitCommentBodyWithFormat,
  trimCommentBodyWithFormat
} from './comment-body'
import { CommentFormatToolbar } from './comment-format-toolbar'
import type { SubmitCommentInput } from './use-critic-markup-review'

interface CommentComposerProps {
  targetId?: string
  /** When set, the composer edits an existing comment seeded with this content. */
  initialValue?: SubmitCommentInput
  onCancel: () => void
  onSubmit: (input: SubmitCommentInput) => void
}

const emptyEditorValue: AgentPromptValue = { text: '', attachments: [], formatRanges: [] }

export function CommentComposer({
  targetId,
  initialValue,
  onCancel,
  onSubmit
}: CommentComposerProps): React.JSX.Element {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const composerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<AgentPromptEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [editorValue, setEditorValue] = useState<AgentPromptValue>(emptyEditorValue)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionItems, setMentionItems] = useState<MentionAttachment[]>([])
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(-1)
  const [attachments, setAttachments] = useState<CriticMarkupCommentAttachmentRef[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  const mentions = useMemo(() => commentMentionsFromEditorValue(editorValue), [editorValue])
  const canSubmit = editorValue.text.trim().length > 0 && !isUploading
  const hasDraftContent =
    editorValue.text.trim().length > 0 || attachments.length > 0 || isUploading

  const isEditing = initialValue !== undefined

  const cancelIfEmpty = useCallback(() => {
    // Editing an existing comment always cancels back to read mode; a fresh
    // draft only auto-cancels while it has no content worth keeping.
    if (!isEditing && hasDraftContent) return
    onCancel()
  }, [hasDraftContent, isEditing, onCancel])

  const closeMentionPicker = useCallback(() => {
    setMentionQuery(null)
    setMentionItems([])
    setSelectedMentionIndex(-1)
  }, [])

  const insertMention = useCallback(
    (attachment: MentionAttachment) => {
      editorRef.current?.insertMention(attachment)
      closeMentionPicker()
    },
    [closeMentionPicker]
  )

  const handleMentionKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (mentionQuery === null) return false

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedMentionIndex((index) =>
          mentionItems.length === 0 ? -1 : (index + 1 + mentionItems.length) % mentionItems.length
        )
        return true
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedMentionIndex((index) =>
          mentionItems.length === 0 ? -1 : (index - 1 + mentionItems.length) % mentionItems.length
        )
        return true
      }

      if ((event.key === 'Enter' || event.key === 'Tab') && selectedMentionIndex >= 0) {
        const item = mentionItems[selectedMentionIndex]
        if (!item) return false
        event.preventDefault()
        insertMention(item)
        return true
      }

      if (event.key === 'Escape') {
        closeMentionPicker()
        return true
      }

      return false
    },
    [closeMentionPicker, insertMention, mentionItems, mentionQuery, selectedMentionIndex]
  )

  const handleSubmit = useCallback(() => {
    // Trim here and only here — the offsets shift with the text, and the
    // storage layer trims again downstream.
    const { body, formatRanges } = trimCommentBodyWithFormat(
      editorValue.text,
      editorValue.formatRanges
    )
    if (!body || isUploading) return

    onSubmit({ body, mentions, attachments, formatRanges })
    editorRef.current?.clear()
    setEditorValue(emptyEditorValue)
    setAttachments([])
    setUploadError(null)
    closeMentionPicker()
  }, [
    attachments,
    closeMentionPicker,
    editorValue.formatRanges,
    editorValue.text,
    isUploading,
    mentions,
    onSubmit
  ])

  const renderFormatToolbar = useCallback(
    (editor: Editor) => <CommentFormatToolbar editor={editor} suppressed={mentionQuery !== null} />,
    [mentionQuery]
  )

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? [])
      event.target.value = ''
      if (!targetId || files.length === 0) return

      void uploadFiles(
        targetId,
        files,
        tCommon('toast.actionFailed'),
        (nextAttachments) => {
          setAttachments((current) => [...current, ...nextAttachments])
        },
        setUploadError,
        setIsUploading
      )
    },
    [targetId, tCommon]
  )

  const initialValueRef = useRef(initialValue)

  useLayoutEffect(() => {
    const initial = initialValueRef.current
    if (initial) {
      editorRef.current?.seed(seedPartsFromComment(initial))
      setAttachments(initial.attachments)
    }
    editorRef.current?.focus()
  }, [])

  useEffect(() => {
    const composer = composerRef.current
    if (!composer) return

    const ownerDocument = composer.ownerDocument
    const ownerWindow = ownerDocument.defaultView ?? window
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      // The mention picker renders in a body-level portal, so its options sit
      // outside the composer subtree; treat clicks inside it as inside.
      if (
        target instanceof Element &&
        target.closest('[data-ref-picker], [data-comment-format-toolbar]')
      ) {
        return
      }
      if (composer.contains(target)) return
      cancelIfEmpty()
    }

    const frame = ownerWindow.requestAnimationFrame(() => {
      ownerDocument.addEventListener('pointerdown', handlePointerDown)
    })

    return () => {
      ownerWindow.cancelAnimationFrame(frame)
      ownerDocument.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [cancelIfEmpty])

  return (
    <div
      ref={composerRef}
      className="critic-comment-composer relative rounded-md border border-sidebar-border bg-background shadow-sm transition-colors hover:bg-[var(--surface-active)]"
    >
      {mentionQuery !== null && (
        <RefPicker
          query={mentionQuery}
          selectedIndex={selectedMentionIndex}
          anchorRef={composerRef}
          onItemsChange={setMentionItems}
          onPick={insertMention}
          onSelectedIndexChange={setSelectedMentionIndex}
          onClose={closeMentionPicker}
        />
      )}
      <div className="critic-comment-main-row">
        <div className="critic-comment-editor min-w-0 flex-1">
          <AgentPromptEditor
            ref={editorRef}
            disabled={false}
            editorClassName="!min-h-[22px] max-h-[130px] overflow-y-auto !p-0 !py-0.5 !text-[13px] !leading-5"
            placeholder={t('comments.commentPlaceholder')}
            richTextMarks
            renderSelectionToolbar={renderFormatToolbar}
            onEscape={cancelIfEmpty}
            onMentionKeyDown={handleMentionKeyDown}
            onMentionQueryChange={setMentionQuery}
            onSubmit={handleSubmit}
            onValueChange={setEditorValue}
          />
        </div>
        <div className="critic-comment-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label={t('comments.attachAria')}
            className="sr-only"
            tabIndex={-1}
            onChange={handleFileChange}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="critic-comment-action-button"
            aria-label={t('comments.attachAria')}
            disabled={!targetId || isUploading}
            onClick={handleAttachClick}
          >
            {isUploading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Paperclip className="size-3.5" aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="critic-comment-action-button"
            aria-label={t('comments.mentionAria')}
            onClick={() => {
              editorRef.current?.focus()
              editorRef.current?.insertMentionTrigger()
            }}
          >
            <AtSign className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className={cn('critic-comment-send-button', canSubmit && 'critic-comment-send-ready')}
            aria-label={t('comments.sendAria')}
            disabled={!canSubmit}
            onPointerDown={(event) => {
              if (!canSubmit) return
              event.preventDefault()
              handleSubmit()
            }}
            onClick={() => {
              if (canSubmit) handleSubmit()
            }}
          >
            <ArrowUp className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {attachments.length > 0 && (
        <div className="critic-comment-attachments">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground"
            >
              <Paperclip className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{attachment.name}</span>
              <button
                type="button"
                className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full hover:bg-background"
                aria-label={`${tCommon('button.remove')} ${attachment.name}`}
                onClick={() =>
                  setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                }
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      {uploadError && <div className="critic-comment-error">{uploadError}</div>}
    </div>
  )
}

function seedPartsFromComment(initial: SubmitCommentInput): AgentPromptSeedPart[] {
  return splitCommentBodyWithFormat(initial.body, initial.mentions, initial.formatRanges).map(
    (part) =>
      part.kind === 'mention'
        ? {
            kind: 'mention' as const,
            attachment: {
              kind: part.mention.kind,
              ref_id: part.mention.refId,
              label: part.mention.label,
              icon: iconForMention(part.mention)
            },
            marks: part.marks
          }
        : { kind: 'text' as const, text: part.text, marks: part.marks }
  )
}

function commentMentionsFromEditorValue(value: AgentPromptValue): CriticMarkupCommentMentionRef[] {
  const seen = new Set<string>()
  return value.attachments.flatMap((attachment) => {
    if (!isCommentMentionKind(attachment.kind)) return []
    const key = `${attachment.kind}:${attachment.ref_id}`
    if (seen.has(key)) return []
    seen.add(key)
    return [
      {
        kind: attachment.kind,
        refId: attachment.ref_id,
        label: attachment.label
      }
    ]
  })
}

async function uploadFiles(
  targetId: string,
  files: File[],
  fallbackError: string,
  onUploaded: (attachments: CriticMarkupCommentAttachmentRef[]) => void,
  setUploadError: (error: string | null) => void,
  setIsUploading: (value: boolean) => void
): Promise<void> {
  setIsUploading(true)
  setUploadError(null)

  const uploaded: CriticMarkupCommentAttachmentRef[] = []
  for (const file of files) {
    try {
      const result = await notesService.uploadAttachment(targetId, file)
      if (!result.success || !result.path) {
        // Envelope failure carries no exception; the main-side save path is
        // silent, so this is the only place the failure can be reported.
        trackRendererError(
          'comment_attachment_upload_failed',
          new Error(result.error || 'attachment upload failed')
        )
        setUploadError(result.error || fallbackError)
        continue
      }

      uploaded.push({
        id: result.path,
        name: result.name ?? file.name,
        path: result.path,
        ...(typeof result.size === 'number' ? { size: result.size } : { size: file.size }),
        ...(result.mimeType || file.type ? { mimeType: result.mimeType ?? file.type } : {}),
        ...(result.type ? { type: result.type } : {})
      })
    } catch (err) {
      trackRendererError('comment_attachment_upload_failed', err)
      setUploadError(extractErrorMessage(err, fallbackError))
    }
  }

  if (uploaded.length > 0) onUploaded(uploaded)
  setIsUploading(false)
}

function isCommentMentionKind(kind: unknown): kind is CriticMarkupCommentMentionKind {
  return (
    kind === 'note' ||
    kind === 'task' ||
    kind === 'journal' ||
    kind === 'inbox' ||
    kind === 'calendar_event'
  )
}
