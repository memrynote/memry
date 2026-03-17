import { useState, useEffect, useCallback } from 'react'
import { FileText, BookOpen, CheckSquare, Inbox, X, Filter, Tag, Calendar } from '@/lib/icons'
import type { ContentType, DateRange } from '@memry/contracts/search-api'
import { searchService } from '@/services/search-service'

interface SearchFiltersProps {
  activeTypes: ContentType[]
  activeTags: string[]
  activeDateRange: DateRange | null
  onToggleType: (type: ContentType) => void
  onToggleTag: (tag: string) => void
  onSetDateRange: (range: DateRange | null) => void
  onClear: () => void
}

const TYPE_CONFIG: Array<{
  type: ContentType
  label: string
  icon: typeof FileText
  shortcut: string
}> = [
  { type: 'note', label: 'Notes', icon: FileText, shortcut: '1' },
  { type: 'journal', label: 'Journal', icon: BookOpen, shortcut: '2' },
  { type: 'task', label: 'Tasks', icon: CheckSquare, shortcut: '3' },
  { type: 'inbox', label: 'Inbox', icon: Inbox, shortcut: '4' }
]

const DATE_PRESETS = [
  { label: 'Today', getValue: () => todayRange() },
  { label: 'This Week', getValue: () => thisWeekRange() },
  { label: 'This Month', getValue: () => thisMonthRange() }
] as const

function todayRange(): DateRange {
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  return { from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.999Z` }
}

function thisWeekRange(): DateRange {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const start = new Date(now)
  start.setDate(now.getDate() - dayOfWeek)
  return {
    from: `${start.toISOString().slice(0, 10)}T00:00:00.000Z`,
    to: `${now.toISOString().slice(0, 10)}T23:59:59.999Z`
  }
}

function thisMonthRange(): DateRange {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  return {
    from: `${start.toISOString().slice(0, 10)}T00:00:00.000Z`,
    to: `${now.toISOString().slice(0, 10)}T23:59:59.999Z`
  }
}

export function SearchFilters({
  activeTypes,
  activeTags,
  activeDateRange,
  onToggleType,
  onToggleTag,
  onSetDateRange,
  onClear
}: SearchFiltersProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [allTags, setAllTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')

  const hasFilters = activeTypes.length > 0 || activeTags.length > 0 || activeDateRange !== null

  useEffect(() => {
    if (expanded && allTags.length === 0) {
      searchService
        .getAllTags()
        .then(setAllTags)
        .catch(() => {})
    }
  }, [expanded, allTags.length])

  const filteredTags = tagInput
    ? allTags.filter(
        (t) => t.toLowerCase().includes(tagInput.toLowerCase()) && !activeTags.includes(t)
      )
    : []

  const handleTagSelect = useCallback(
    (tag: string) => {
      onToggleTag(tag)
      setTagInput('')
    },
    [onToggleTag]
  )

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-1.5 px-3 py-2">
        {TYPE_CONFIG.map(({ type, label, icon: Icon, shortcut }) => {
          const isActive = activeTypes.includes(type)
          return (
            <button
              key={type}
              type="button"
              onClick={() => onToggleType(type)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
                transition-colors duration-75
                ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
            >
              <Icon className="size-3.5" />
              <span>{label}</span>
              <kbd className="text-[9px] opacity-50 ml-0.5">{shortcut}</kbd>
            </button>
          )
        })}

        <button
          type="button"
          onClick={() => setExpanded((p) => !p)}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs ml-auto
            transition-colors duration-75
            ${
              expanded
                ? 'bg-surface-active text-foreground'
                : 'text-text-tertiary hover:text-foreground'
            }`}
        >
          <Filter className="size-3" />
        </button>

        {hasFilters && (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-tertiary
              hover:text-foreground transition-colors"
          >
            <X className="size-3" />
            Clear
          </button>
        )}
      </div>

      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary mb-1">
              <Tag className="size-3" />
              Tags
            </div>
            <div className="flex flex-wrap gap-1 mb-1">
              {activeTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onToggleTag(tag)}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
                    bg-primary text-primary-foreground"
                >
                  {tag}
                  <X className="size-2.5" />
                </button>
              ))}
            </div>
            <div className="relative">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Filter by tag..."
                className="w-full h-7 px-2 text-xs bg-muted rounded
                  border border-border text-foreground
                  placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border"
              />
              {filteredTags.length > 0 && (
                <div
                  className="absolute top-full mt-1 w-full bg-popover rounded
                  border border-border shadow-lg max-h-32 overflow-y-auto z-10"
                >
                  {filteredTags.slice(0, 10).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleTagSelect(tag)}
                      className="block w-full text-left px-2 py-1 text-xs text-muted-foreground
                        hover:bg-muted"
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-xs text-text-tertiary mb-1">
              <Calendar className="size-3" />
              Date Range
            </div>
            <div className="flex gap-1">
              {DATE_PRESETS.map(({ label, getValue }) => {
                const rangeVal = getValue()
                const isActive =
                  activeDateRange?.from === rangeVal.from && activeDateRange?.to === rangeVal.to
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onSetDateRange(isActive ? null : rangeVal)}
                    className={`px-2 py-1 rounded text-xs transition-colors
                      ${
                        isActive
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      }`}
                  >
                    {label}
                  </button>
                )
              })}
              {activeDateRange && (
                <button
                  type="button"
                  onClick={() => onSetDateRange(null)}
                  className="px-2 py-1 text-xs text-text-tertiary hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
