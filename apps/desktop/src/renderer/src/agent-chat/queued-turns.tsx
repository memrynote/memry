import { useState } from 'react'

import { useT } from '@memry/i18n/renderer'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Pencil, X } from '@/lib/icons'

import type { QueuedTurn } from './agent-context.reducer'

interface QueuedTurnsProps {
  turns: QueuedTurn[]
  onEditingChange: (id: string, editing: boolean) => void
  onEdit: (id: string, text: string) => void
  onRemove: (id: string) => void
  /** Called after an action that unmounts the focused control, so focus has somewhere to go. */
  onSettled: () => void
}

const iconButtonClassName =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export function QueuedTurns({
  turns,
  onEditingChange,
  onEdit,
  onRemove,
  onSettled
}: QueuedTurnsProps): React.JSX.Element | null {
  const { t } = useT('common')
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  if (turns.length === 0) return null

  const setDraft = (id: string, text: string | null): void =>
    setDrafts(({ [id]: _previous, ...rest }) => (text === null ? rest : { ...rest, [id]: text }))
  const saveEdit = (id: string): void => {
    const text = drafts[id]?.trimEnd()
    if (!text?.trim()) return
    onEdit(id, text)
    setDraft(id, null)
    onSettled()
  }
  const cancelEdit = (id: string): void => {
    onEditingChange(id, false)
    setDraft(id, null)
    onSettled()
  }

  return (
    <section aria-label={t('agentChat.composer.queue.label')} className="mb-2 flex flex-col gap-1">
      <p className="ps-1 text-xs text-muted-foreground">{t('agentChat.composer.queue.label')}</p>
      <ol className="flex flex-col gap-1">
        {turns.map((turn) => {
          const draft = drafts[turn.id] ?? turn.text
          const isEditing = turn.editing === true && turn.status !== 'sending'
          return (
            <li
              key={turn.id}
              className="flex items-start gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-[13px] leading-[18px]"
            >
              {isEditing ? (
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Textarea
                    autoFocus
                    aria-label={t('agentChat.composer.queue.editLabel')}
                    value={draft}
                    onChange={(event) => setDraft(turn.id, event.target.value)}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault()
                        saveEdit(turn.id)
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        cancelEdit(turn.id)
                      }
                    }}
                    className="min-h-[54px] resize-none text-[13px] leading-[18px] md:text-[13px]"
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => cancelEdit(turn.id)}
                    >
                      {t('agentChat.composer.queue.cancel')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!draft.trim()}
                      onClick={() => saveEdit(turn.id)}
                    >
                      {t('agentChat.composer.queue.save')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-3 whitespace-pre-wrap break-words text-foreground">
                      {turn.text}
                    </p>
                    {turn.status !== 'queued' && (
                      <p
                        className={
                          turn.status === 'failed'
                            ? 'mt-0.5 text-xs text-destructive'
                            : 'mt-0.5 text-xs text-muted-foreground'
                        }
                      >
                        {turn.status === 'failed'
                          ? t('agentChat.composer.queue.notSent')
                          : t('agentChat.composer.queue.sending')}
                      </p>
                    )}
                  </div>
                  {turn.status !== 'sending' && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={t('agentChat.composer.queue.edit')}
                        onClick={() => {
                          setDraft(turn.id, turn.text)
                          onEditingChange(turn.id, true)
                        }}
                        className={iconButtonClassName}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={t('agentChat.composer.queue.remove')}
                        onClick={() => {
                          onRemove(turn.id)
                          onSettled()
                        }}
                        className={iconButtonClassName}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
