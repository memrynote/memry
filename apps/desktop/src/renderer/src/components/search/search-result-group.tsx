import { Command } from 'cmdk'
import { ChevronDown } from '@/lib/icons'
import type {
  ContentType,
  SearchResultGroup as SearchResultGroupType,
  SearchResultItem as SearchResultItemType
} from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'
import { SearchResultItem, resultValue } from './search-result-item'
import { SearchCount, SearchGroupHeading, SearchRow } from './search-row'
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

/** cmdk values in the order a group renders them. */
export function groupValues(group: SearchResultGroupType, expanded: boolean): string[] {
  const values = visibleResults(group, expanded).map(resultValue)
  if (!expanded && group.results.length > GROUP_PREVIEW_LIMIT)
    values.push(showMoreValue(group.type))
  return values
}

interface SearchResultGroupProps {
  group: SearchResultGroupType
  query: string
  expanded: boolean
  onExpand: (type: ContentType) => void
  onSelect: (item: SearchResultItemType) => void
}

export function SearchResultGroup({
  group,
  query,
  expanded,
  onExpand,
  onSelect
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
      {visibleResults(group, expanded).map((item) => (
        <SearchResultItem key={item.id} item={item} query={query} onSelect={onSelect} />
      ))}
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
