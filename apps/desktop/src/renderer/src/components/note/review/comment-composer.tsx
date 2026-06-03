import { useCallback, useMemo, useRef, useState, type ChangeEvent } from 'react'

import {
  AgentPromptEditor,
  type AgentPromptEditorHandle,
  type AgentPromptValue
} from '@/agent-chat/agent-prompt-editor'
import { type MentionAttachment } from '@/agent-chat/mention-icons'
import { RefPicker } from '@/agent-chat/ref-picker'
import { Button } from '@/components/ui/button'
import { AtSign, Loader2, Paperclip, Send, X } from '@/lib/icons'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { notesService } from '@/services/notes-service'
import { useT } from '@memry/i18n/renderer'
import type {
  CriticMarkupCommentAttachmentRef,
  CriticMarkupCommentMentionKind,
  CriticMarkupCommentMentionRef
} from '@memry/shared'
import type { SubmitCommentInput } from './use-critic-markup-review'

interface CommentComposerProps {
  targetId?: string
  onCancel: () => void
  onSubmit: (input: SubmitCommentInput) => void
}

const emptyEditorValue: AgentPromptValue = { text: '', attachments: [] }

export function CommentComposer({
  targetId,
  onCancel,
  onSubmit
}: CommentComposerProps): React.JSX.Element {
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
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
    const body = editorValue.text.trim()
    if (!body || isUploading) return

    onSubmit({ body, mentions, attachments })
    editorRef.current?.clear()
    setEditorValue(emptyEditorValue)
    setAttachments([])
    setUploadError(null)
    closeMentionPicker()
  }, [attachments, closeMentionPicker, editorValue.text, isUploading, mentions, onSubmit])

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

  return (
    <div className="critic-comment-composer relative rounded-md border border-sidebar-border bg-card shadow-sm">
      {mentionQuery !== null && (
        <RefPicker
          query={mentionQuery}
          selectedIndex={selectedMentionIndex}
          onItemsChange={setMentionItems}
          onPick={insertMention}
          onSelectedIndexChange={setSelectedMentionIndex}
          onClose={closeMentionPicker}
        />
      )}
      <div className="critic-comment-editor min-w-0">
        <AgentPromptEditor
          ref={editorRef}
          disabled={false}
          placeholder={t('comments.commentPlaceholder')}
          onEscape={onCancel}
          onMentionKeyDown={handleMentionKeyDown}
          onMentionQueryChange={setMentionQuery}
          onSubmit={handleSubmit}
          onValueChange={setEditorValue}
        />
      </div>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-sidebar-border px-2 pb-2 pt-1">
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
      {uploadError && (
        <div className="border-t border-sidebar-border px-2 py-1 text-xs text-destructive">
          {uploadError}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-sidebar-border px-1.5 py-1">
        <div className="flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            onChange={handleFileChange}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
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
            aria-label={t('comments.mentionAria')}
            onClick={() => {
              editorRef.current?.focus()
              editorRef.current?.insertText('@')
            }}
          >
            <AtSign className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div className="flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('comments.cancel')}
          </Button>
          <Button
            type="button"
            variant="default"
            size="icon-sm"
            className={cn('rounded-full', canSubmit && 'bg-primary text-primary-foreground')}
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
            <Send className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
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
