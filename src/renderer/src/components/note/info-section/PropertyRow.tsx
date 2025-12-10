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
  SelectEditor,
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
  const [isEditing, setIsEditing] = useState(autoFocus && property.type !== 'checkbox' && property.type !== 'rating')
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
      return (
        <CheckboxEditor
          value={Boolean(property.value)}
          onChange={onValueChange}
        />
      )
    }

    if (property.type === 'rating') {
      return (
        <RatingEditor
          value={Number(property.value) || 0}
          onChange={onValueChange}
        />
      )
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
      return (
        <span className="text-[13px] text-stone-400">Empty</span>
      )
    }

    switch (property.type) {
      case 'date':
        return (
          <span className="text-[13px] text-stone-900">
            {format(new Date(value as string | number | Date), 'MMM d, yyyy')}
          </span>
        )

      case 'url':
        return (
          <span className="text-[13px] text-blue-600 truncate max-w-[200px]">
            {String(value)}
          </span>
        )

      case 'multiSelect':
        const items = Array.isArray(value) ? value : []
        if (items.length === 0) {
          return <span className="text-[13px] text-stone-400">Empty</span>
        }
        return (
          <div className="flex flex-wrap gap-1">
            {items.map((item, index) => (
              <span
                key={index}
                className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700"
              >
                {item}
              </span>
            ))}
          </div>
        )

      default:
        return (
          <span className="text-[13px] text-stone-900">
            {String(value)}
          </span>
        )
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

      case 'select':
        return (
          <SelectEditor
            value={property.value as string | null}
            options={property.options || []}
            onChange={onValueChange}
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
      className={cn(
        'flex items-start py-1.5',
        'border-b border-transparent',
        'transition-colors duration-150',
        isHovered && !isEditing && 'border-stone-200'
      )}
    >
      {/* Icon */}
      <span className="mr-2 flex-shrink-0 text-stone-400">
        <IconComponent className="h-4 w-4" />
      </span>

      {/* Label */}
      <span
        className={cn(
          'w-24 flex-shrink-0',
          'text-[13px] text-stone-500',
          'truncate'
        )}
        title={property.name}
      >
        {property.name}
      </span>

      {/* Value */}
      <div
        onClick={handleStartEdit}
        className={cn(
          'flex-1 min-w-0',
          !isEditing &&
          property.type !== 'checkbox' &&
          property.type !== 'rating' &&
          'cursor-pointer rounded px-1 -mx-1 hover:bg-stone-100'
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
            'rounded text-stone-400',
            'transition-colors duration-150',
            'hover:bg-red-50 hover:text-red-500'
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
