import { useEffect, useState } from 'react'

import type { CalendarEventRecord } from '@memry/contracts/calendar-api'
import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'

import { MentionIcon, type MentionAttachment, type MentionIconSpec } from './mention-icons'
import { cn } from '@/lib/utils'

interface RefPickerProps {
  query: string
  selectedIndex: number
  onItemsChange: (items: MentionAttachment[]) => void
  onPick: (attachment: MentionAttachment) => void
  onSelectedIndexChange: (index: number) => void
  onClose: () => void
}

interface RefPickerResult {
  kind: AttachmentInput['kind']
  id: string
  label: string
  icon: MentionIconSpec
}

function toAttachmentResult(item: SearchResultItem): RefPickerResult | null {
  switch (item.metadata.type) {
    case 'note':
      return {
        kind: 'note',
        id: item.id,
        label: item.title,
        icon: { kind: 'note', emoji: item.metadata.emoji ?? null }
      }
    case 'task':
      return {
        kind: 'task',
        id: item.id,
        label: item.title,
        icon: { kind: 'task' }
      }
    case 'journal':
      return {
        kind: 'journal',
        id: item.id,
        label: item.title,
        icon: { kind: 'journal' }
      }
    case 'inbox':
      return {
        kind: 'inbox',
        id: item.id,
        label: item.title,
        icon: { kind: 'inbox', itemType: item.metadata.itemType }
      }
  }
}

function matchesCalendarEvent(event: CalendarEventRecord, query: string): boolean {
  const normalizedQuery = query.toLowerCase()
  const searchableText = [
    event.title,
    event.startAt,
    event.endAt,
    event.location,
    event.description
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return searchableText.includes(normalizedQuery)
}

async function loadSearchResults(text: string): Promise<RefPickerResult[]> {
  try {
    const response = await window.api.search.query({ text, limit: 20 })
    return response.groups.flatMap((group) =>
      group.results.flatMap((item) => {
        const result = toAttachmentResult(item)
        return result ? [result] : []
      })
    )
  } catch {
    return []
  }
}

async function loadCalendarResults(text: string): Promise<RefPickerResult[]> {
  try {
    const response = await window.api.calendar.listEvents({ includeArchived: false })
    return response.events
      .filter((event) => matchesCalendarEvent(event, text))
      .map((event) => ({
        kind: 'calendar_event',
        id: event.id,
        label: event.title,
        icon: { kind: 'calendar_event' }
      }))
  } catch {
    return []
  }
}

function toMentionAttachment(result: RefPickerResult): MentionAttachment {
  return {
    kind: result.kind,
    ref_id: result.id,
    label: result.label,
    icon: result.icon
  }
}

export function RefPicker({
  query,
  selectedIndex,
  onItemsChange,
  onPick,
  onSelectedIndexChange,
  onClose
}: RefPickerProps): React.JSX.Element {
  const { t } = useT('common')
  const [results, setResults] = useState<RefPickerResult[]>([])
  const [prevQuery, setPrevQuery] = useState(query)

  // Clear stale results synchronously at render when the query changes, so
  // keyboard selection never targets a previous query's refs while async
  // sources reload (render-time reset instead of a synchronous effect reset).
  if (query !== prevQuery) {
    setPrevQuery(query)
    setResults([])
  }

  useEffect(() => {
    const text = query.trim()
    let cancelled = false
    onItemsChange([])
    onSelectedIndexChange(-1)

    void Promise.all([loadSearchResults(text), loadCalendarResults(text)]).then(
      ([searchResults, calendarResults]) => {
        if (cancelled) return
        const nextResults = [...searchResults, ...calendarResults].slice(0, 20)
        setResults(nextResults)
        onItemsChange(nextResults.map(toMentionAttachment))
        onSelectedIndexChange(nextResults.length > 0 ? 0 : -1)
      }
    )

    return () => {
      cancelled = true
    }
  }, [onItemsChange, onSelectedIndexChange, query])

  return (
    <div
      role="listbox"
      tabIndex={-1}
      className="absolute inset-x-2 bottom-full z-50 mb-2 max-h-64 overflow-y-auto rounded-md border border-sidebar-border bg-popover p-1 text-popover-foreground shadow-md"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      {results.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {t('agentChat.refPicker.noMatches')}
        </div>
      )}
      {results.map((result, index) => {
        const selected = index === selectedIndex
        return (
          <button
            key={`${result.kind}-${result.id}`}
            type="button"
            role="option"
            aria-selected={selected}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent hover:text-accent-foreground',
              selected && 'bg-accent text-accent-foreground'
            )}
            onMouseEnter={() => onSelectedIndexChange(index)}
            onClick={() => onPick(toMentionAttachment(result))}
          >
            <MentionIcon icon={result.icon} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{result.label}</span>
          </button>
        )
      })}
    </div>
  )
}
