import { useState, useCallback, useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { Property, PROPERTY_TYPE_CONFIG } from './types'
import { TextEditor, NumberEditor, CheckboxEditor, DateEditor, UrlEditor } from './editors'

interface PropertyRowProps {
  property: Property
  onValueChange: (value: unknown) => void
  onNameChange?: (newName: string) => void
  onDelete?: () => void
  disabled?: boolean
  autoFocus?: boolean
}

export function PropertyRow({
  property,
  onValueChange,
  onNameChange,
  onDelete,
  disabled,
  autoFocus = false
}: PropertyRowProps) {
  const [isEditing, setIsEditing] = useState(autoFocus && property.type !== 'checkbox')
  const [isEditingName, setIsEditingName] = useState(false)
  const [editedName, setEditedName] = useState(property.name)
  const [isHovered, setIsHovered] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const config = PROPERTY_TYPE_CONFIG[property.type]
  const IconComponent = config.icon

  // Handle autoFocus - start editing when mounted with autoFocus
  useEffect(() => {
    if (autoFocus && property.type !== 'checkbox') {
      setIsEditing(true)
    }
  }, [autoFocus, property.type])

  const handleStartEdit = useCallback(() => {
    if (!disabled && property.type !== 'checkbox') {
      setIsEditing(true)
    }
  }, [disabled, property.type])

  const handleEndEdit = useCallback(() => {
    setIsEditing(false)
  }, [])

  // Name editing handlers
  const handleStartNameEdit = useCallback(() => {
    if (!disabled && onNameChange) {
      setEditedName(property.name)
      setIsEditingName(true)
    }
  }, [disabled, onNameChange, property.name])

  const handleEndNameEdit = useCallback(() => {
    const trimmedName = editedName.trim()
    if (trimmedName && trimmedName !== property.name && onNameChange) {
      onNameChange(trimmedName)
    }
    setIsEditingName(false)
  }, [editedName, property.name, onNameChange])

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleEndNameEdit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setEditedName(property.name)
        setIsEditingName(false)
      }
    },
    [handleEndNameEdit, property.name]
  )

  // Focus name input when editing starts
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus()
      nameInputRef.current.select()
    }
  }, [isEditingName])

  const renderValue = () => {
    // Checkbox is always interactive (no edit mode)
    if (property.type === 'checkbox') {
      return <CheckboxEditor value={Boolean(property.value)} onChange={onValueChange} />
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
      {isEditingName ? (
        <input
          ref={nameInputRef}
          type="text"
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          onBlur={handleEndNameEdit}
          onKeyDown={handleNameKeyDown}
          className={cn(
            'w-24 flex-shrink-0',
            'text-[13px] text-muted-foreground',
            'bg-transparent border-b border-muted-foreground/30',
            'focus:outline-none focus:border-muted-foreground/60',
            'px-0 py-0'
          )}
          aria-label="Edit property name"
        />
      ) : (
        <span
          onClick={onNameChange ? handleStartNameEdit : undefined}
          className={cn(
            'w-24 flex-shrink-0',
            'text-[13px] text-muted-foreground/60',
            'truncate',
            onNameChange && !disabled && 'cursor-pointer hover:text-muted-foreground'
          )}
          title={property.name}
          role={onNameChange ? 'button' : undefined}
          tabIndex={onNameChange && !disabled ? 0 : undefined}
          onKeyDown={
            onNameChange && !disabled
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleStartNameEdit()
                  }
                }
              : undefined
          }
        >
          {property.name}
        </span>
      )}

      {/* Value */}
      <div
        onClick={handleStartEdit}
        className={cn(
          'flex-1 min-w-0 transition-colors rounded px-1 -mx-1',
          !isEditing && property.type !== 'checkbox' && 'cursor-pointer hover:bg-muted/10'
        )}
      >
        {renderValue()}
      </div>

      {/* Delete button (only for custom properties) - always rendered to prevent layout shift */}
      {property.isCustom && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete property: ${property.name}`}
          className={cn(
            'ml-2 flex h-6 w-6 items-center justify-center',
            'rounded text-muted-foreground/50',
            'transition-all duration-150',
            'hover:bg-destructive/10 hover:text-destructive',
            isHovered && !isEditing
              ? 'opacity-100'
              : 'opacity-0 pointer-events-none'
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
