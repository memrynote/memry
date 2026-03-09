import { Clock, X, Trash2 } from 'lucide-react'
import type { RecentSearch } from '@memry/contracts/search-api'

interface RecentSearchesProps {
  searches: RecentSearch[]
  onSelect: (query: string) => void
  onClear: () => void
}

export function RecentSearches({
  searches,
  onSelect,
  onClear
}: RecentSearchesProps): React.JSX.Element {
  if (searches.length === 0) {
    return <div className="py-8 text-center text-sm text-gray-400">No recent searches</div>
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          Recent
        </span>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600
            dark:hover:text-gray-300 transition-colors"
        >
          <Trash2 className="size-3" />
          Clear
        </button>
      </div>
      {searches.map((search) => (
        <button
          key={search.id}
          type="button"
          onClick={() => onSelect(search.query)}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-left
            hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-75 group"
        >
          <Clock className="size-3.5 text-gray-400 dark:text-gray-500 shrink-0" />
          <span className="flex-1 text-sm text-gray-700 dark:text-gray-300 truncate">
            {search.query}
          </span>
          <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums shrink-0">
            {search.resultCount}
          </span>
        </button>
      ))}
    </div>
  )
}
