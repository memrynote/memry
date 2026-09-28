import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { ThinkingState } from './thinking-state'

/**
 * AICSS Thinking + Reasoning, driven by live data instead of the demo script:
 * while the model thinks, a shimmering label sits over a viewport that grows
 * with the reasoning, then caps and keeps the newest line in view behind a soft
 * top fade. Once thinking ends it folds into a "Thought for Ns" summary the user
 * can reopen, at which point the viewport scrolls natively and the fades follow
 * the scroll position. Styles live in base.css (`.aicss-tr-*`).
 * Source: https://www.aicss.dev/components/thinking-reasoning
 */

/** Viewport grows with content up to this, then scrolls. Keep in sync with base.css. */
const MAX_H = 180
const FADE = 16

export interface ThinkingReasoningProps {
  /** True while the model is still thinking: the block stays open and follows the stream. */
  thinking: boolean
  /** The raw reasoning text; changes drive the follow-the-stream scroll. */
  content: string
  /** Persisted thinking time. Absent for a turn that is still streaming. */
  durationMs?: number
  thinkingLabel: string
  /** Summary once thinking ends; `seconds` is null when no duration is known. */
  formatSummary: (seconds: number | null) => string
  toggleLabel: string
  /** The rendered reasoning. */
  children: React.ReactNode
}

export function ThinkingReasoning({
  thinking,
  content,
  durationMs,
  thinkingLabel,
  formatSummary,
  toggleLabel,
  children
}: ThinkingReasoningProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [capped, setCapped] = useState(false)
  const [fade, setFade] = useState({ top: false, bottom: false })
  const viewportRef = useRef<HTMLDivElement>(null)

  // A turn watched live has no persisted duration until the message completes,
  // so the summary in between is measured here, from the moment the block
  // mounted in its thinking state to the moment thinking ended.
  const thinkingSinceRef = useRef<number | null>(null)
  const [measuredMs, setMeasuredMs] = useState<number | null>(null)
  useEffect(() => {
    if (thinking) {
      thinkingSinceRef.current ??= performance.now()
      return
    }
    const since = thinkingSinceRef.current
    if (since === null) return
    thinkingSinceRef.current = null
    // Wall-clock time at the moment thinking ended: not derivable from props,
    // and reading the clock during render would be impure.
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-adjust-state-on-prop-change
    setMeasuredMs(performance.now() - since)
  }, [thinking])

  const expanded = thinking || open
  const scrollable = !thinking && open

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !expanded) return
    setCapped(viewport.scrollHeight > MAX_H + 1)
    if (thinking) viewport.scrollTop = viewport.scrollHeight
  }, [content, expanded, thinking])

  const onScroll = (): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    setFade({
      top: viewport.scrollTop > 1,
      bottom: viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1
    })
  }

  const toggle = (): void => {
    const next = !open
    if (next && viewportRef.current) {
      viewportRef.current.scrollTop = 0
      setFade({ top: false, bottom: true })
    }
    setOpen(next)
  }

  const showTop = scrollable ? fade.top : capped
  const showBottom = scrollable ? fade.bottom : false
  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${showBottom ? FADE : 0}px), transparent 100%)`
    : undefined

  const ms = durationMs ?? measuredMs
  const seconds = ms === null ? null : Math.max(1, Math.round(ms / 1000))

  return (
    <div className="aicss-tr flex w-full flex-col">
      <button
        type="button"
        className={cn(
          'aicss-tr-header inline-flex min-h-5 items-center gap-1.5 self-start',
          !thinking && 'is-clickable'
        )}
        aria-expanded={expanded}
        aria-label={thinking ? undefined : toggleLabel}
        onClick={thinking ? undefined : toggle}
      >
        {thinking ? (
          <ThinkingState label={thinkingLabel} />
        ) : (
          <>
            <span className="aicss-tr-label text-[13px] font-medium leading-[18px]">
              {formatSummary(seconds)}
            </span>
            <ChevronDown className="aicss-tr-chevron size-3" aria-hidden="true" />
          </>
        )}
      </button>

      {/* Folded reasoning stays in the DOM for the height transition; `inert`
          keeps its links out of the tab order and the accessibility tree. */}
      <div className={cn('aicss-tr-collapsible', !expanded && 'is-collapsed')} inert={!expanded}>
        <div className="min-h-0 overflow-hidden">
          <div
            ref={viewportRef}
            className={cn('aicss-tr-viewport mt-1.5', scrollable && 'is-scroll')}
            style={{ maxHeight: MAX_H, WebkitMaskImage: mask, maskImage: mask }}
            onScroll={scrollable ? onScroll : undefined}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
