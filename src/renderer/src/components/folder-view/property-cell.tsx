/**
 * Property Cell Component
 *
 * Renders property values in the folder table view.
 * Handles different property types (text, number, date, checkbox, etc.)
 */

import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PropertyCellProps {
  /** Property value */
  value: unknown
  /** Property type */
  type: 'text' | 'number' | 'checkbox' | 'date' | 'select' | 'multiselect' | 'url' | 'rating'
  /** Additional CSS classes */
  className?: string
}

/**
 * Format a date for display in the table.
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    if (isToday(date)) {
      return `Today, ${format(date, 'h:mm a')}`
    }
    if (isYesterday(date)) {
      return `Yesterday, ${format(date, 'h:mm a')}`
    }
    // Within last week, show relative
    const diffDays = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays < 7) {
      return formatDistanceToNow(date, { addSuffix: true })
    }
    // Otherwise show date
    return format(date, 'MMM d, yyyy')
  } catch {
    return String(dateStr)
  }
}

/**
 * Renders a property value based on its type.
 */
export function PropertyCell({ value, type, className }: PropertyCellProps): React.JSX.Element {
  if (value === null || value === undefined || value === '') {
    return <span className={cn('text-muted-foreground/50', className)}>—</span>
  }

  switch (type) {
    case 'checkbox':
      return value ? (
        <Check className={cn('h-4 w-4 text-green-500', className)} />
      ) : (
        <X className={cn('h-4 w-4 text-muted-foreground/50', className)} />
      )

    case 'number':
      return (
        <span className={cn('tabular-nums text-right', className)}>
          {typeof value === 'number' ? value.toLocaleString() : String(value)}
        </span>
      )

    case 'date':
      return (
        <span className={cn('text-muted-foreground', className)}>{formatDate(String(value))}</span>
      )

    case 'select':
      return (
        <span
          className={cn(
            'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
            'bg-primary/10 text-primary',
            className
          )}
        >
          {String(value)}
        </span>
      )

    case 'multiselect':
      const items = Array.isArray(value) ? value : String(value).split(',')
      return (
        <div className={cn('flex flex-wrap gap-1', className)}>
          {items.map((item, i) => (
            <span
              key={i}
              className="inline-flex px-1.5 py-0.5 rounded text-xs bg-muted text-muted-foreground"
            >
              {String(item).trim()}
            </span>
          ))}
        </div>
      )

    case 'url':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('text-primary hover:underline truncate', className)}
          onClick={(e) => e.stopPropagation()}
        >
          {String(value)}
        </a>
      )

    case 'rating':
      const rating = typeof value === 'number' ? value : parseInt(String(value), 10) || 0
      return (
        <span className={cn('text-amber-500', className)}>
          {'★'.repeat(Math.min(rating, 5))}
          {'☆'.repeat(Math.max(0, 5 - rating))}
        </span>
      )

    case 'text':
    default:
      return <span className={cn('truncate', className)}>{String(value)}</span>
  }
}

export default PropertyCell
