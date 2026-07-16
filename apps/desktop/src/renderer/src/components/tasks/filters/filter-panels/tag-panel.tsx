import { useMemo } from 'react'

import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { FilterFooter } from '@/components/ui/filter-footer'
import { StatusDot } from '@/components/ui/status-dot'
import { getTagColors } from '@/components/note/tags-row'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import type { Task } from '@/data/task-model'
import { BackButton } from './priority-panel'
import { useT } from '@memry/i18n/renderer'

interface TagPanelProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  onClose: () => void
  onGoBack: () => void
  tasks: Task[]
}

export function TagPanel({
  searchQuery,
  onSearchChange,
  selectedTags,
  onToggleTag,
  onClose,
  onGoBack,
  tasks
}: TagPanelProps): React.JSX.Element {
  const { t: tPhaseF } = useT('tasks')
  const { tags: tagDefs } = useNoteTagsQuery()

  const filteredTags = useMemo(() => {
    if (!searchQuery) return tagDefs
    const q = searchQuery.toLowerCase()
    return tagDefs.filter((def) => def.tag.toLowerCase().includes(q))
  }, [tagDefs, searchQuery])

  const countsByTag = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      for (const tag of task.tags) {
        const key = tag.toLowerCase()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }, [tasks])

  return (
    <>
      <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
        <BackButton onClick={onGoBack} />
        <svg
          width="13"
          height="13"
          viewBox="0 0 13 13"
          fill="none"
          className="text-muted-foreground"
        >
          <path
            d="M1.5 1.5h4.5l6 6-4.5 4.5-6-6V1.5z"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinejoin="round"
          />
          <circle cx="4" cy="4" r="0.9" fill="currentColor" />
        </svg>
        <span className="text-[13px] text-foreground font-medium leading-4">
          {tPhaseF('phaseF.componentsTasksFiltersFilterPanelsTagPanel.tags')}
        </span>
        <span className="text-[11px] ms-auto text-foreground leading-3.5">
          {tPhaseF('phaseF.componentsTasksFiltersFilterPanelsTagPanel.is')}
        </span>
      </div>
      <FilterSearchHeader
        value={searchQuery}
        onChange={onSearchChange}
        placeholder={tPhaseF('phaseF.componentsTasksFiltersFilterPanelsTagPanel.search')}
        className="py-1.5"
      />
      <div className="flex flex-col p-1">
        {filteredTags.map((def) => {
          const checked = selectedTags.some((x) => x.toLowerCase() === def.tag.toLowerCase())
          const colors = getTagColors(def.color, def.tag)
          const count = countsByTag.get(def.tag.toLowerCase()) ?? 0
          return (
            <button
              key={def.tag}
              type="button"
              onClick={() => onToggleTag(def.tag)}
              className={cn(
                'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
                checked ? 'bg-accent' : 'hover:bg-accent'
              )}
            >
              <StatusDot color={colors.text} />
              <span
                className={cn(
                  'text-[13px] leading-4',
                  checked ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {def.tag}
              </span>
              <span
                className={cn(
                  'ms-auto text-[11px] leading-3.5 tabular-nums',
                  checked ? 'text-text-secondary' : 'text-text-tertiary'
                )}
              >
                {count}
              </span>
              {checked && <CheckMark className="text-foreground" />}
            </button>
          )
        })}
      </div>
      <FilterFooter
        onClear={() => {}}
        onApply={onClose}
        info={
          <span className="text-[11px] text-text-tertiary leading-3.5">
            {selectedTags.length}{' '}
            {tPhaseF('phaseF.componentsTasksFiltersFilterPanelsTagPanel.selected')}
          </span>
        }
        className="py-2 px-3"
      />
    </>
  )
}
