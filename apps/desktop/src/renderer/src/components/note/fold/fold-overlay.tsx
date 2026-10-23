import { useT } from '@memry/i18n/renderer'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import {
  evidenceSegments,
  type FoldedView,
  type ParagraphView,
  type SectionView,
  type TopicCard
} from './fold-display'
import type { FoldAction } from './fold-state'

const HEADING_CLASS =
  'font-heading text-[1.375rem] font-semibold leading-[1.875rem] tracking-[-0.01em] text-foreground'
const FOCUS_CLASS = 'outline-none focus-visible:ring-1 focus-visible:ring-ring'

type Dispatch = (action: FoldAction) => void

function Evidence({ paragraph }: { paragraph: ParagraphView }) {
  const { t } = useT('notes')
  return (
    <HoverCardContent align="start" className="w-[min(32rem,90vw)] text-[13px] leading-5">
      <p className="mb-1.5 text-[11px] text-text-tertiary">{t('fold.view.evidenceTitle')}</p>
      <p>
        {evidenceSegments(paragraph.sentences, paragraph.line.evidence).map((segment, index) => (
          <span
            key={index}
            className={cn(
              segment.cited
                ? 'text-foreground underline decoration-text-tertiary underline-offset-4'
                : 'text-text-tertiary'
            )}
          >
            {segment.text}{' '}
          </span>
        ))}
      </p>
    </HoverCardContent>
  )
}

function ParagraphLine({ paragraph, dispatch }: { paragraph: ParagraphView; dispatch: Dispatch }) {
  const { t } = useT('notes')
  const written = paragraph.line.source === 'written' && !paragraph.open
  const hasEvidence = written && paragraph.line.evidence.length > 0

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
      <span>{paragraph.line.text}</span>
      {paragraph.open && (
        <span className="text-[11px] leading-3.5 text-text-tertiary">
          {t('fold.view.paragraphOpen')}
        </span>
      )}
    </button>
  )

  if (!hasEvidence) return button
  return (
    <HoverCard openDelay={250} closeDelay={80}>
      <HoverCardTrigger asChild>{button}</HoverCardTrigger>
      <Evidence paragraph={paragraph} />
    </HoverCard>
  )
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

function Section({ section, dispatch }: { section: SectionView; dispatch: Dispatch }) {
  return (
    <div className="flex flex-col gap-2.5">
      <SectionHeading section={section} dispatch={dispatch} />
      {section.paragraphs.map((paragraph) =>
        section.unfolded ? (
          <p key={paragraph.hash} className="text-base leading-7 text-foreground">
            {paragraph.fullText}
          </p>
        ) : (
          <ParagraphLine key={paragraph.hash} paragraph={paragraph} dispatch={dispatch} />
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

/** The read-only folded body: sections of lines, or Topic cards. Pure display over `FoldedView`. */
export function FoldBody({ view, dispatch }: { view: FoldedView; dispatch: Dispatch }) {
  return (
    <div
      className={cn('flex flex-col', view.level === 'topic' ? 'gap-3' : 'gap-2.5')}
      data-testid="note-fold-body"
      data-fold-level={view.level}
    >
      {view.items.map((item) =>
        item.kind === 'card' ? (
          <Card key={item.card.hash} card={item.card} dispatch={dispatch} />
        ) : (
          <Section key={item.section.hash} section={item.section} dispatch={dispatch} />
        )
      )}
    </div>
  )
}
