import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import type { CalendarEventRecord } from '@memry/contracts/calendar-api'
import type { AttachmentInput } from '@memry/contracts/ipc-agent'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'

import { MentionIcon, type MentionAttachment, type MentionIconSpec } from './mention-icons'
import { useDebouncedValue } from '@/hooks/use-task-filters'
import { cn } from '@/lib/utils'

interface RefPickerProps {
  query: string
  selectedIndex: number
  /**
   * Element the picker anchors to. The list renders in a `document.body` portal
   * with `position: fixed` so an `overflow` ancestor (e.g. the review flyout)
   * cannot clip it.
   */
  anchorRef: RefObject<HTMLElement | null>
  onItemsChange: (items: MentionAttachment[]) => void
  onPick: (attachment: MentionAttachment) => void
  onSelectedIndexChange: (index: number) => void
  onClose: () => void
}

const PICKER_GAP = 8
const PICKER_MARGIN = 8
const PICKER_MAX_HEIGHT = 256
/**
 * Short enough that typing then pausing still feels instant, long enough that a
 * burst of keystrokes collapses into a single search + calendar round-trip.
 */
const SEARCH_DEBOUNCE_MS = 150

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
  anchorRef,
  onItemsChange,
  onPick,
  onSelectedIndexChange,
  onClose
}: RefPickerProps): React.JSX.Element {
  const { t } = useT('common')
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS)
  const [results, setResults] = useState<RefPickerResult[]>([])
  const [prevQuery, setPrevQuery] = useState(query)
  const [portalStyle, setPortalStyle] = useState<CSSProperties>({
    position: 'fixed',
    visibility: 'hidden'
  })

  // Clear stale results synchronously at render when the query changes, so
  // keyboard selection never targets a previous query's refs while async
  // sources reload (render-time reset instead of a synchronous effect reset).
  if (query !== prevQuery) {
    setPrevQuery(query)
    setResults([])
  }

  // Dropping the mention list is cheap and has to happen on every keystroke so
  // the parent can never insert a ref belonging to a previous query.
  useEffect(() => {
    onItemsChange([])
    onSelectedIndexChange(-1)
  }, [onItemsChange, onSelectedIndexChange, query])

  // The sources behind the list are not cheap — an FTS query and a calendar
  // range query, one main-process round-trip each — so they run off the
  // debounced query instead. A burst of typing costs one pair of round-trips
  // rather than one pair per character; `cancelled` drops a slower in-flight
  // search so it cannot clobber a newer query's results.
  useEffect(() => {
    const text = debouncedQuery.trim()
    let cancelled = false

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
  }, [debouncedQuery, onItemsChange, onSelectedIndexChange])

  // Anchor the portal to the composer and keep it aligned while the surrounding
  // container scrolls or the window resizes. Prefers the side with more room so
  // the list never opens off-screen.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return

    const reposition = (): void => {
      const rect = anchor.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const spaceBelow = viewportHeight - rect.bottom
      const spaceAbove = rect.top
      const openBelow = spaceBelow >= spaceAbove
      const available = (openBelow ? spaceBelow : spaceAbove) - PICKER_GAP - PICKER_MARGIN
      const maxHeight = Math.max(96, Math.min(PICKER_MAX_HEIGHT, available))

      setPortalStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        maxHeight,
        ...(openBelow
          ? { top: rect.bottom + PICKER_GAP }
          : { bottom: viewportHeight - rect.top + PICKER_GAP })
      })
    }

    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [anchorRef])

  return createPortal(
    <div
      role="listbox"
      tabIndex={-1}
      data-ref-picker=""
      style={portalStyle}
      className="z-50 overflow-y-auto rounded-md border border-sidebar-border bg-popover p-1 text-popover-foreground shadow-md"
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
    </div>,
    document.body
  )
}
