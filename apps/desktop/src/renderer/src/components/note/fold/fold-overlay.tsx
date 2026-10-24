import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import type { FoldLevel, FoldSkipped } from '@memry/contracts/note-fold'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import {
  type FoldedView,
  type ParagraphView,
  type SectionView,
  type TopicCard
} from './fold-display'
import { InlineMarkdown } from './fold-inline-text'
import { FOLD_MORPH_EASING, prefersReducedMotion } from './fold-morph'
import { MorphLine } from './fold-morph-line'
import type { FoldAction } from './fold-state'

const HEADING_CLASS =
  'font-heading text-[1.375rem] font-semibold leading-[1.875rem] tracking-[-0.01em] text-foreground'
const FOCUS_CLASS = 'outline-none focus-visible:ring-1 focus-visible:ring-ring'

type Dispatch = (action: FoldAction) => void

/** Where the fold left blocks out: a quiet line, never interactive. */
function SkippedMarkers({ markers }: { markers: readonly FoldSkipped[] }) {
  const { t } = useT('notes')
  return markers.map((marker, index) => (
    <p
      // oxlint-disable-next-line react/no-array-index-key -- static positional list; items have no id and never reorder
      key={index}
      className="text-xs leading-5 text-text-secondary"
      data-fold-skipped={marker.kind}
    >
      {t(`fold.view.skipped.${marker.kind}`, { count: marker.count })}
    </p>
  ))
}

function ParagraphLine({
  paragraph,
  level,
  dispatch
}: {
  paragraph: ParagraphView
  level: FoldLevel
  dispatch: Dispatch
}) {
  const { t } = useT('notes')
  const written = paragraph.line.source === 'written' && !paragraph.open

  const button = (
    <button
      type="button"
      aria-expanded={paragraph.open}
      aria-label={
        paragraph.open ? t('fold.view.paragraphFold') : t('fold.view.paragraphOpenAction')
      }
      onClick={() => dispatch({ type: 'toggleParagraph', hash: paragraph.hash })}
      data-fold-paragraph={paragraph.hash}
      className={cn(
        'block w-full text-start text-base leading-7',
        FOCUS_CLASS,
        paragraph.open
          ? '-mx-3.5 flex w-[calc(100%+1.75rem)] flex-col gap-1 rounded-lg bg-surface px-3.5 py-2.5 text-foreground'
          : written
            ? 'rounded-sm text-text-secondary'
            : 'rounded-sm text-foreground'
      )}
    >
      {paragraph.open ? (
        <span>{paragraph.line.text}</span>
      ) : (
        <MorphLine level={level} tokens={paragraph.tokens}>
          {paragraph.line.md === null ? (
            paragraph.line.text
          ) : (
            <InlineMarkdown markdown={paragraph.line.md} />
          )}
        </MorphLine>
      )}
      {paragraph.open && (
        <span className="text-[11px] leading-3.5 text-text-tertiary">
          {t('fold.view.paragraphOpen')}
        </span>
      )}
    </button>
  )

  return button
}

function SectionHeading({ section, dispatch }: { section: SectionView; dispatch: Dispatch }) {
  const { t } = useT('notes')
  if (section.heading === null) return null
  // A section unfolded from a Topic card folds back from its heading.
  if (!section.unfolded) return <h2 className={cn(HEADING_CLASS, 'pt-1.5')}>{section.heading}</h2>
  return (
    <h2 className={cn(HEADING_CLASS, 'pt-1.5')}>
      <button
        type="button"
        aria-expanded
        aria-label={t('fold.view.unfoldSection', { heading: section.heading })}
        onClick={() => dispatch({ type: 'toggleSection', hash: section.hash })}
        className={cn('rounded-sm text-start', FOCUS_CLASS)}
      >
        {section.heading}
      </button>
    </h2>
  )
}

function Section({
  section,
  level,
  dispatch
}: {
  section: SectionView
  level: FoldLevel
  dispatch: Dispatch
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <SectionHeading section={section} dispatch={dispatch} />
      <SkippedMarkers markers={section.skippedAtStart} />
      {section.paragraphs.map((paragraph) =>
        section.unfolded ? (
          <p key={paragraph.hash} className="text-base leading-7 text-foreground">
            {paragraph.fullText}
          </p>
        ) : (
          <Fragment key={paragraph.hash}>
            <ParagraphLine paragraph={paragraph} level={level} dispatch={dispatch} />
            <SkippedMarkers markers={paragraph.skippedAfter} />
          </Fragment>
        )
      )}
    </div>
  )
}

function Card({ card, dispatch }: { card: TopicCard; dispatch: Dispatch }) {
  const { t } = useT('notes')
  const heading = card.heading ?? t('fold.view.untitledSection')
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border px-[18px] py-4">
      <h2 className="font-heading text-lg font-semibold leading-6 text-foreground">
        {card.heading === null ? (
          heading
        ) : (
          <button
            type="button"
            aria-expanded={false}
            aria-label={t('fold.view.unfoldSection', { heading })}
            onClick={() => dispatch({ type: 'toggleSection', hash: card.hash })}
            className={cn('rounded-sm text-start', FOCUS_CLASS)}
          >
            {heading}
          </button>
        )}
      </h2>
      {card.takeaway && (
        <p className="text-sm leading-[1.3125rem] text-text-secondary">{card.takeaway}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {card.chips.map((chip) => (
          <button
            key={chip.paragraphHash}
            type="button"
            aria-label={t('fold.view.jumpToParagraph', { topic: chip.label })}
            data-fold-paragraph={chip.paragraphHash}
            onClick={() => dispatch({ type: 'jump', hash: chip.paragraphHash })}
            className={cn(
              'rounded-full bg-surface px-[9px] py-[3px] text-xs leading-4 text-text-secondary hover:bg-surface-active',
              FOCUS_CLASS
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const NOOP: Dispatch = () => {}
const SWAP_TIMING = { duration: 220, easing: FOLD_MORPH_EASING, fill: 'both' } as const

function BodyItems({ view, dispatch }: { view: FoldedView; dispatch: Dispatch }) {
  const topic = view.level === 'topic'
  return (
    <div
      className={cn('flex flex-col', topic ? 'gap-3' : 'gap-2.5')}
      data-testid="note-fold-body"
      data-fold-level={view.level}
    >
      {view.items.map((item) =>
        item.kind === 'card' ? (
          <Card key={item.card.hash} card={item.card} dispatch={dispatch} />
        ) : (
          <Section
            key={item.section.hash}
            section={item.section}
            level={view.level}
            dispatch={dispatch}
          />
        )
      )}
    </div>
  )
}

/**
 * The read-only folded body: sections of lines, or Topic cards. Entering or
 * leaving Topic swaps cards for lines, and no word survives that swap, so the
 * outgoing body stays as an inert layer that drifts up and fades while the
 * incoming one rises in. Transform and opacity only.
 */
export function FoldBody({ view, dispatch }: { view: FoldedView; dispatch: Dispatch }) {
  const topic = view.level === 'topic'
  const previous = useRef({ topic, view })
  const [outgoing, setOutgoing] = useState<FoldedView | null>(null)
  const incomingRef = useRef<HTMLDivElement>(null)
  const outgoingRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const before = previous.current
    previous.current = { topic, view }
    if (before.topic === topic) return
    if (prefersReducedMotion() || typeof Element.prototype.animate !== 'function') return
    setOutgoing(before.view)
  }, [topic, view])

  useLayoutEffect(() => {
    const incoming = incomingRef.current
    const leaving = outgoingRef.current
    if (!outgoing || !incoming || !leaving) return
    const animations = [
      incoming.animate(
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ],
        SWAP_TIMING
      ),
      leaving.animate(
        [
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: 'translateY(-8px)' }
        ],
        SWAP_TIMING
      )
    ]
    let cancelled = false
    void Promise.all(animations.map((animation) => animation.finished)).then(
      () => !cancelled && setOutgoing(null),
      () => {}
    )
    return () => {
      cancelled = true
      for (const animation of animations) animation.cancel()
    }
  }, [outgoing])

  return (
    <div className="relative">
      <div ref={incomingRef}>
        <BodyItems view={view} dispatch={dispatch} />
      </div>
      {outgoing && (
        <div
          ref={outgoingRef}
          aria-hidden
          inert
          className="pointer-events-none absolute inset-x-0 top-0 select-none"
        >
          <BodyItems view={outgoing} dispatch={NOOP} />
        </div>
      )}
    </div>
  )
}
