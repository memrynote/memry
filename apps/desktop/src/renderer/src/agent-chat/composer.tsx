import { useEffect, useState } from 'react'

import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import { useT } from '@memry/i18n/renderer'

import {
  PromptInput,
  PromptInputActions,
  PromptInputSubmit,
  PromptInputTextarea
} from '@/components/ai-elements/prompt-input'
import { useActiveTab } from '@/contexts/tabs'
import { Send, Square, X } from '@/lib/icons'
import { useAgentOptional } from './agent-context'
import { RefPicker } from './ref-picker'

interface ComposerProps {
  conversationId: string | null
  sourceWindowId: string | null
}

function getRefQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text)
  return match?.[1] ?? null
}

export function Composer({ conversationId, sourceWindowId }: ComposerProps): React.JSX.Element {
  const { t } = useT('common')
  const agent = useAgentOptional()
  const activeTab = useActiveTab()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentInput[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (activeTab?.type !== 'note' || !activeTab.entityId) return
    setAttachments((current) => {
      const label = activeTab.title || t('agentChat.composer.currentNote')
      const currentNote = current.find((attachment) => attachment.kind === 'current_note')
      if (currentNote) {
        if (currentNote.label === label) return current
        return current.map((attachment) =>
          attachment.kind === 'current_note' ? { ...attachment, label } : attachment
        )
      }
      return [
        ...current,
        {
          kind: 'current_note',
          ref_id: '__current__',
          label
        }
      ]
    })
  }, [activeTab?.entityId, activeTab?.title, activeTab?.type, t])

  const turnInFlight = conversationId ? agent?.state.inFlight?.[conversationId] === true : false
  const busy = turnInFlight || submitting
  const canSend = Boolean(agent) && Boolean(sourceWindowId) && text.trim().length > 0 && !busy
  const pickerQuery = pickerOpen ? (getRefQuery(text) ?? '') : ''

  async function submit(): Promise<void> {
    if (!agent || !sourceWindowId || !text.trim() || busy) return
    const currentText = text
    const currentAttachments = attachments
    setSubmitting(true)
    try {
      const targetConversationId = conversationId ?? (await agent.createConversation()).id
      await agent.sendTurn({
        conversationId: targetConversationId,
        sourceWindowId,
        text: currentText,
        attachments: currentAttachments
      })
      setText('')
      setAttachments((current) =>
        current.filter((attachment) => attachment.kind === 'current_note')
      )
    } catch {
      // Agent context owns the user-facing error; leave the draft text in place.
    } finally {
      setSubmitting(false)
    }
  }

  function cancelTurn(): void {
    if (!agent || !conversationId || !turnInFlight) return

    void agent.cancelTurn(conversationId)
  }

  function removeAttachment(refId: string): void {
    setAttachments((current) => current.filter((attachment) => attachment.ref_id !== refId))
  }

  return (
    <div className="relative border-t border-sidebar-border p-2">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {attachments.map((attachment) => (
            <span
              key={`${attachment.kind}-${attachment.ref_id}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground"
            >
              <span className="truncate">{attachment.label}</span>
              <button
                type="button"
                aria-label={t('agentChat.composer.removeAttachment', { label: attachment.label })}
                onClick={() => removeAttachment(attachment.ref_id)}
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
      {pickerOpen && (
        <RefPicker
          query={pickerQuery}
          onPick={(attachment) => {
            setAttachments((current) => {
              if (
                current.some(
                  (existing) =>
                    existing.kind === attachment.kind && existing.ref_id === attachment.ref_id
                )
              ) {
                return current
              }
              return [...current, attachment]
            })
            setText((current) => current.replace(/@\S*$/, ''))
            setPickerOpen(false)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <PromptInput onSubmit={() => void submit()}>
        <PromptInputActions>
          <PromptInputTextarea
            value={text}
            onChange={(event) => {
              const nextText = event.target.value
              setText(nextText)
              setPickerOpen(getRefQuery(nextText) !== null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
              if (event.key === 'Escape') setPickerOpen(false)
            }}
            rows={3}
            disabled={busy || !agent}
            placeholder={t('agentChat.composer.placeholder')}
            className="flex-1"
          />
          {turnInFlight ? (
            <PromptInputSubmit
              type="button"
              aria-label={t('agentChat.stop')}
              disabled={!agent}
              onClick={cancelTurn}
            >
              <Square className="size-4" aria-hidden="true" />
            </PromptInputSubmit>
          ) : (
            <PromptInputSubmit aria-label={t('agentChat.composer.send')} disabled={!canSend}>
              <Send className="size-4" aria-hidden="true" />
            </PromptInputSubmit>
          )}
        </PromptInputActions>
      </PromptInput>
    </div>
  )
}
