/**
 * Property Cell Components
 *
 * Renders property values in the folder table view.
 * Handles different property types (text, number, date, checkbox, etc.)
 * and specialized cells for built-in columns (title, folder, tags).
 *
 * Performance: All cell components are wrapped with React.memo to prevent
 * unnecessary re-renders when parent table components update.
 *
 * T117: Added TruncatedTooltip component for shadcn tooltip on truncated content.
 */

import { memo, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { format } from 'date-fns'
import { formatDate as applyDateFormat, type DateFormat } from '@/lib/format-date'
import { useDateFormat } from '@/hooks/use-date-format'
import {
  Check,
  X,
  ExternalLink,
  Folder,
  FileText,
  CheckSquare,
  Calendar,
  type AppIcon
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  TextEditor,
  NumberEditor,
  CheckboxEditor,
  DateEditor,
  UrlEditor
} from '@/components/note/info-section/editors'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import { stringifyUnknown } from '@/lib/stringify-unknown'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { propertiesService } from '@/services/properties-service'
import type { RelationKind, ResolvedRelationRef } from '@memry/contracts/properties-api'
import { useT } from '@memry/i18n/renderer'
import { useRelationNavigation } from '@/hooks/use-relation-navigation'
import { TagChip } from '@/components/note/tags-row/TagChip'
import { toTagChip, type TagMeta, type TagMetaMap } from './note-card-pieces'

const log = createLogger('PropertyCell')

// ============================================================================
// Types
// ============================================================================

export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'url'
  | 'rating'
  | 'relation'

interface PropertyCellProps {
  /** Property value */
  value: unknown
  /** Property type */
  type: PropertyType
  /** Query to highlight in text values */
  highlightQuery?: string
  /** Additional CSS classes */
  className?: string
}

interface EditablePropertyCellProps extends PropertyCellProps {
  /** Called when a property value is saved */
  onSave?: (value: unknown) => void
}

interface TitleCellProps {
  /** Note title */
  title: string
  /** Emoji icon (optional) */
  emoji?: string | null
  /** Click handler (opens note) */
  onClick?: () => void
  /** Query to highlight in title */
  highlightQuery?: string
  /** Additional CSS classes */
  className?: string
}

interface FolderCellProps {
  /** Relative folder path */
  path: string
  /** Click handler to navigate to folder */
  onClick?: () => void
  /** Additional CSS classes */
  className?: string
}

interface TagsCellProps {
  /** Array of tags */
  tags: string[]
  /** Click handler for individual tag */
  onTagClick?: (tag: string) => void
  /** Remove handler for individual tag */
  onTagRemove?: (tag: string) => void
  /** Tag color + icon, keyed by lowercased tag name */
  tagMetaMap?: TagMetaMap
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format a date for display in the table.
 * Format: dd.MM.yyyy - HH:mm:ss
 */
function formatDate(dateStr: string, df: DateFormat): string {
  try {
    const date = new Date(dateStr)
    return `${applyDateFormat(date, df)} - ${format(date, 'HH:mm:ss')}`
  } catch {
    return String(dateStr)
  }
}

// ============================================================================
// T117: Truncated Tooltip Component
// ============================================================================

/**
 * A span that shows a tooltip only when content is truncated.
 * Uses a ref to detect if the content overflows its container.
 */
const TruncatedTooltip = memo(function TruncatedTooltip({
  value,
  children,
  className
}: {
  value: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  const [isTruncated, setIsTruncated] = useState(false)
  const textRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const element = textRef.current
    if (element) {
      // Check if content is truncated (scrollWidth > clientWidth)
      setIsTruncated(element.scrollWidth > element.clientWidth)
    }
  }, [value])

  if (!isTruncated) {
    return (
      <span ref={textRef} className={cn('truncate block', className)}>
        {children}
      </span>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={textRef} className={cn('truncate block cursor-default', className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] break-words">
        {value}
      </TooltipContent>
    </Tooltip>
  )
})

/**
 * Highlight matching text in a string.
 * Returns React elements with highlighted portions wrapped in <mark>.
 * Recursively highlights all occurrences.
 */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query || !text) return text

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const index = lowerText.indexOf(lowerQuery)

  if (index === -1) return text

  const before = text.slice(0, index)
  const match = text.slice(index, index + query.length)
  const after = text.slice(index + query.length)

  return (
    <>
      {before}
      <mark className="bg-yellow-200 dark:bg-yellow-500/30 text-inherit rounded-sm px-0.5">
        {match}
      </mark>
      {highlightText(after, query)}
    </>
  )
}

/**
 * Shallow equality check for property values.
 */
function valuesAreEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, index) => Object.is(item, b[index]))
  }
  return Object.is(a, b)
}

// ============================================================================
// Generic Property Cell
// ============================================================================

/**
 * Renders a property value based on its type.
 */
interface PropertyValueDisplayProps {
  value: unknown
  type: PropertyType
  highlightQuery?: string
  className?: string
  urlAsLink?: boolean
}

function PropertyValueDisplay({
  value,
  type,
  highlightQuery,
  className,
  urlAsLink = true
}: PropertyValueDisplayProps): React.JSX.Element {
  if (value === null || value === undefined || value === '') {
    return <span className={cn('text-muted-foreground/50', className)}>—</span>
  }

  switch (type) {
    case 'checkbox':
      return <CheckboxCell value={Boolean(value)} className={className} />

    case 'number':
      return <NumberCell value={value} className={className} />

    case 'date':
      return <DateCell value={stringifyUnknown(value)} className={className} />

    case 'select':
      return <SelectCell value={stringifyUnknown(value)} className={className} />

    case 'multiselect': {
      const items = Array.isArray(value) ? value : stringifyUnknown(value).split(',')
      return <MultiSelectCell values={items.map(stringifyUnknown)} className={className} />
    }

    case 'url':
      return urlAsLink ? (
        <UrlCell value={stringifyUnknown(value)} className={className} />
      ) : (
        <TextCell
          value={stringifyUnknown(value)}
          highlightQuery={highlightQuery}
          className={className}
        />
      )

    case 'rating': {
      const rating = typeof value === 'number' ? value : parseInt(stringifyUnknown(value), 10) || 0
      return <RatingCell value={rating} className={className} />
    }

    case 'relation':
      // Pass the raw value through untouched (no derived array here) so
      // RelationCell can memoize `uris` off a reference that is actually
      // stable across unrelated re-renders (e.g. highlightQuery changing on
      // every keystroke) instead of a fresh `.map(String)` copy allocated
      // on every render of this dispatcher.
      return <RelationCell value={value} className={className} />

    case 'text':
    default:
      return (
        <TextCell
          value={stringifyUnknown(value)}
          highlightQuery={highlightQuery}
          className={className}
        />
      )
  }
}

export const PropertyCell = memo(function PropertyCell({
  value,
  type,
  highlightQuery,
  className
}: PropertyCellProps): React.JSX.Element {
  return (
    <PropertyValueDisplay
      value={value}
      type={type}
      highlightQuery={highlightQuery}
      className={className}
    />
  )
})

export const EditablePropertyCell = memo(function EditablePropertyCell({
  value,
  type,
  highlightQuery,
  className,
  onSave
}: EditablePropertyCellProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false)

  // If the consumer drops onSave while we're editing, exit edit mode in render
  // so the click-handler-as-effect anti-pattern doesn't trip the linter.
  if (!onSave && isEditing) {
    setIsEditing(false)
  }

  const stopPropagation = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  const handleStartEdit = useCallback(
    (event: React.MouseEvent) => {
      if (!onSave) return
      event.stopPropagation()
      setIsEditing(true)
    },
    [onSave]
  )

  const handleStopEditing = useCallback(() => {
    setIsEditing(false)
  }, [])

  const handleCommit = useCallback(
    (nextValue: unknown) => {
      if (!onSave || valuesAreEqual(value, nextValue)) return
      onSave(nextValue)
    },
    [onSave, value]
  )

  // Relation values are read-only everywhere in the folder view: this cell
  // has no picker or remove control, so an edit affordance here would let a
  // click fall through to the generic text editor below and let a user
  // overwrite the URI array with a plain comma-joined string. Bypass the
  // onSave-driven click-to-edit wrapper unconditionally, regardless of
  // whether the caller passed onSave.
  if (type === 'relation') {
    return (
      <PropertyValueDisplay
        value={value}
        type={type}
        highlightQuery={highlightQuery}
        className={className}
      />
    )
  }

  if (!onSave) {
    return (
      <PropertyValueDisplay
        value={value}
        type={type}
        highlightQuery={highlightQuery}
        className={className}
      />
    )
  }

  if (type === 'checkbox') {
    return (
      <div
        role="presentation"
        className={cn('w-full', className)}
        onClick={stopPropagation}
        onDoubleClick={stopPropagation}
        onKeyDown={stopPropagation}
      >
        <CheckboxEditor value={Boolean(value)} onChange={handleCommit} />
      </div>
    )
  }

  if (isEditing) {
    const textValue =
      value === null || value === undefined
        ? ''
        : Array.isArray(value)
          ? value.map(stringifyUnknown).join(', ')
          : stringifyUnknown(value)
    const numberValue =
      typeof value === 'number'
        ? value
        : (() => {
            const parsed = parseFloat(stringifyUnknown(value))
            return Number.isFinite(parsed) ? parsed : null
          })()
    const dateValue = (() => {
      if (!value) return null
      const parsed = new Date(stringifyUnknown(value))
      return isNaN(parsed.getTime()) ? null : parsed
    })()

    return (
      <div
        role="presentation"
        className={cn('w-full', className)}
        onMouseDown={stopPropagation}
        onClick={stopPropagation}
        onDoubleClick={stopPropagation}
        onKeyDown={stopPropagation}
      >
        {(() => {
          switch (type) {
            case 'number':
            case 'rating':
              return (
                <NumberEditor
                  value={numberValue}
                  onChange={handleCommit}
                  onBlur={handleStopEditing}
                  className="w-full"
                />
              )
            case 'date':
              return (
                <DateEditor
                  value={dateValue}
                  onChange={(date) => handleCommit(date?.toISOString() ?? null)}
                  onBlur={handleStopEditing}
                />
              )
            case 'url':
              return (
                <UrlEditor value={textValue} onChange={handleCommit} onBlur={handleStopEditing} />
              )
            case 'multiselect':
              return (
                <TextEditor
                  value={textValue}
                  onChange={(nextValue) => {
                    const items = nextValue
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean)
                    handleCommit(items)
                  }}
                  onBlur={handleStopEditing}
                />
              )
            case 'text':
            case 'select':
            default:
              return (
                <TextEditor value={textValue} onChange={handleCommit} onBlur={handleStopEditing} />
              )
          }
        })()}
      </div>
    )
  }

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={handleStartEdit}
      onDoubleClick={stopPropagation}
      className={cn('w-full text-start focus:outline-none cursor-text')}
    >
      <PropertyValueDisplay
        value={value}
        type={type}
        highlightQuery={highlightQuery}
        className={className}
        urlAsLink={false}
      />
    </button>
  )
})

// ============================================================================
// Basic Type Cells
// ============================================================================

/**
 * T041: Text cell with ellipsis overflow
 * T117: Now uses TruncatedTooltip for shadcn tooltip on truncated content
 */
export const TextCell = memo(function TextCell({
  value,
  highlightQuery,
  className
}: {
  value: string
  highlightQuery?: string
  className?: string
}): React.JSX.Element {
  return (
    <TruncatedTooltip value={value} className={className}>
      {highlightQuery ? highlightText(value, highlightQuery) : value}
    </TruncatedTooltip>
  )
})

/**
 * T042: Number cell - start aligned (consistent with other cells), formatted with tabular nums
 */
export const NumberCell = memo(function NumberCell({
  value,
  className
}: {
  value: unknown
  className?: string
}): React.JSX.Element {
  const num = typeof value === 'number' ? value : parseFloat(String(value))
  const formatted = isNaN(num) ? String(value) : num.toLocaleString()

  return <span className={cn('tabular-nums', className)}>{formatted}</span>
})

/**
 * T043: Checkbox cell - checkmark or X
 */
export const CheckboxCell = memo(function CheckboxCell({
  value,
  className
}: {
  value: boolean
  className?: string
}): React.JSX.Element {
  return value ? (
    <Check className={cn('h-4 w-4 text-green-500', className)} />
  ) : (
    <X className={cn('h-4 w-4 text-muted-foreground/50', className)} />
  )
})

/**
 * T044: Date cell - relative format
 */
export const DateCell = memo(function DateCell({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  const dateFormat = useDateFormat()
  return (
    <span className={cn('text-muted-foreground whitespace-nowrap', className)} title={value}>
      {formatDate(value, dateFormat)}
    </span>
  )
})

/**
 * T045: Select cell - colored badge
 */
export const SelectCell = memo(function SelectCell({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
        'bg-primary/10 text-primary',
        className
      )}
    >
      {value}
    </span>
  )
})

/**
 * T046: MultiSelect cell - multiple badges
 */
export const MultiSelectCell = memo(function MultiSelectCell({
  values,
  className
}: {
  values: string[]
  className?: string
}): React.JSX.Element {
  if (values.length === 0) {
    return <span className="text-muted-foreground/50">—</span>
  }

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {values.slice(0, 3).map((item) => (
        <span
          key={item}
          className="inline-flex px-1.5 py-0.5 rounded text-xs bg-muted text-muted-foreground"
        >
          {item.trim()}
        </span>
      ))}
      {values.length > 3 && (
        <span className="inline-flex px-1.5 py-0.5 rounded text-xs bg-muted text-muted-foreground">
          +{values.length - 3}
        </span>
      )}
    </div>
  )
})

/**
 * T047: URL cell - clickable link with external icon
 */
export const UrlCell = memo(function UrlCell({
  value,
  className
}: {
  value: string
  className?: string
}): React.JSX.Element {
  // Extract domain for display
  let displayText = value
  try {
    const url = new URL(value)
    displayText = url.hostname + (url.pathname !== '/' ? url.pathname : '')
  } catch {
    // Keep original value if not a valid URL
  }

  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-primary hover:underline truncate max-w-full',
        className
      )}
      onClick={(e) => e.stopPropagation()}
      title={value}
    >
      <span className="truncate">{displayText}</span>
      <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-50" />
    </a>
  )
})

/**
 * T048: Rating cell - star display
 */
export const RatingCell = memo(function RatingCell({
  value,
  max = 5,
  className
}: {
  value: number
  max?: number
  className?: string
}): React.JSX.Element {
  const rating = Math.min(Math.max(0, value), max)

  return (
    <span className={cn('text-amber-500 whitespace-nowrap', className)} title={`${rating}/${max}`}>
      {'★'.repeat(rating)}
      {'☆'.repeat(max - rating)}
    </span>
  )
})

// ============================================================================
// Relation ref batching
// ============================================================================

/**
 * Coalesces resolveRefs calls made within the same tick into a single IPC
 * round trip. A virtualized folder table mounts many RelationCell instances
 * in one React commit (one per visible relation cell); without this, each
 * cell's own effect would call resolveRefs independently, issuing one IPC
 * call per visible row instead of one per rendered page. Every call queued
 * before the microtask flush runs is merged into one deduped request, and
 * results are fanned back out to each caller by URI.
 */
let pendingRelationUris = new Set<string>()
let pendingRelationWaiters: Array<{
  uris: string[]
  resolve: (refs: ResolvedRelationRef[]) => void
}> = []
let relationFlushScheduled = false

function flushRelationRefBatch(): void {
  const uris = Array.from(pendingRelationUris)
  const waiters = pendingRelationWaiters
  pendingRelationUris = new Set()
  pendingRelationWaiters = []
  relationFlushScheduled = false

  void (async () => {
    let refs: ResolvedRelationRef[] = []
    try {
      refs = await propertiesService.resolveRefs(uris)
    } catch (err) {
      log.error('Failed to resolve relation refs:', extractErrorMessage(err))
    }
    const byUri = new Map(refs.map((ref) => [ref.uri, ref]))
    for (const waiter of waiters) {
      waiter.resolve(
        waiter.uris
          .map((uri) => byUri.get(uri))
          .filter((ref): ref is ResolvedRelationRef => ref !== undefined)
      )
    }
  })()
}

function resolveRelationRefsBatched(uris: string[]): Promise<ResolvedRelationRef[]> {
  if (uris.length === 0) return Promise.resolve([])
  return new Promise((resolve) => {
    uris.forEach((uri) => pendingRelationUris.add(uri))
    pendingRelationWaiters.push({ uris, resolve })
    if (!relationFlushScheduled) {
      relationFlushScheduled = true
      queueMicrotask(flushRelationRefBatch)
    }
  })
}

// Stable empty-array reference so a non-array/missing value also keeps
// `uris` referentially stable across re-renders (see the memo below).
const EMPTY_RELATION_URIS: string[] = []

const RELATION_KIND_ICONS: Record<RelationKind, AppIcon> = {
  note: FileText,
  task: CheckSquare,
  event: Calendar
}

/**
 * Read-only relation chips for the folder table. No picker, no remove
 * control, no click-to-edit — this view never writes to the property.
 * Dangling refs (exists: false, including URIs not yet resolved) render in
 * the same muted "deleted" treatment as the note-side RelationEditor.
 */
export const RelationCell = memo(function RelationCell({
  value,
  className
}: {
  value: unknown
  className?: string
}): React.JSX.Element {
  const { t } = useT('notes')
  const navigate = useRelationNavigation()
  const [resolved, setResolved] = useState<ResolvedRelationRef[]>([])

  // Derived from `value` (not created fresh from it) so `uris` keeps the
  // same reference across re-renders where `value` itself is unchanged —
  // e.g. a folder-search keystroke re-renders every visible cell via
  // highlightQuery, but `note.properties[columnId]` (the raw `value` this
  // receives) stays the same array. Without this memo, a new `uris` array
  // every render would re-fire the effect below and re-issue an IPC call
  // for data that never changed — the same "per-cell fetch" defect the
  // batching above exists to avoid, just triggered by re-render instead of
  // row count.
  const uris = useMemo(
    () => (Array.isArray(value) ? value.map(String) : EMPTY_RELATION_URIS),
    [value]
  )

  useEffect(() => {
    if (uris.length === 0) return

    let cancelled = false
    void (async () => {
      const refs = await resolveRelationRefsBatched(uris)
      if (!cancelled) setResolved(refs)
    })()

    return () => {
      cancelled = true
    }
  }, [uris])

  if (uris.length === 0) {
    return <span className={cn('text-muted-foreground/50', className)}>—</span>
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {resolved.map((ref) => {
        const Icon = RELATION_KIND_ICONS[ref.targetType]
        const label = ref.exists ? ref.title : t('properties.relation.deleted')

        // A note's own emoji stands in for the generic kind icon.
        const glyph = ref.emoji ? (
          <span className="size-3 shrink-0 leading-none text-[11px]" aria-hidden>
            {ref.emoji}
          </span>
        ) : (
          <Icon className="size-3 shrink-0" aria-hidden />
        )

        const chipClass = cn(
          '[font-synthesis:none] inline-flex items-center gap-1',
          'rounded-[10px] ps-1.5 pe-1.5 py-0.5',
          'text-[11px]/3.5 font-medium',
          'shrink-0 select-none max-w-full',
          ref.exists ? 'bg-tint/10 text-tint' : 'bg-muted text-muted-foreground'
        )

        // The cell is read-only for editing, but navigation is a read action.
        // A dangling ref has nothing to open and stays inert.
        if (!ref.exists) {
          return (
            <span key={ref.uri} className={chipClass}>
              {glyph}
              <span className="truncate">{label}</span>
            </span>
          )
        }

        return (
          <button
            key={ref.uri}
            type="button"
            title={ref.title}
            // The row around this cell has its own click behaviour; opening a
            // chip must not also trigger it.
            onClick={(event) => {
              event.stopPropagation()
              navigate(ref)
            }}
            className={cn(
              chipClass,
              'transition-opacity duration-150 hover:opacity-80',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
            )}
          >
            {glyph}
            <span className="truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
})

// ============================================================================
// Specialized Built-in Cells
// ============================================================================

/**
 * T049: Title cell - emoji + title, clickable
 * Single click opens note in permanent tab
 */
export const TitleCell = memo(function TitleCell({
  title,
  emoji,
  onClick,
  highlightQuery,
  className
}: TitleCellProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      className={cn(
        'group flex items-center gap-2 text-start text-[13px] text-foreground/90 hover:text-primary transition-colors truncate w-full',
        'focus:outline-none focus:text-primary cursor-pointer',
        className
      )}
      title={title}
    >
      <span className="flex size-5 flex-shrink-0 items-center justify-center leading-none">
        {emoji ? (
          <NoteIconDisplay value={emoji} className="size-5 text-sm" />
        ) : (
          <FileText className="size-5 text-muted-foreground" />
        )}
      </span>
      <span className="truncate font-medium group-hover:underline">
        {highlightQuery ? highlightText(title, highlightQuery) : title}
      </span>
    </button>
  )
})

/**
 * T050: Folder cell - relative folder path with icon
 */
export const FolderCell = memo(function FolderCell({
  path,
  onClick,
  className
}: FolderCellProps): React.JSX.Element {
  // Root folder display
  if (!path || path === '/') {
    return <span className={cn('text-muted-foreground/50', className)}>—</span>
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      className={cn(
        'flex items-center gap-1.5 text-start text-muted-foreground hover:text-foreground transition-colors truncate',
        'focus:outline-none focus:text-foreground',
        className
      )}
      title={path}
    >
      <Folder className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate text-sm">{path}</span>
    </button>
  )
})

/**
 * Wraps the shared {@link TagChip} pill so the tags cell can measure its width
 * for the "+N" overflow collapse. Overflow chips stay rendered but offscreen.
 * Uses the same pill as the sidebar / note tags, so colors + icons match.
 */
function MeasuredTagPill({
  tag,
  meta,
  onTagClick,
  onTagRemove,
  offscreen
}: {
  tag: string
  meta?: TagMeta
  onTagClick?: (tag: string) => void
  onTagRemove?: (tag: string) => void
  /** Kept in the DOM for width measurement but pulled out of flow + hidden. */
  offscreen?: boolean
}): React.JSX.Element {
  return (
    <span
      data-tag-chip
      className={cn('inline-flex shrink-0', offscreen && 'pointer-events-none invisible absolute')}
    >
      <TagChip
        tag={toTagChip(tag, meta)}
        onClick={onTagClick ? () => onTagClick(tag) : undefined}
        onRemove={onTagRemove}
      />
    </span>
  )
}

/**
 * Measure how many tag chips fit on one line, reserving room for the "+N" chip.
 * All chips stay rendered (overflow ones go offscreen) so widths are always
 * measurable. Falls back to showing every tag when there is no layout (e.g. jsdom).
 */
function useTagOverflow(
  tagKey: string,
  count: number
): {
  containerRef: React.RefObject<HTMLDivElement | null>
  visible: number
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(count)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const GAP = 4 // matches gap-1
    const RESERVE = 44 // room for the "+N" chip

    const recompute = (): void => {
      const avail = el.clientWidth
      const chips = el.querySelectorAll<HTMLElement>('[data-tag-chip]')
      if (!avail || chips.length === 0) {
        setVisible(count)
        return
      }
      let used = 0
      let fit = 0
      for (const chip of chips) {
        const next = used + (fit > 0 ? GAP : 0) + chip.offsetWidth
        if (next > avail) break
        used = next
        fit++
      }
      // Make room for the "+N" chip when something overflows.
      while (fit > 0 && fit < chips.length && used + GAP + RESERVE > avail) {
        used -= GAP + chips[fit - 1].offsetWidth
        fit--
      }
      setVisible(Math.max(1, fit))
    }

    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [tagKey, count])

  return { containerRef, visible }
}

/**
 * T051: Tags cell - multiple colored tag badges on a single line. Tags that
 * don't fit collapse into a "+N" chip; hovering it reveals the rest.
 */
export const TagsCell = memo(function TagsCell({
  tags,
  onTagClick,
  onTagRemove,
  tagMetaMap,
  className
}: TagsCellProps): React.JSX.Element {
  const { containerRef, visible } = useTagOverflow((tags ?? []).join(''), tags?.length ?? 0)

  if (!tags || tags.length === 0) {
    return <span className="text-muted-foreground/50">—</span>
  }

  const hiddenCount = tags.length - visible

  return (
    <div
      ref={containerRef}
      className={cn('relative flex flex-nowrap items-center gap-1 overflow-hidden', className)}
    >
      {tags.map((tag, i) => (
        <MeasuredTagPill
          key={tag}
          tag={tag}
          meta={tagMetaMap?.get(tag.toLowerCase())}
          onTagClick={onTagClick}
          onTagRemove={onTagRemove}
          offscreen={i >= visible}
        />
      ))}
      {hiddenCount > 0 && (
        <HoverCard openDelay={100} closeDelay={100}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-medium',
                'bg-muted text-muted-foreground hover:bg-muted/80 focus:outline-none'
              )}
              aria-label={`Show ${hiddenCount} more tags`}
            >
              +{hiddenCount}
            </button>
          </HoverCardTrigger>
          <HoverCardContent align="start" className="w-auto max-w-xs p-2">
            <div className="flex flex-wrap gap-1">
              {tags.slice(visible).map((tag) => (
                <MeasuredTagPill
                  key={tag}
                  tag={tag}
                  meta={tagMetaMap?.get(tag.toLowerCase())}
                  onTagClick={onTagClick}
                  onTagRemove={onTagRemove}
                />
              ))}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  )
})

// ============================================================================
// Word Count Cell (built-in)
// ============================================================================

/**
 * Word count cell - formatted number with "words" label
 */
export const WordCountCell = memo(function WordCountCell({
  value,
  className
}: {
  value: number
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn('tabular-nums text-muted-foreground text-sm', className)}>
      {value.toLocaleString()}
    </span>
  )
})

export default PropertyCell
