import { Command } from 'cmdk'
import { ChevronDown, ChevronUp } from '@/lib/icons'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { resultValue } from './search-result-item'
import { occurrenceSnippet, type Occurrences } from './search-text'

/** Matches a note row shows before the user asks for the rest. */
export const MATCH_PREVIEW_LIMIT = 5

export const matchValue = (item: SearchResultItem, index: number): string =>
  `match:${index}:${resultValue(item)}`

export const matchesToggleValue = (item: SearchResultItem, expanded: boolean): string =>
  `matches:${expanded ? 'less' : 'more'}:${resultValue(item)}`

/** The result value and hit index a `match:` row stands for, or null for any other value. */
export function parseMatchValue(value: string): { result: string; index: number } | null {
  const parsed = /^match:(\d+):(result:.+)$/.exec(value)
  return parsed ? { result: parsed[2], index: Number(parsed[1]) } : null
}

/** The hits of one note a row list shows: the first few, or all of them once expanded. */
export function visibleHitCount(occurrences: Occurrences, expanded: boolean): number {
  return expanded ? occurrences.hits.length : Math.min(occurrences.hits.length, MATCH_PREVIEW_LIMIT)
}

/** cmdk values of the rows under one note row, in render order. */
export function matchValues(
  item: SearchResultItem,
  occurrences: Occurrences,
  expanded: boolean
): string[] {
  const values = Array.from({ length: visibleHitCount(occurrences, expanded) }, (_, i) =>
    matchValue(item, i)
  )
  if (occurrences.hits.length > MATCH_PREVIEW_LIMIT) values.push(matchesToggleValue(item, expanded))
  return values
}

const ROW_CLASS =
  'flex h-7 cursor-pointer items-center gap-2 rounded-md ps-9 pe-2.5 data-[selected=true]:bg-surface-active'

interface SearchMatchRowsProps {
  item: SearchResultItem
  occurrences: Occurrences
  query: string
  expanded: boolean
  onOpen: (item: SearchResultItem, index: number) => void
  onToggle: (item: SearchResultItem) => void
}

/** The hits of one note, one row each, nested under its result row. */
export function SearchMatchRows({
  item,
  occurrences,
  query,
  expanded,
  onOpen,
  onToggle
}: SearchMatchRowsProps): React.JSX.Element {
  const { t } = useT('common')
  const hidden = occurrences.hits.length - MATCH_PREVIEW_LIMIT
  return (
    <>
      {occurrences.hits.slice(0, visibleHitCount(occurrences, expanded)).map((hit, i) => {
        const { before, match, after } = occurrenceSnippet(occurrences.lines, hit, query)
        return (
          <Command.Item
            key={i}
            value={matchValue(item, i)}
            onSelect={() => onOpen(item, i)}
            className={ROW_CLASS}
          >
            <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-pre text-xs leading-[18px] text-text-secondary">
              <span className="shrink-0">{before}</span>
              <mark className="shrink-0 rounded-[3px] bg-[var(--tint-light)] px-px text-foreground">
                {match}
              </mark>
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">{after}</span>
            </span>
            <span className="w-4 shrink-0 text-end font-mono text-[11px] leading-[14px] tabular-nums text-text-tertiary">
              {i + 1}
            </span>
          </Command.Item>
        )
      })}
      {hidden > 0 && (
        <Command.Item
          value={matchesToggleValue(item, expanded)}
          onSelect={() => onToggle(item)}
          className={`${ROW_CLASS} text-xs leading-4 text-text-secondary`}
        >
          <span className="flex size-[13px] shrink-0 items-center justify-center text-text-tertiary [&_svg]:size-[13px]">
            {expanded ? <ChevronUp /> : <ChevronDown />}
          </span>
          {expanded
            ? t('searchPalette.matchesHide')
            : t('searchPalette.matchesMore', { count: hidden })}
        </Command.Item>
      )}
    </>
  )
}
