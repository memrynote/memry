/**
 * Mention suggestion menu for BlockNote (`@` trigger).
 *
 * Dual-intent quick-insert: when the query parses as a date, a "Date" group
 * (a plain-date row + a "Remind me — <subtitle>" row) is shown on top; `@now`
 * (or `@no`) leads that group with a "Now" row that inserts today at the current
 * time. The most-recently-modified notes follow and insert as wiki links, then a
 * small "Canvases" group. A "Show more" footer reveals the full note list. The
 * footer is a plain button — NOT a menu item — because selecting any item
 * closes the menu and clears the query.
 *
 * A canvas can land two ways (a link, or the live board embedded as a
 * whiteboard block), so picking one opens `CanvasChoiceMenu` at the caret
 * instead of inserting straight away.
 */

import { Fragment, useEffect } from 'react'
import type { SuggestionMenuProps } from '@blocknote/react'
import type { ObjectMatch } from '@memry/contracts/tag-objects-api'
import { AlarmClock, Clock, FileText, Link, PenTool, Plus, type AppIcon } from '@/lib/icons'
import { ObjectAvatar, TagGlyph } from '@/features/tag-fields/object-avatar'
import { lookOfTagKey } from '@/features/tag-fields/object-look'
import { objectGroupLabel, tagDisplayName } from '@/features/tag-fields/tag-display-name'
import { buildCreateOptions } from '@/features/tag-fields/mention-create-options'
import { useOptionalTagSchemaSnapshot } from '@/features/tag-fields/use-optional-object-identity'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import type { DateMentionValue } from './date-mention-popover'
import { InlineChoiceMenu } from './inline-choice-menu'

export type MentionSuggestionItem =
  // Carries no value: the time is read when it is picked, not when the menu opens.
  | { kind: 'now' }
  | { kind: 'date'; label: string; value: DateMentionValue }
  | { kind: 'remind'; subtitle: string; value: DateMentionValue }
  | { kind: 'date-hint' }
  | { kind: 'note'; id: string; title: string; lastEdited?: string }
  | { kind: 'canvas'; id: string; title: string }
  /** An object of a tag with fields, listed under its group tag (D1). */
  | { kind: 'object'; match: ObjectMatch }
  /** Always the last row: "Create {title}" opens the type choice (D2). */
  | { kind: 'create'; title: string }

export type CanvasChoiceOption = 'mention' | 'embed'

/** The Mention / Embed popover state for a canvas picked from the `@` menu. */
export interface CanvasChoiceState {
  canvas: { id: string; title: string }
  position: { x: number; y: number }
  selectedIndex: number
}

/** Mention first: it is what every other `@` pick does, so it is the default. */
export const CANVAS_CHOICE_OPTIONS: readonly CanvasChoiceOption[] = ['mention', 'embed']

const CANVAS_CHOICE_CONFIG: Record<CanvasChoiceOption, { icon: AppIcon; labelKey: string }> = {
  mention: { icon: Link, labelKey: 'menus.mention.choiceMention' },
  embed: { icon: PenTool, labelKey: 'menus.mention.choiceEmbed' }
}

export type MentionMenuProps = SuggestionMenuProps<MentionSuggestionItem> & {
  hasMore: boolean
  onShowMore: () => void
}

const itemClassName = (isSelected: boolean): string =>
  cn(
    'mention-menu-item',
    'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-[5px] px-2 py-1.5 text-start text-muted-foreground outline-none transition-colors',
    'hover:bg-accent focus:outline-none',
    isSelected && 'bg-accent'
  )

export function MentionMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick,
  hasMore,
  onShowMore
}: MentionMenuProps) {
  const { t } = useT('notes')
  const snapshot = useOptionalTagSchemaSnapshot()
  const lookOf = (tag: string) => lookOfTagKey(snapshot, tag)

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

  const hasDateGroup = items.some(
    (item) => item.kind === 'now' || item.kind === 'date' || item.kind === 'remind'
  )
  const firstNoteIndex = items.findIndex((item) => item.kind === 'note')
  const firstCanvasIndex = items.findIndex((item) => item.kind === 'canvas')
  const hasObjects = items.some((item) => item.kind === 'object')
  const createTypes = buildCreateOptions(snapshot, null)
    .map((option) => (option.kind === 'plain' ? t('tagObjects.create.noteWord') : option.name))
    .join(', ')

  return (
    <div
      className={cn(
        'mention-menu z-50 min-w-[220px] max-w-[360px] max-h-[360px] overflow-y-auto',
        // Two-line object and create rows read at the boards' width (D1).
        (hasObjects || items.some((item) => item.kind === 'create')) && 'w-[340px]',
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
                key="date-hint"
                className="mention-menu-hint flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-muted-foreground"
              >
                <Clock className="size-3.5 shrink-0" />
                <span>{t('menus.mention.dateHint')}</span>
              </div>
            )
          }

          if (item.kind === 'now') {
            return (
              <button
                key="now"
                type="button"
                className={itemClassName(isSelected)}
                role="option"
                aria-selected={isSelected}
                onClick={() => onItemClick?.(item)}
              >
                <Clock className="size-3.5 shrink-0" />
                <span>{t('menus.mention.now')}</span>
              </button>
            )
          }

          if (item.kind === 'date') {
            return (
              <button
                key="date"
                type="button"
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
                key="remind"
                type="button"
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

          if (item.kind === 'object') {
            const look = lookOf(item.match.tag)
            const groupLook = lookOf(item.match.groupTag)
            const previous = items[index - 1]
            const startsGroup =
              previous?.kind !== 'object' || previous.match.groupTag !== item.match.groupTag
            const subtitle = [
              ...(item.match.viaTag ? [tagDisplayName(item.match.viaTag)] : []),
              ...item.match.subtitle
            ].join(' · ')
            return (
              <Fragment key={`object-${item.match.noteId}`}>
                {startsGroup && (
                  <>
                    {index > 0 && previous?.kind !== 'object' && (
                      <hr className="my-1 h-px border-0 bg-border" />
                    )}
                    <div className="mention-menu-group flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                      {groupLook && <TagGlyph look={groupLook} className="size-3" />}
                      {objectGroupLabel(
                        snapshot?.tags[item.match.groupTag] ?? {
                          name: item.match.groupTag,
                          ownPreset: null
                        },
                        (preset) => ({
                          name: t(`tagFields.presets.${preset}.name`),
                          plural: t(`tagFields.presets.${preset}.plural`)
                        })
                      )}
                    </div>
                  </>
                )}
                <button
                  type="button"
                  className={itemClassName(isSelected)}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onItemClick?.(item)}
                >
                  {look && <ObjectAvatar look={look} title={item.match.title} size={24} />}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-foreground">{item.match.title}</span>
                    {subtitle && <span className="truncate text-xs">{subtitle}</span>}
                  </span>
                  {isSelected && <EnterKey />}
                </button>
              </Fragment>
            )
          }

          if (item.kind === 'create') {
            return (
              <Fragment key="create">
                {index > 0 && <hr className="my-1 h-px border-0 bg-border" />}
                <button
                  type="button"
                  className={itemClassName(isSelected)}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onItemClick?.(item)}
                >
                  <Plus className="size-3.5 shrink-0" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-foreground">
                      {t('tagObjects.create.row', { title: item.title })}
                    </span>
                    <span className="truncate text-xs">
                      {t('tagObjects.create.rowHint', { types: createTypes })}
                    </span>
                  </span>
                  {isSelected && <EnterKey />}
                </button>
              </Fragment>
            )
          }

          if (item.kind === 'canvas') {
            return (
              <Fragment key={`canvas-${item.id}`}>
                {index === firstCanvasIndex && (
                  <>
                    {index > 0 && <hr className="my-1 h-px border-0 bg-border" />}
                    <div className="mention-menu-group px-2 py-1 text-xs font-medium text-muted-foreground">
                      {t('menus.mention.canvases')}
                    </div>
                  </>
                )}
                <button
                  type="button"
                  className={itemClassName(isSelected)}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onItemClick?.(item)}
                >
                  <PenTool className="size-3.5 shrink-0" />
                  <span className="truncate">{item.title}</span>
                </button>
              </Fragment>
            )
          }

          const divider =
            (hasDateGroup || hasObjects) && index === firstNoteIndex ? (
              <>
                <hr className="my-1 h-px border-0 bg-border" />
                {hasObjects && (
                  <div className="mention-menu-group px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                    {t('tagObjects.mention.notes')}
                  </div>
                )}
              </>
            ) : null

          return (
            <Fragment key={`note-${item.id}`}>
              {divider}
              <button
                type="button"
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
            type="button"
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

function EnterKey(): React.JSX.Element {
  const { t } = useT('notes')
  return (
    <kbd className="ms-auto rounded border border-border px-1 text-[11px] text-muted-foreground">
      {t('tagObjects.keys.enter')}
    </kbd>
  )
}

interface CanvasChoiceMenuProps {
  choice: CanvasChoiceState | null
  onSelect: (option: CanvasChoiceOption) => void
}

/** Mention / Embed for a canvas picked from the `@` menu; keyboard lives in the hook. */
export function CanvasChoiceMenu({ choice, onSelect }: CanvasChoiceMenuProps) {
  const { t } = useT('notes')
  if (!choice) return null

  return (
    <InlineChoiceMenu
      title={t('menus.mention.choiceTitle')}
      position={choice.position}
      options={CANVAS_CHOICE_OPTIONS.map((option) => ({
        id: option,
        icon: CANVAS_CHOICE_CONFIG[option].icon,
        label: t(CANVAS_CHOICE_CONFIG[option].labelKey)
      }))}
      selectedIndex={choice.selectedIndex}
      onSelect={onSelect}
    />
  )
}
