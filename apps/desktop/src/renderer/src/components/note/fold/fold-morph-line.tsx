import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { FoldLevel } from '@memry/contracts/note-fold'
import {
  chunkTokens,
  FOLD_MORPH_EASING,
  FOLD_MORPH_MS,
  isSpace,
  planMorph,
  prefersReducedMotion,
  type MorphPlan,
  type OutgoingMotion,
  type MorphToken
} from './fold-morph'

interface Snapshot {
  level: FoldLevel
  tokens: readonly MorphToken[] | null
  node: ReactNode
}

interface Transition {
  from: Snapshot
  to: Snapshot
  plan: MorphPlan
}

const TIMING = { duration: FOLD_MORPH_MS, easing: FOLD_MORPH_EASING, fill: 'both' } as const
/** The outgoing layer must not move the line: it sits over the incoming one and takes no clicks. */
const OUTGOING_LAYER = 'pointer-events-none absolute start-0 top-0 w-full select-none'

function canAnimate(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function'
}

/**
 * One inline-block span per word, so it can be transformed. A word and its
 * punctuation share a no-wrap group, so the temporary layout breaks lines where
 * the settled one does.
 */
function TokenSpans({
  tokens,
  matched
}: {
  tokens: readonly MorphToken[]
  /** Outgoing words whose incoming twin slides in their place. */
  matched?: readonly OutgoingMotion[]
}) {
  const groups = new Map(chunkTokens(tokens).map((indices) => [indices[0], indices]))
  const out: ReactNode[] = []
  for (let index = 0; index < tokens.length; index++) {
    const group = groups.get(index)
    if (!group) {
      if (isSpace(tokens[index].text)) out.push(tokens[index].text)
      continue
    }
    out.push(
      <span key={index} className="whitespace-nowrap">
        {group.map((i) => (
          <span
            key={i}
            data-morph-token={i}
            className={matched?.[i] === 'matched' ? 'inline-block opacity-0' : 'inline-block'}
          >
            {tokens[i].text}
          </span>
        ))}
      </span>
    )
    index = group[group.length - 1]
  }
  return <>{out}</>
}

function tokenSpans(layer: HTMLElement): Map<number, HTMLElement> {
  const spans = new Map<number, HTMLElement>()
  for (const span of layer.querySelectorAll<HTMLElement>('[data-morph-token]')) {
    spans.set(Number(span.dataset.morphToken), span)
  }
  return spans
}

/** Slide words both lines share, fade in the new ones, fade out the old. Null when nothing is laid out. */
function wordAnimations(
  plan: MorphPlan,
  incoming: HTMLElement,
  outgoing: HTMLElement
): Animation[] | null {
  const inSpans = tokenSpans(incoming)
  const outSpans = tokenSpans(outgoing)
  if (![...inSpans.values()].some((span) => span.getBoundingClientRect().width > 0)) return null

  const animations: Animation[] = []
  plan.incoming.forEach((motion, index) => {
    const span = inSpans.get(index)
    if (!span || motion.kind === 'still') return
    if (motion.kind === 'in') {
      animations.push(
        span.animate([{ opacity: 0 }, { opacity: 1 }], {
          ...TIMING,
          delay: FOLD_MORPH_MS * 0.4,
          duration: FOLD_MORPH_MS * 0.6
        })
      )
      return
    }
    const from = outSpans.get(motion.from)
    if (!from) return
    const to = span.getBoundingClientRect()
    const start = from.getBoundingClientRect()
    const dx = start.left - to.left
    const dy = start.top - to.top
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    animations.push(
      span.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        TIMING
      )
    )
  })
  plan.outgoing.forEach((motion, index) => {
    const span = outSpans.get(index)
    if (!span || motion !== 'out') return
    animations.push(
      span.animate([{ opacity: 1 }, { opacity: 0 }], { ...TIMING, duration: FOLD_MORPH_MS * 0.5 })
    )
  })
  return animations
}

function layerFades(incoming: HTMLElement, outgoing: HTMLElement): Animation[] {
  return [
    incoming.animate([{ opacity: 0 }, { opacity: 1 }], TIMING),
    outgoing.animate([{ opacity: 1 }, { opacity: 0 }], TIMING)
  ]
}

interface MorphLineProps {
  level: FoldLevel
  /** The words of this line, keyed to the source; null when the line has no word map. */
  tokens: readonly MorphToken[] | null
  /** The line at rest: plain or rich. It is what stays once the motion ends. */
  children: ReactNode
}

/**
 * One paragraph's folded line. When `level` changes it plays the word-slide
 * from the previous level's line to this one, then returns to `children`.
 * The motion is transform and opacity only, paragraph-scoped, and never holds
 * state past its end: reduced motion, no Web Animations, or an equal line
 * swap instantly, and an unmeasurable layout crossfades.
 */
export function MorphLine({ level, tokens, children }: MorphLineProps) {
  const latest = useRef<Snapshot>({ level, tokens, node: children })
  const [transition, setTransition] = useState<Transition | null>(null)
  const incomingRef = useRef<HTMLSpanElement>(null)
  const outgoingRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const from = latest.current
    const to: Snapshot = { level, tokens, node: children }
    latest.current = to
    if (from.level === level) return
    if (prefersReducedMotion() || !canAnimate()) {
      // oxlint-disable-next-line react/set-state-in-effect -- synchronizes local state with an external source (IPC fetch / layout measurement) on this trigger
      setTransition(null)
      return
    }
    const plan = planMorph(from.tokens, tokens)
    setTransition(plan.mode === 'none' ? null : { from, to, plan })
  }, [level, tokens, children])

  useLayoutEffect(() => {
    if (!transition) return undefined
    const incoming = incomingRef.current
    const outgoing = outgoingRef.current
    if (!incoming || !outgoing) {
      setTransition(null)
      return undefined
    }
    let animations =
      transition.plan.mode === 'morph' ? wordAnimations(transition.plan, incoming, outgoing) : null
    if (!animations) {
      // No layout to measure: the words the slide would have hidden fade out with their line.
      for (const span of outgoing.querySelectorAll('[data-morph-token]')) {
        span.classList.remove('opacity-0')
      }
      animations = layerFades(incoming, outgoing)
    }
    const running = animations

    let cancelled = false
    const finish = (): void => {
      if (!cancelled) setTransition(null)
    }
    void Promise.all(running.map((animation) => animation.finished)).then(finish, () => {})
    // The promise is the normal exit; the timer guarantees no layer outlives the motion.
    const timer = setTimeout(finish, FOLD_MORPH_MS + 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
      for (const animation of running) animation.cancel()
    }
  }, [transition])

  if (!transition) return <span className="relative block">{children}</span>

  const { from, to, plan } = transition
  const word = plan.mode === 'morph' && from.tokens && to.tokens
  return (
    <span className="relative block">
      <span ref={incomingRef} data-morph="in" className="block">
        {word && to.tokens ? <TokenSpans tokens={to.tokens} /> : children}
      </span>
      <span ref={outgoingRef} data-morph="out" aria-hidden className={`${OUTGOING_LAYER} block`}>
        {word && from.tokens ? (
          <TokenSpans tokens={from.tokens} matched={plan.outgoing} />
        ) : (
          from.node
        )}
      </span>
    </span>
  )
}
