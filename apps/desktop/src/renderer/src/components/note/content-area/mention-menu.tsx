/**
 * Mention suggestion menu for BlockNote (`@` trigger).
 *
 * Dual-intent quick-insert: when the query parses as a date, a "Date" group
 * (a plain-date row + a "Remind me — <subtitle>" row) is shown on top; the
 * most-recently-modified notes follow and insert as wiki links. A "Show more"
 * footer reveals the full note list. The footer is a plain button — NOT a menu
 * item — because selecting any item closes the menu and clears the query.
 */

import { Fragment, useEffect } from 'react'
import type { SuggestionMenuProps } from '@blocknote/react'
import { AlarmClock, Clock, FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import type { DateMentionValue } from './date-mention-popover'

export type MentionSuggestionItem =
  | { kind: 'date'; label: string; value: DateMentionValue }
  | { kind: 'remind'; subtitle: string; value: DateMentionValue }
  | { kind: 'date-hint' }
  | { kind: 'note'; id: string; title: string; lastEdited?: string }

export type MentionMenuProps = SuggestionMenuProps<MentionSuggestionItem> & {
  hasMore: boolean
  onShowMore: () => void
}

export function MentionMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick,
  hasMore,
  onShowMore
}: MentionMenuProps) {
  const { t } = useT('notes')

  // Tab confirms the highlighted row (mirrors Enter). BlockNote's suggestion
  // handler ignores Tab, and the inline date ghost plugin otherwise swallows it
  // to commit a plain date — so we intercept Tab in document capture phase, ahead
  // of the ghost plugin's ProseMirror (bubble) handler, and select the highlighted
  // item via onItemClick. The non-selectable date-hint row is left to the ghost so
  // its two-stage fill (e.g. "@nex" → "next Monday") still works.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
      const item = items[selectedIndex ?? 0]
      if (!item || item.kind === 'date-hint') return
      event.preventDefault()
      event.stopPropagation()
      onItemClick?.(item)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [items, selectedIndex, onItemClick])

  if (items.length === 0 && loadingState !== 'loaded') {
    return (
      <div className="mention-menu min-w-[220px] rounded-md border bg-popover p-2 text-[13px] text-muted-foreground shadow-[var(--shadow-card-hover)]">
        {t('menus.mention.loading')}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="mention-menu min-w-[220px] rounded-md border bg-popover p-3 text-[13px] text-muted-foreground shadow-[var(--shadow-card-hover)]">
        <div className="flex items-center gap-2">
          <FileText className="size-3.5 opacity-70" />
          <span>{t('menus.mention.empty')}</span>
        </div>
      </div>
    )
  }

  const hasDateGroup = items.some((item) => item.kind === 'date' || item.kind === 'remind')
  const firstNoteIndex = items.findIndex((item) => item.kind === 'note')

  const itemClassName = (isSelected: boolean): string =>
    cn(
      'mention-menu-item',
      'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[5px] px-2 py-1.5 text-start text-muted-foreground outline-none transition-colors',
      'hover:bg-accent focus:outline-none',
      isSelected && 'bg-accent'
    )

  return (
    <div
      className={cn(
        'mention-menu z-50 min-w-[220px] max-w-[360px] max-h-[300px] overflow-y-auto',
        'rounded-md border bg-popover text-popover-foreground text-[13px] leading-4',
        'shadow-[var(--shadow-card-hover)] animate-in fade-in-0 zoom-in-95'
      )}
    >
      <div
        className="flex flex-col p-1 text-[13px] leading-4 [font-synthesis:none]"
        role="listbox"
        aria-label={t('menus.mention.aria')}
      >
        {hasDateGroup && (
          <div className="mention-menu-group px-2 py-1 text-xs font-medium text-muted-foreground">
            {t('menus.mention.date')}
          </div>
        )}
        {items.map((item, index) => {
          const isSelected = selectedIndex === index

          if (item.kind === 'date-hint') {
            return (
              <div
                key={`date-hint-${index}`}
                className="mention-menu-hint flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-muted-foreground"
              >
                <Clock className="size-3.5 shrink-0" />
                <span>{t('menus.mention.dateHint')}</span>
              </div>
            )
          }

          if (item.kind === 'date') {
            return (
              <button
                key={`date-${index}`}
                className={itemClassName(isSelected)}
                role="option"
                aria-selected={isSelected}
                onClick={() => onItemClick?.(item)}
              >
                <Clock className="size-3.5 shrink-0" />
                <span>{item.label}</span>
              </button>
            )
          }

          if (item.kind === 'remind') {
            return (
              <button
                key={`remind-${index}`}
                className={itemClassName(isSelected)}
                role="option"
                aria-selected={isSelected}
                onClick={() => onItemClick?.(item)}
              >
                <AlarmClock className="size-3.5 shrink-0" />
                <span>{t('menus.mention.remindMe')}</span>
                <span className="text-muted-foreground/70">— {item.subtitle}</span>
              </button>
            )
          }

          const divider =
            hasDateGroup && index === firstNoteIndex ? (
              <div role="separator" className="my-1 h-px bg-border" />
            ) : null

          return (
            <Fragment key={`note-${item.id}`}>
              {divider}
              <button
                className={itemClassName(isSelected)}
                role="option"
                aria-selected={isSelected}
                onClick={() => onItemClick?.(item)}
              >
                <FileText className="size-3.5 shrink-0" />
                <span className="truncate">{item.title}</span>
              </button>
            </Fragment>
          )
        })}

        {hasMore && (
          <button
            className={cn(
              'mention-menu-more mt-1 flex w-full cursor-pointer select-none items-center gap-2',
              'rounded-[5px] px-2 py-1.5 text-xs text-muted-foreground outline-none transition-colors',
              'hover:bg-accent'
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onShowMore}
          >
            {t('menus.mention.showMore')}
          </button>
        )}
      </div>
    </div>
  )
}
