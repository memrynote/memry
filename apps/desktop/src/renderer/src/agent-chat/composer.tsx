import { useEffect, useState } from 'react'

import type { AttachmentInput } from '@memry/contracts/ipc-agent'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useActiveTab } from '@/contexts/tabs'
import { Send, X } from '@/lib/icons'
import { useAgentOptional } from './agent-context'
import { RefPicker } from './ref-picker'

interface ComposerProps {
  conversationId: string
  sourceWindowId: string
}

function getRefQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text)
  return match?.[1] ?? null
}

export function Composer({ conversationId, sourceWindowId }: ComposerProps): React.JSX.Element {
  const agent = useAgentOptional()
  const activeTab = useActiveTab()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentInput[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    if (activeTab?.type !== 'note' || !activeTab.entityId) return
    setAttachments((current) => {
      const label = activeTab.title || 'Current note'
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
  }, [activeTab?.entityId, activeTab?.title, activeTab?.type])

  const inFlight = agent?.state.inFlight?.[conversationId] === true
  const canSend = Boolean(agent) && text.trim().length > 0 && !inFlight
  const pickerQuery = pickerOpen ? (getRefQuery(text) ?? '') : ''

  function submit(): void {
    if (!agent || !text.trim() || inFlight) return
    const currentText = text
    const currentAttachments = attachments
    void agent.sendTurn({
      conversationId,
      sourceWindowId,
      text: currentText,
      attachments: currentAttachments
    })
    setText('')
    setAttachments((current) => current.filter((attachment) => attachment.kind === 'current_note'))
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
                aria-label={`Remove ${attachment.label}`}
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
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(event) => {
            const nextText = event.target.value
            setText(nextText)
            setPickerOpen(getRefQuery(nextText) !== null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
            if (event.key === 'Escape') setPickerOpen(false)
          }}
          rows={3}
          disabled={inFlight || !agent}
          placeholder="Ask Agent"
          className="min-h-20 resize-none bg-background text-sm"
        />
        <Button type="button" size="icon-sm" aria-label="Send" disabled={!canSend} onClick={submit}>
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
