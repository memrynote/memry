import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { ThinkingState } from './thinking-state'

/**
 * AICSS Thinking + Reasoning, driven by live data instead of the demo script:
 * while the model thinks, a shimmering label sits over a viewport that grows
 * with the reasoning, then caps and keeps the newest line in view behind a soft
 * top fade. Once thinking ends it folds into a "Thought for Ns" summary the user
 * can reopen. Thinking that resumes later in the turn lights the header again but
 * leaves the block folded, so the answer does not jump. The viewport always
 * scrolls natively, and while expanded it follows new lines unless the reader
 * scrolled up. Styles live in base.css (`.aicss-tr-*`).
 * Source: https://www.aicss.dev/components/thinking-reasoning
 */

/** Viewport grows with content up to this, then scrolls. Keep in sync with base.css. */
const MAX_H = 180
const FADE = 16
/** A reader further than this from the bottom has scrolled up and is not followed. */
const FOLLOW_SLACK = 16

export interface ThinkingReasoningProps {
  /** True while the newest delta of the turn is reasoning: the header shows the live state. */
  thinking: boolean
  /** True while the turn runs: opening the block then jumps to the newest line. */
  streaming: boolean
  /** Thinking unfolds the block only before the answer starts, so the answer never jumps. */
  answerStarted: boolean
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
  streaming,
  answerStarted,
  content,
  durationMs,
  thinkingLabel,
  formatSummary,
  toggleLabel,
  children
}: ThinkingReasoningProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [capped, setCapped] = useState(false)
  const [fadeTop, setFadeTop] = useState(false)
  const [fadeBottom, setFadeBottom] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

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
    // and reading the clock during render would be impure. A turn can think in
    // several spans, so the summary adds them up.
    // eslint-disable-next-line react-you-might-not-need-an-effect/no-adjust-state-on-prop-change
    setMeasuredMs((total) => (total ?? 0) + performance.now() - since)
  }, [thinking])

  const autoExpanded = thinking && !answerStarted
  const expanded = autoExpanded || open

  const syncFade = (viewport: HTMLDivElement): void => {
    setFadeTop(viewport.scrollTop > 1)
    setFadeBottom(viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1)
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !expanded) return
    setCapped(viewport.scrollHeight > MAX_H + 1)
    if (followRef.current) viewport.scrollTop = viewport.scrollHeight
    syncFade(viewport)
  }, [content, expanded])

  const onScroll = (): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    followRef.current =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= FOLLOW_SLACK
    syncFade(viewport)
  }

  const toggle = (): void => {
    const next = !open
    if (next && viewportRef.current) {
      followRef.current = streaming
      if (!streaming) viewportRef.current.scrollTop = 0
    }
    setOpen(next)
  }

  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${fadeTop ? FADE : 0}px, #000 calc(100% - ${fadeBottom ? FADE : 0}px), transparent 100%)`
    : undefined

  const ms = durationMs ?? measuredMs
  const seconds = ms === null ? null : Math.max(1, Math.round(ms / 1000))

  return (
    <div className="aicss-tr flex w-full flex-col">
      <button
        type="button"
        className={cn(
          'aicss-tr-header inline-flex min-h-5 items-center gap-1.5 self-start',
          !autoExpanded && 'is-clickable'
        )}
        aria-expanded={expanded}
        aria-label={autoExpanded ? undefined : toggleLabel}
        onClick={autoExpanded ? undefined : toggle}
      >
        {thinking ? (
          <ThinkingState label={thinkingLabel} />
        ) : (
          <span className="aicss-tr-label text-[13px] font-medium leading-[18px]">
            {formatSummary(seconds)}
          </span>
        )}
        {!autoExpanded && <ChevronDown className="aicss-tr-chevron size-3" aria-hidden="true" />}
      </button>

      {/* Folded reasoning stays in the DOM for the height transition; `inert`
          keeps its links out of the tab order and the accessibility tree. */}
      <div className={cn('aicss-tr-collapsible', !expanded && 'is-collapsed')} inert={!expanded}>
        <div className="min-h-0 overflow-hidden">
          <div
            ref={viewportRef}
            className="aicss-tr-viewport is-scroll mt-1.5"
            style={{ maxHeight: MAX_H, WebkitMaskImage: mask, maskImage: mask }}
            onScroll={onScroll}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
