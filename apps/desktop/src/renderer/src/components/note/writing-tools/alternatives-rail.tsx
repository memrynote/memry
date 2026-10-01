import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { WritingAlternative } from '@memry/shared'
import { Check, Sparkles, User, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  RAIL_ITEM_GAP,
  areNumberRecordsEqual,
  layoutRailItems,
  type RailLayoutItem
} from '../review/rail-layout'
import type { WritingToolsSession, WritingToolsSnapshot } from './writing-tools-session'

interface AlternativesRailProps {
  session: WritingToolsSession
  snapshot: WritingToolsSnapshot
}

/**
 * One card per alternative, level with its line in the note (review-rail
 * geometry). Rows are original + variants; clicking one shows it in the body.
 */
export function AlternativesRail({ session, snapshot }: AlternativesRailProps) {
  const { t } = useT('notes')
  const innerRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Record<string, HTMLElement | null>>({})
  const [itemHeights, setItemHeights] = useState<Record<string, number>>({})
  const [originOffset, setOriginOffset] = useState(0)
  const { alternatives, alternativeTops, draft } = snapshot

  const positions = useMemo(() => {
    const items: RailLayoutItem[] = []
    if (draft) {
      const top = alternativeTops[draft.id]
      items.push({
        id: draft.id,
        desiredTop: top !== undefined ? top - originOffset : 0,
        order: -1
      })
    }
    alternatives.forEach((alternative, index) => {
      const top = alternativeTops[alternative.id]
      items.push({
        id: alternative.id,
        desiredTop: top !== undefined ? top - originOffset : index * RAIL_ITEM_GAP,
        order: index
      })
    })
    return layoutRailItems(items, itemHeights)
  }, [alternativeTops, alternatives, draft, itemHeights, originOffset])

  useLayoutEffect(() => {
    const inner = innerRef.current
    const marqueeZone = inner?.closest<HTMLElement>('.marquee-zone')
    if (inner && marqueeZone) {
      const next = inner.getBoundingClientRect().top - marqueeZone.getBoundingClientRect().top
      setOriginOffset((previous) => (previous === next ? previous : next))
    }
    const heights: Record<string, number> = {}
    for (const id of [...(draft ? [draft.id] : []), ...alternatives.map((alt) => alt.id)]) {
      const element = itemRefs.current[id]
      if (element) heights[id] = element.offsetHeight
    }
    setItemHeights((previous) => (areNumberRecordsEqual(previous, heights) ? previous : heights))
  }, [alternatives, draft])

  return (
    <aside
      aria-label={t('writingTools.alternatives.railAria')}
      data-marquee-ignore
      className="review-rail"
    >
      <div ref={innerRef} className="review-rail-inner">
        {!draft && alternatives.length === 0 && (
          <p className="writing-rail-empty">{t('writingTools.alternatives.empty')}</p>
        )}
        {draft && (
          <div
            ref={(element) => {
              itemRefs.current[draft.id] = element
            }}
            className="critic-review-card writing-rail-card"
            style={{ top: positions[draft.id] ?? 0 }}
          >
            <p className="writing-rail-card-title" title={draft.original}>
              {draft.original}
            </p>
            <AddAlternativeInput
              autoFocus={snapshot.focusAlternativeId === draft.id}
              onSubmit={(text) => session.submitDraft(text)}
              onCancel={() => session.cancelDraft()}
              onFocused={() => session.clearFocusAlternative()}
            />
          </div>
        )}
        {alternatives.map((alternative) => (
          <AlternativeCard
            key={alternative.id}
            alternative={alternative}
            session={session}
            shownVariantId={session.shownVariantId(alternative)}
            hovered={snapshot.hoveredAlternativeId === alternative.id}
            focusInput={snapshot.focusAlternativeId === alternative.id}
            top={positions[alternative.id] ?? 0}
            cardRef={(element) => {
              itemRefs.current[alternative.id] = element
            }}
          />
        ))}
      </div>
    </aside>
  )
}

interface AlternativeCardProps {
  alternative: WritingAlternative
  session: WritingToolsSession
  shownVariantId: string | null
  hovered: boolean
  focusInput: boolean
  top: number
  cardRef: (element: HTMLElement | null) => void
}

function AlternativeCard({
  alternative,
  session,
  shownVariantId,
  hovered,
  focusInput,
  top,
  cardRef
}: AlternativeCardProps) {
  const { t } = useT('notes')
  const hasAiVariants = alternative.variants.some((variant) => variant.source === 'ai')

  return (
    <div
      ref={cardRef}
      className="critic-review-card writing-rail-card"
      data-hovered={hovered ? 'true' : 'false'}
      style={{ top }}
      onPointerEnter={() => session.hoverAlternative(alternative.id)}
      onPointerLeave={() => session.hoverAlternative(null)}
    >
      <p className="writing-rail-card-title" title={alternative.original}>
        {alternative.original}
      </p>
      <ul className="flex flex-col gap-0.5">
        <AlternativeRow
          label={t('writingTools.alternatives.original')}
          text={alternative.original}
          shown={shownVariantId === null}
          onActivate={() => session.activateVariant(alternative.id, null)}
        />
        {alternative.variants.map((variant) => (
          <AlternativeRow
            key={variant.id}
            text={variant.text}
            source={variant.source}
            shown={shownVariantId === variant.id}
            onActivate={() => session.activateVariant(alternative.id, variant.id)}
            onRemove={() => session.removeVariant(alternative.id, variant.id)}
          />
        ))}
      </ul>
      <AddAlternativeInput
        autoFocus={focusInput}
        onSubmit={(text) => session.addVariant(alternative.id, text)}
        onFocused={() => session.clearFocusAlternative()}
      />
      {hasAiVariants && (
        <button
          type="button"
          className="mt-1.5 text-xs text-text-tertiary underline-offset-2 hover:text-foreground hover:underline focus-visible:underline"
          onClick={() => session.removeAiVariants(alternative.id)}
        >
          {t('writingTools.alternatives.removeSuggestions')}
        </button>
      )}
    </div>
  )
}

interface AlternativeRowProps {
  text: string
  label?: string
  source?: 'user' | 'ai'
  shown: boolean
  onActivate: () => void
  onRemove?: () => void
}

function AlternativeRow({ text, label, source, shown, onActivate, onRemove }: AlternativeRowProps) {
  const { t } = useT('notes')
  const SourceIcon = source === 'ai' ? Sparkles : User
  return (
    <li className="group/row relative flex items-center">
      <button
        type="button"
        aria-pressed={shown}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors motion-reduce:transition-none',
          shown ? 'bg-tint-lighter' : 'hover:bg-surface-active',
          onRemove && 'pe-7'
        )}
        onClick={onActivate}
      >
        {source ? (
          <SourceIcon
            className="mt-0.5 size-3.5 shrink-0 text-text-tertiary"
            aria-label={
              source === 'ai'
                ? t('writingTools.alternatives.byAI')
                : t('writingTools.alternatives.byYou')
            }
          />
        ) : (
          <span className="mt-px shrink-0 text-xs text-text-tertiary">{label}</span>
        )}
        <span className="min-w-0 flex-1 break-words">{text}</span>
        {shown && (
          <Check
            className="mt-0.5 size-3.5 shrink-0 text-foreground"
            aria-label={t('writingTools.alternatives.showing')}
          />
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={t('writingTools.alternatives.removeVariant')}
          className="absolute end-1 top-1.5 rounded p-0.5 text-text-tertiary opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none"
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      )}
    </li>
  )
}

interface AddAlternativeInputProps {
  autoFocus: boolean
  onSubmit: (text: string) => void
  onCancel?: () => void
  onFocused: () => void
}

function AddAlternativeInput({
  autoFocus,
  onSubmit,
  onCancel,
  onFocused
}: AddAlternativeInputProps) {
  const { t } = useT('notes')
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useLayoutEffect(() => {
    if (!autoFocus) return
    inputRef.current?.focus()
    onFocused()
  }, [autoFocus, onFocused])

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (!value.trim()) return
      onSubmit(value)
      setValue('')
      return
    }
    if (event.key === 'Escape' && onCancel) {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!value.trim()) onCancel?.()
      }}
      placeholder={t('writingTools.alternatives.addPlaceholder')}
      aria-label={t('writingTools.alternatives.addPlaceholder')}
      className="mt-1.5 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm placeholder:text-text-tertiary focus-visible:border-ring focus-visible:outline-none"
    />
  )
}
