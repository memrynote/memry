import { useMemo, useState } from 'react'
import { Command } from 'cmdk'
import type {
  SearchResultGroup as SearchResultGroupType,
  SearchResultItem as SearchResultItemType,
  ContentType
} from '@memry/contracts/search-api'
import { SearchResultItem } from './search-result-item'
import { useT } from '@memry/i18n/renderer'

interface SearchResultGroupProps {
  group: SearchResultGroupType
  query: string
  onSelect: (item: SearchResultItemType) => void
  initialLimit?: number
}

const TYPE_LABELS: Record<ContentType, string> = {
  note: 'Notes',
  journal: 'Journal',
  task: 'Tasks',
  inbox: 'Inbox'
}

export function SearchResultGroup({
  group,
  query,
  onSelect,
  initialLimit = 5
}: SearchResultGroupProps): React.JSX.Element {
  const { t: tPhaseF } = useT('common')
  const [expanded, setExpanded] = useState(false)

  const visibleResults = expanded ? group.results : group.results.slice(0, initialLimit)
  const hasMore = group.results.length > initialLimit

  const heading = useMemo(
    () => (
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          {TYPE_LABELS[group.type]}
        </span>
        <span className="text-xs tabular-nums text-text-tertiary">{group.totalInGroup}</span>
      </div>
    ),
    [group.type, group.totalInGroup]
  )

  return (
    <Command.Group heading={heading}>
      {visibleResults.map((item) => (
        <SearchResultItem key={item.id} item={item} query={query} onSelect={onSelect} />
      ))}
      {hasMore && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full px-3 py-1.5 text-xs text-center text-text-tertiary hover:text-foreground transition-colors"
        >
          {tPhaseF('phaseF.componentsSearchSearchResultGroup.viewAll')}
          {group.totalInGroup} {tPhaseF('phaseF.componentsSearchSearchResultGroup.results')}
        </button>
      )}
    </Command.Group>
  )
}
