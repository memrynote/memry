import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { STICKY_KINDS, type StickyKind, type StickySendResult } from '@memry/contracts/sticky-api'
import { useT } from '@memry/i18n/renderer'
import { Loader2, Minus, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { StickyInput } from './sticky-input'
import { StickyKindBar } from './sticky-kind-bar'
import { StickySent } from './sticky-sent'
import { useStickyDraft } from './use-sticky-draft'

/** How long a deleted draft can be brought back. */
const DELETE_UNDO_MS = 5000

type SentState = Extract<StickySendResult, { success: true }>

const isMac = navigator.platform.includes('Mac')
const MOD_KEY = isMac ? '⌘' : 'Ctrl+'

/**
 * The sticky card. Its text goes to a note in the Sticky folder, a task, or
 * today's journal. Unsent text is a synced draft, so Esc and clicking away tuck
 * the sticky to the edge tab instead of losing anything.
 */
export function StickyCapture(): React.JSX.Element {
  const { t } = useT('inbox')
  const draft = useStickyDraft()
  const { isEnabled } = useFeatureFlags()

  const [sent, setSent] = useState<SentState | null>(null)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [deleted, setDeleted] = useState<{ content: string; kind: StickyKind } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const kinds = useMemo(
    () =>
      STICKY_KINDS.filter(
        (kind) =>
          kind === 'note' ||
          (kind === 'task' && isEnabled('tasks')) ||
          (kind === 'journal' && isEnabled('journal'))
      ),
    [isEnabled]
  )
  const kind: StickyKind = kinds.includes(draft.kind) ? draft.kind : 'note'

  useEffect(() => {
    if (draft.ready) textareaRef.current?.focus()
  }, [draft.ready])

  const tuck = useCallback(async () => {
    await draft.flush()
    await window.api.sticky.tuck()
  }, [draft])

  const send = useCallback(
    async (close: boolean) => {
      if (sending) return
      const draftId = await draft.flush()
      if (!draft.content.trim()) return
      setSending(true)
      setSendError('')
      try {
        const result = await window.api.sticky.send({ draftId, content: draft.content, kind })
        if (!result.success) {
          setSendError(result.error)
          return
        }
        draft.clear()
        if (close) await window.api.sticky.tuck()
        else setSent(result)
      } catch (err) {
        setSendError(extractErrorMessage(err, t('sticky.errors.sendFailed')))
      } finally {
        setSending(false)
      }
    },
    [sending, draft, kind, t]
  )

  const removeDraft = useCallback(async () => {
    const removed = await draft.discard()
    if (removed) setDeleted(removed)
  }, [draft])

  const undoDelete = useCallback(() => {
    if (!deleted) return
    draft.restore(deleted.content, deleted.kind)
    setDeleted(null)
  }, [deleted, draft])

  useEffect(() => {
    if (!deleted) return
    const timer = window.setTimeout(() => {
      setDeleted(null)
    }, DELETE_UNDO_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [deleted])

  useEffect(() => {
    if (sent) return
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Escape') {
        e.preventDefault()
        void tuck()
      } else if (mod && e.key === 'Enter') {
        e.preventDefault()
        void send(e.altKey)
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const next = kinds[Number(e.key) - 1]
        if (next) {
          e.preventDefault()
          draft.setKind(next)
        }
      } else if (mod && e.key === 'Backspace') {
        e.preventDefault()
        void removeDraft()
      } else if (mod && e.key.toLowerCase() === 'z' && deleted) {
        e.preventDefault()
        undoDelete()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [sent, kinds, draft, deleted, tuck, send, removeDraft, undoDelete])

  // Clicking away tucks the sticky.
  useEffect(() => {
    const onBlur = (): void => void tuck()
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
    }
  }, [tuck])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // The border box: the margin the card's shadow draws into counts too.
    const observer = new ResizeObserver(() => {
      const height = el.getBoundingClientRect().height
      if (height > 0) void window.api.sticky.resize(Math.ceil(height))
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [])

  const undoSend = useCallback(async () => {
    if (!sent?.undoToken) return
    const result = await window.api.sticky.undoSend(sent.undoToken)
    setSent(null)
    if (result.success) draft.adopt(result.draft)
    else setSendError(result.error)
  }, [sent, draft])

  return (
    <div ref={containerRef} className="p-2.5">
      <div
        className={cn(
          'drag-region relative flex flex-col overflow-hidden rounded-[14px]',
          'border border-border bg-popover text-popover-foreground',
          'shadow-[0_10px_28px_rgba(0,0,0,0.18),0_1px_3px_rgba(0,0,0,0.12)]'
        )}
      >
        {sent ? (
          <StickySent
            kind={sent.kind}
            title={sent.title}
            canUndo={sent.undoToken !== null}
            modKey={MOD_KEY}
            onOpen={() =>
              void window.api.sticky.openTarget({ kind: sent.kind, targetId: sent.targetId })
            }
            onUndo={() => void undoSend()}
            onDone={() => void window.api.sticky.tuck()}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 pt-2.5">
              <StickyKindBar kinds={kinds} value={kind} onChange={draft.setKind} modKey={MOD_KEY} />
              <span aria-live="polite" className="ms-auto text-[11px]/4 text-muted-foreground">
                {draft.saveStatus === 'saving' && t('sticky.saving')}
                {draft.saveStatus === 'saved' && t('sticky.saved')}
                {draft.saveStatus === 'failed' && t('sticky.saveFailed')}
              </span>
              <button
                type="button"
                onClick={() => void tuck()}
                aria-label={t('sticky.tuck')}
                title={`${t('sticky.tuck')} (Esc)`}
                className="no-drag flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--tint)]"
              >
                <Minus className="size-3.5" />
              </button>
            </div>

            <StickyInput
              value={draft.content}
              onChange={(next) => {
                draft.setContent(next)
                setSendError('')
              }}
              placeholder={t(`sticky.placeholders.${kind}`)}
              disabled={sending || !draft.ready}
              textareaRef={textareaRef}
            />

            {sendError && (
              <div role="alert" className="flex items-center gap-2 px-4 pb-1 text-[12px]/4">
                <span className="flex-1 truncate text-destructive">{sendError}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSendError('')
                  }}
                  aria-label={t('sticky.dismissError')}
                  className="no-drag shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            )}

            {deleted && (
              <div role="status" className="flex items-center gap-2 px-4 pb-1 text-[12px]/4">
                <span className="text-muted-foreground">{t('sticky.deleted')}</span>
                <button
                  type="button"
                  onClick={undoDelete}
                  className="no-drag font-medium text-[var(--tint)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--tint)]"
                >
                  {t('sticky.undo')} {`${MOD_KEY}Z`}
                </button>
              </div>
            )}

            <div className="flex items-center gap-3 px-4 pt-1 pb-3 text-[11px]/4">
              <span className="text-muted-foreground">{t('sticky.hints', { mod: MOD_KEY })}</span>
              <button
                type="button"
                onClick={(e) => void send(e.altKey)}
                disabled={sending || !draft.content.trim()}
                title={t('sticky.sendAndCloseHint', { mod: MOD_KEY })}
                className={cn(
                  'no-drag ms-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5',
                  'bg-[var(--tint)] text-[12px]/4 font-medium text-[var(--tint-foreground)]',
                  'hover:bg-[var(--tint-hover)] disabled:opacity-40',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tint)]'
                )}
              >
                {sending && <Loader2 className="size-3.5 animate-spin" />}
                {t('sticky.send')}
                <span className="opacity-75">{MOD_KEY}↵</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
