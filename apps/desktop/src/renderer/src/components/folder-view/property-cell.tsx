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

import { memo, useState, useRef, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import { Check, X, ExternalLink, Folder, FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  TextEditor,
  NumberEditor,
  CheckboxEditor,
  DateEditor,
  UrlEditor
} from '@/components/note/info-section/editors'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NoteIconDisplay } from '@/lib/render-note-icon'

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
  /** Query to highlight in tags */
  highlightQuery?: string
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
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    return format(date, 'dd.MM.yyyy - HH:mm:ss')
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
 * Get a color class for a tag based on its name (deterministic).
 */
function getTagColor(tag: string): string {
  const colors = [
    'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    'bg-green-500/15 text-green-700 dark:text-green-400',
    'bg-purple-500/15 text-purple-700 dark:text-purple-400',
    'bg-orange-500/15 text-orange-700 dark:text-orange-400',
    'bg-pink-500/15 text-pink-700 dark:text-pink-400',
    'bg-cyan-500/15 text-cyan-700 dark:text-cyan-400',
    'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
    'bg-red-500/15 text-red-700 dark:text-red-400'
  ]
  // Simple hash based on tag name
  let hash = 0
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length]
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
      return <DateCell value={String(value)} className={className} />

    case 'select':
      return <SelectCell value={String(value)} className={className} />

    case 'multiselect': {
      const items = Array.isArray(value) ? value : String(value).split(',')
      return <MultiSelectCell values={items.map(String)} className={className} />
    }

    case 'url':
      return urlAsLink ? (
        <UrlCell value={String(value)} className={className} />
      ) : (
        <TextCell value={String(value)} highlightQuery={highlightQuery} className={className} />
      )

    case 'rating': {
      const rating = typeof value === 'number' ? value : parseInt(String(value), 10) || 0
      return <RatingCell value={rating} className={className} />
    }

    case 'text':
    default:
      return (
        <TextCell value={String(value)} highlightQuery={highlightQuery} className={className} />
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

  useEffect(() => {
    if (!onSave && isEditing) {
      setIsEditing(false)
    }
  }, [onSave, isEditing])

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
          ? value.map(String).join(', ')
          : String(value)
    const numberValue =
      typeof value === 'number'
        ? value
        : (() => {
            const parsed = parseFloat(String(value))
            return Number.isFinite(parsed) ? parsed : null
          })()
    const dateValue = (() => {
      if (!value) return null
      const parsed = new Date(String(value))
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
      className={cn('w-full text-left focus:outline-none cursor-text')}
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
 * T042: Number cell - left-aligned (consistent with other cells), formatted with tabular nums
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
  return (
    <span className={cn('text-muted-foreground whitespace-nowrap', className)} title={value}>
      {formatDate(value)}
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
        'group flex items-center gap-2 text-left hover:text-primary transition-colors truncate w-full',
        'focus:outline-none focus:text-primary cursor-pointer',
        className
      )}
      title={title}
    >
      {emoji ? (
        <NoteIconDisplay value={emoji} className="flex-shrink-0 text-base" />
      ) : (
        <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      )}
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
        'flex items-center gap-1.5 text-left text-muted-foreground hover:text-foreground transition-colors truncate',
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
 * T051: Tags cell - multiple colored tag badges
 */
export const TagsCell = memo(function TagsCell({
  tags,
  onTagClick,
  onTagRemove,
  highlightQuery,
  className
}: TagsCellProps): React.JSX.Element {
  if (!tags || tags.length === 0) {
    return <span className="text-muted-foreground/50">—</span>
  }

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {tags.map((tag) => {
        const shouldHighlight =
          highlightQuery && tag.toLowerCase().includes(highlightQuery.toLowerCase())
        return (
          <span
            key={tag}
            className={cn(
              'inline-flex items-center rounded text-xs font-medium',
              'transition-opacity hover:opacity-80',
              getTagColor(tag)
            )}
            title={tag}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onTagClick?.(tag)
              }}
              className={cn('px-1.5 py-0.5', 'focus:outline-none rounded')}
            >
              #{shouldHighlight ? highlightText(tag, highlightQuery) : tag}
            </button>
            {onTagRemove && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onTagRemove(tag)
                }}
                aria-label={`Remove tag ${tag}`}
                className={cn(
                  'pr-1.5 pl-0.5 py-0.5',
                  'opacity-70 hover:opacity-100',
                  'focus:outline-none rounded'
                )}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        )
      })}
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
