import { useState, useCallback, useEffect } from 'react'
import { Trash2 } from 'lucide-react'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { Property, PROPERTY_TYPE_CONFIG } from './types'
import {
  TextEditor,
  NumberEditor,
  CheckboxEditor,
  RatingEditor,
  DateEditor,
  UrlEditor,
  LongTextEditor
} from './editors'

interface PropertyRowProps {
  property: Property
  onValueChange: (value: unknown) => void
  onDelete?: () => void
  disabled?: boolean
  autoFocus?: boolean
}

export function PropertyRow({
  property,
  onValueChange,
  onDelete,
  disabled,
  autoFocus = false
}: PropertyRowProps) {
  const [isEditing, setIsEditing] = useState(
    autoFocus && property.type !== 'checkbox' && property.type !== 'rating'
  )
  const [isHovered, setIsHovered] = useState(false)

  const config = PROPERTY_TYPE_CONFIG[property.type]
  const IconComponent = config.icon

  // Handle autoFocus - start editing when mounted with autoFocus
  useEffect(() => {
    if (autoFocus && property.type !== 'checkbox' && property.type !== 'rating') {
      setIsEditing(true)
    }
  }, [autoFocus, property.type])

  const handleStartEdit = useCallback(() => {
    if (!disabled && property.type !== 'checkbox' && property.type !== 'rating') {
      setIsEditing(true)
    }
  }, [disabled, property.type])

  const handleEndEdit = useCallback(() => {
    setIsEditing(false)
  }, [])

  const renderValue = () => {
    // Checkbox and rating are always interactive (no edit mode)
    if (property.type === 'checkbox') {
      return <CheckboxEditor value={Boolean(property.value)} onChange={onValueChange} />
    }

    if (property.type === 'rating') {
      return <RatingEditor value={Number(property.value) || 0} onChange={onValueChange} />
    }

    // Other types show display value or editor
    if (isEditing) {
      return renderEditor()
    }

    return renderDisplayValue()
  }

  const renderDisplayValue = () => {
    const value = property.value

    // Empty state
    if (value === null || value === undefined || value === '') {
      return <span className="text-[13px] text-muted-foreground/50">Empty</span>
    }

    switch (property.type) {
      case 'date':
        return (
          <span className="text-[13px] text-foreground">
            {format(new Date(value as string | number | Date), 'dd.MM.yyyy')}
          </span>
        )

      case 'url':
        return (
          <span className="text-[13px] text-blue-600 truncate max-w-[200px] hover:underline hover:text-blue-700">
            {String(value)}
          </span>
        )

      default:
        return <span className="text-[13px] text-foreground">{String(value)}</span>
    }
  }

  const renderEditor = () => {
    switch (property.type) {
      case 'text':
        return (
          <TextEditor
            value={String(property.value ?? '')}
            onChange={onValueChange}
            onBlur={handleEndEdit}
          />
        )

      case 'longText':
        return (
          <LongTextEditor
            value={String(property.value ?? '')}
            onChange={onValueChange}
            onBlur={handleEndEdit}
          />
        )

      case 'number':
        return (
          <NumberEditor
            value={property.value as number | null}
            onChange={onValueChange}
            onBlur={handleEndEdit}
          />
        )

      case 'date':
        return (
          <DateEditor
            value={property.value ? new Date(property.value as string | number | Date) : null}
            onChange={(date) => onValueChange(date?.toISOString() ?? null)}
            onBlur={handleEndEdit}
          />
        )

      case 'url':
        return (
          <UrlEditor
            value={String(property.value ?? '')}
            onChange={onValueChange}
            onBlur={handleEndEdit}
          />
        )

      default:
        return (
          <TextEditor
            value={String(property.value ?? '')}
            onChange={onValueChange}
            onBlur={handleEndEdit}
          />
        )
    }
  }

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn('flex items-start py-1', 'transition-colors duration-150')}
    >
      {/* Icon */}
      <span className="mr-2 mt-0.5 flex-shrink-0 text-muted-foreground/40">
        <IconComponent className="h-3.5 w-3.5" />
      </span>

      {/* Label */}
      <span
        className={cn('w-24 flex-shrink-0', 'text-[13px] text-muted-foreground/60', 'truncate')}
        title={property.name}
      >
        {property.name}
      </span>

      {/* Value */}
      <div
        onClick={handleStartEdit}
        className={cn(
          'flex-1 min-w-0 transition-colors rounded px-1 -mx-1',
          !isEditing &&
            property.type !== 'checkbox' &&
            property.type !== 'rating' &&
            'cursor-pointer hover:bg-muted/10'
        )}
      >
        {renderValue()}
      </div>

      {/* Delete button (only for custom properties) */}
      {property.isCustom && onDelete && isHovered && !isEditing && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete property: ${property.name}`}
          className={cn(
            'ml-2 flex h-6 w-6 items-center justify-center',
            'rounded text-muted-foreground/50',
            'transition-colors duration-150',
            'hover:bg-destructive/10 hover:text-destructive'
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
