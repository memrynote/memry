import { Fragment } from 'react'
import { Command } from 'cmdk'
import { ChevronDown } from '@/lib/icons'
import type {
  ContentType,
  SearchResultGroup as SearchResultGroupType,
  SearchResultItem as SearchResultItemType
} from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { SearchResultItem, resultValue } from './search-result-item'
import { SearchMatchRows, matchValues } from './search-matches'
import { SearchCount, SearchGroupHeading, SearchRow } from './search-row'
import type { Occurrences } from './search-text'
import { TYPE_LABEL_KEYS } from './search-types'

export const GROUP_PREVIEW_LIMIT = 5

export const showMoreValue = (type: ContentType): string => `more:${type}`

/** Rows a group shows, collapsed to the first few until the user asks for the rest. */
export function visibleResults(
  group: SearchResultGroupType,
  expanded: boolean
): SearchResultItemType[] {
  return expanded ? group.results : group.results.slice(0, GROUP_PREVIEW_LIMIT)
}

/** Where each result's query hits are, and which notes show all of them. */
export interface MatchLists {
  occurrences: ReadonlyMap<string, Occurrences>
  expandedNotes: readonly string[]
}

/** cmdk values in the order a group renders them. */
export function groupValues(
  group: SearchResultGroupType,
  expanded: boolean,
  matches: MatchLists
): string[] {
  const values = visibleResults(group, expanded).flatMap((item) => {
    const hits = matches.occurrences.get(resultValue(item))
    return hits
      ? [
          resultValue(item),
          ...matchValues(item, hits, matches.expandedNotes.includes(resultValue(item)))
        ]
      : [resultValue(item)]
  })
  if (!expanded && group.results.length > GROUP_PREVIEW_LIMIT)
    values.push(showMoreValue(group.type))
  return values
}

interface SearchResultGroupProps {
  group: SearchResultGroupType
  query: string
  expanded: boolean
  matches: MatchLists
  onExpand: (type: ContentType) => void
  onSelect: (item: SearchResultItemType) => void
  onOpenMatch: (item: SearchResultItemType, index: number) => void
  onToggleMatches: (item: SearchResultItemType) => void
}

export function SearchResultGroup({
  group,
  query,
  expanded,
  matches,
  onExpand,
  onSelect,
  onOpenMatch,
  onToggleMatches
}: SearchResultGroupProps): React.JSX.Element {
  const { t } = useT('common')
  const hidden = group.results.length - GROUP_PREVIEW_LIMIT
  return (
    <Command.Group
      heading={
        <SearchGroupHeading
          label={t(TYPE_LABEL_KEYS[group.type])}
          trailing={<SearchCount value={group.totalInGroup} />}
        />
      }
    >
      {visibleResults(group, expanded).map((item) => {
        const hits = matches.occurrences.get(resultValue(item))
        return (
          <Fragment key={item.id}>
            <SearchResultItem
              item={item}
              query={query}
              matchCount={hits?.hits.length}
              onSelect={onSelect}
            />
            {hits && (
              <SearchMatchRows
                item={item}
                occurrences={hits}
                query={query}
                expanded={matches.expandedNotes.includes(resultValue(item))}
                onOpen={onOpenMatch}
                onToggle={onToggleMatches}
              />
            )}
          </Fragment>
        )
      })}
      {!expanded && hidden > 0 && (
        <SearchRow
          value={showMoreValue(group.type)}
          onSelect={() => onExpand(group.type)}
          icon={<ChevronDown />}
          muted
        >
          {t('searchPalette.showMore', { count: hidden })}
        </SearchRow>
      )}
    </Command.Group>
  )
}
