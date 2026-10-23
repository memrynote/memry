import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'

/**
 * `share` hands a link to the native share sheet where the browser has one (phones,
 * Safari) and copies it everywhere else; `copy` always copies.
 */
export type ClipboardIntent =
  | { kind: 'share'; title: string; url: string }
  | { kind: 'copy'; text: string }

type Status = 'idle' | 'copied' | 'failed'

const RESET_MS = 1600

export function ClipboardButton({
  intent,
  label,
  srLabel,
  icon,
  className,
  onSuccess
}: {
  intent: ClipboardIntent
  label: string
  /** Read after the visible label, e.g. " the Homebrew command". */
  srLabel?: string
  icon: ReactNode
  className: string
  onSuccess: () => void
}) {
  const [status, setStatus] = useState<Status>('idle')
  const resetTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    },
    []
  )

  const flash = (next: Exclude<Status, 'idle'>) => {
    setStatus(next)
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => {
      setStatus('idle')
    }, RESET_MS)
  }

  const run = async () => {
    if (intent.kind === 'share' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: intent.title, url: intent.url })
        onSuccess()
        return
      } catch (error) {
        // Closing the share sheet is the visitor's own cancel, not a failure.
        if (error instanceof DOMException && error.name === 'AbortError') return
        // Any other refusal (no user activation, a permissions policy) falls back to copying.
      }
    }

    try {
      await navigator.clipboard.writeText(intent.kind === 'share' ? intent.url : intent.text)
      onSuccess()
      flash('copied')
    } catch {
      // Insecure context or a denied permission. The text stays visible on the page.
      flash('failed')
    }
  }

  const copiedLabel = intent.kind === 'share' ? 'Link copied' : 'Copied'
  const visibleLabel =
    status === 'copied' ? copiedLabel : status === 'failed' ? 'Copy failed' : label

  return (
    <>
      <button type="button" onClick={() => void run()} className={className}>
        {visibleLabel}
        {srLabel && <span className="sr-only">{srLabel}</span>}
        {status === 'copied' ? <Check className="size-3.5 shrink-0" aria-hidden /> : icon}
      </button>
      <span aria-live="polite" className="sr-only">
        {status === 'idle' ? '' : visibleLabel}
      </span>
    </>
  )
}
