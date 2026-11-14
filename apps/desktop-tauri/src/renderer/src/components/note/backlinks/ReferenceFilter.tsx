import type { ReferenceSourceFacets } from '@memry/contracts/notes-api'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { ChevronDown } from '@/lib/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

export type ReferenceFilterValue =
  | { kind: 'all' }
  | { kind: 'notes' }
  | { kind: 'journal' }
  | { kind: 'tag'; tag: string }

export const ALL_REFERENCES: ReferenceFilterValue = { kind: 'all' }

export function matchesReferenceFilter(
  source: ReferenceSourceFacets,
  filter: ReferenceFilterValue
): boolean {
  switch (filter.kind) {
    case 'all':
      return true
    case 'notes':
      return source.sourceJournalDate === null
    case 'journal':
      return source.sourceJournalDate !== null
    case 'tag':
      return source.sourceTags.includes(filter.tag)
    default: {
      const _exhaustive: never = filter
      return _exhaustive
    }
  }
}

function isSelected(value: ReferenceFilterValue, option: ReferenceFilterValue): boolean {
  if (value.kind === 'tag' && option.kind === 'tag') return value.tag === option.tag
  return value.kind === option.kind
}

/**
 * Narrows a note's references to notes, journal entries, or one tag of the
 * referencing notes. Hidden while every source would pass every choice, unless
 * a filter is already set and must stay clearable.
 */
export function ReferenceFilter({
  sources,
  value,
  onChange
}: {
  sources: readonly ReferenceSourceFacets[]
  value: ReferenceFilterValue
  onChange: (value: ReferenceFilterValue) => void
}) {
  const { t } = useT('notes')
  const hasJournal = sources.some((source) => source.sourceJournalDate !== null)
  const hasNotes = sources.some((source) => source.sourceJournalDate === null)
  const tags = [...new Set(sources.flatMap((source) => source.sourceTags))].toSorted((a, b) =>
    a.localeCompare(b)
  )
  if (value.kind === 'all' && !(hasJournal && hasNotes) && tags.length === 0) return null

  const labelOf = (option: ReferenceFilterValue): string => {
    switch (option.kind) {
      case 'all':
        return t('references.filterAll')
      case 'notes':
        return t('references.filterNotes')
      case 'journal':
        return t('references.filterJournal')
      case 'tag':
        return `#${option.tag}`
      default: {
        const _exhaustive: never = option
        return _exhaustive
      }
    }
  }
  const item = (option: ReferenceFilterValue) => (
    <DropdownMenuItem
      key={option.kind === 'tag' ? `tag:${option.tag}` : option.kind}
      onClick={() => onChange(option)}
      className={cn(isSelected(value, option) && 'bg-surface-active')}
    >
      {labelOf(option)}
    </DropdownMenuItem>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5',
            'text-[11px] text-text-tertiary',
            'hover:text-muted-foreground hover:bg-surface-active/40 rounded',
            'transition-colors duration-150',
            value.kind !== 'all' && 'text-muted-foreground'
          )}
          aria-label={t('references.filterBy', { filter: labelOf(value) })}
        >
          {labelOf(value)}
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-[160px] overflow-y-auto">
        {item(ALL_REFERENCES)}
        {item({ kind: 'notes' })}
        {item({ kind: 'journal' })}
        {tags.length > 0 && <DropdownMenuSeparator />}
        {tags.map((tag) => item({ kind: 'tag', tag }))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
