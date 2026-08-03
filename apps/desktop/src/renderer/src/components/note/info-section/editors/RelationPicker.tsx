import { useState } from 'react'
import { formatRelationUri, type RelationKind } from '@memry/contracts/relation-uri'
import { FileText, CheckSquare, Calendar, type AppIcon } from '@/lib/icons'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { Picker } from '@/components/ui/picker'
import { useT } from '@memry/i18n/renderer'
import { useRelationSearch, type RelationSearchResult } from './use-relation-search'

const GROUP_ICONS: Record<RelationKind, AppIcon> = {
  note: FileText,
  task: CheckSquare,
  event: Calendar
}

interface RelationPickerProps {
  /** Called with a `memry://<kind>/<id>` URI when a result is picked. */
  onSelect: (uri: string) => void
}

/**
 * Search content for the relation property picker: a search input plus
 * results grouped into Notes & Files / Tasks / Events. Meant to be mounted
 * inside a Radix Popover by the caller (see RelationEditor's "+" trigger) —
 * this component owns no open/close state of its own, matching how
 * EmojiPicker is dropped into TagIconChip's PopoverContent.
 */
export function RelationPicker({ onSelect }: RelationPickerProps): React.JSX.Element {
  const { t } = useT('notes')
  const [query, setQuery] = useState('')
  const { notes, tasks, events, loading } = useRelationSearch(query)

  const trimmed = query.trim()
  const hasResults = notes.length > 0 || tasks.length > 0 || events.length > 0

  const renderGroup = (
    kind: RelationKind,
    heading: string,
    items: RelationSearchResult[]
  ): React.JSX.Element | null => {
    if (items.length === 0) return null
    const Icon = GROUP_ICONS[kind]
    return (
      <Picker.Section label={heading.toUpperCase()}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            onClick={() => onSelect(formatRelationUri(kind, item.id))}
            className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-start transition-colors hover:bg-accent focus:outline-none focus-visible:bg-accent"
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{item.title}</span>
          </button>
        ))}
      </Picker.Section>
    )
  }

  return (
    <div className="flex w-72 flex-col text-[13px] leading-4 [font-synthesis:none]">
      <FilterSearchHeader
        value={query}
        onChange={setQuery}
        placeholder={t('properties.relation.searchPlaceholder')}
      />
      <Picker.List className="max-h-64 overflow-y-auto">
        {renderGroup('note', t('properties.relation.groupNotes'), notes)}
        {renderGroup('task', t('properties.relation.groupTasks'), tasks)}
        {renderGroup('event', t('properties.relation.groupEvents'), events)}
        {trimmed !== '' && !hasResults && !loading && (
          <Picker.Empty message={t('properties.relation.empty')} />
        )}
      </Picker.List>
    </div>
  )
}
