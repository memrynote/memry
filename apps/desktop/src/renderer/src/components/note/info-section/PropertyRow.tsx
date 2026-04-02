import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Trash2 } from '@/lib/icons'
import { format } from 'date-fns'
import { cn } from '@/lib/utils'
import { Property, PROPERTY_TYPE_CONFIG } from './types'
import {
  TextEditor,
  NumberEditor,
  CheckboxEditor,
  DateEditor,
  UrlEditor,
  SelectEditor,
  MultiselectEditor,
  StatusEditor
} from './editors'
import { usePropertyDefinitions } from '@/hooks/use-property-definitions'
import {
  DEFAULT_STATUS_DEFINITION,
  type SelectOption,
  type StatusCategories,
  type StatusCategoryKey
} from '@memry/contracts/property-types'

interface PropertyValueRendererProps {
  property: Property
  isEditing: boolean
  autoOpen?: boolean
  onValueChange: (value: unknown) => void
  onEndEdit: () => void
}

function PropertyValueDisplay({ property }: { property: Property }) {
  const value = property.value

  if (value === null || value === undefined || value === '') {
    return <span className="text-[13px] text-text-tertiary font-sans">Empty</span>
  }

  switch (property.type) {
    case 'date':
      return (
        <span className="text-[13px] text-foreground font-sans leading-4">
          {format(new Date(value as string | number | Date), 'dd.MM.yyyy')}
        </span>
      )

    case 'url':
      return (
        <span className="text-[13px] text-tint font-sans leading-4 truncate max-w-[200px] hover:underline">
          {String(value)}
        </span>
      )

    default:
      return (
        <span className="text-[13px] text-foreground font-sans leading-4">{String(value)}</span>
      )
  }
}

function PropertyValueEditor({
  property,
  onValueChange,
  onEndEdit
}: {
  property: Property
  onValueChange: (value: unknown) => void
  onEndEdit: () => void
}) {
  switch (property.type) {
    case 'text':
      return (
        <TextEditor
          value={String(property.value ?? '')}
          onChange={onValueChange}
          onBlur={onEndEdit}
        />
      )

    case 'number':
      return (
        <NumberEditor
          value={property.value as number | null}
          onChange={onValueChange}
          onBlur={onEndEdit}
        />
      )

    case 'date':
      return (
        <DateEditor
          value={property.value ? new Date(property.value as string | number | Date) : null}
          onChange={(date) => onValueChange(date?.toISOString() ?? null)}
          onBlur={onEndEdit}
        />
      )

    case 'url':
      return (
        <UrlEditor
          value={String(property.value ?? '')}
          onChange={onValueChange}
          onBlur={onEndEdit}
        />
      )

    default:
      return (
        <TextEditor
          value={String(property.value ?? '')}
          onChange={onValueChange}
          onBlur={onEndEdit}
        />
      )
  }
}

const SELECT_TYPES = new Set(['select', 'multiselect', 'status'])

function SelectPropertyRenderer({
  property,
  autoOpen,
  onValueChange
}: {
  property: Property
  autoOpen?: boolean
  onValueChange: (value: unknown) => void
}) {
  const { getDefinition, refresh } = usePropertyDefinitions()
  const definition = getDefinition(property.name)

  const options: SelectOption[] = useMemo(() => {
    if (!definition?.options) return []
    try {
      const parsed = JSON.parse(definition.options)
      if (Array.isArray(parsed)) return parsed
      return []
    } catch {
      return []
    }
  }, [definition?.options])

  const categories: StatusCategories | undefined = useMemo(() => {
    if (property.type !== 'status') return undefined
    if (!definition?.options) return DEFAULT_STATUS_DEFINITION.categories
    try {
      const parsed = JSON.parse(definition.options)
      if (parsed?.categories) return parsed.categories as StatusCategories
      return DEFAULT_STATUS_DEFINITION.categories
    } catch {
      return DEFAULT_STATUS_DEFINITION.categories
    }
  }, [property.type, definition?.options])

  const handleAddOption = useCallback(
    async (option: SelectOption) => {
      const { notesService } = await import('@/services/notes-service')
      await notesService.addPropertyOption(property.name, option)
      await refresh()
    },
    [property.name, refresh]
  )

  const handleAddStatusOption = useCallback(
    async (categoryKey: StatusCategoryKey, option: SelectOption) => {
      const { notesService } = await import('@/services/notes-service')
      await notesService.addStatusOption(property.name, categoryKey, option)
      await refresh()
    },
    [property.name, refresh]
  )

  const handleRemoveOption = useCallback(
    async (optionValue: string) => {
      const { notesService } = await import('@/services/notes-service')
      await notesService.removePropertyOption(property.name, optionValue)
      await refresh()
    },
    [property.name, refresh]
  )

  if (property.type === 'status' && categories) {
    return (
      <StatusEditor
        value={(property.value as string) ?? null}
        categories={categories}
        defaultOpen={autoOpen}
        onChange={onValueChange}
        onAddOption={handleAddStatusOption}
        onRemoveOption={handleRemoveOption}
      />
    )
  }

  if (property.type === 'multiselect') {
    const val = Array.isArray(property.value) ? (property.value as string[]) : []
    return (
      <MultiselectEditor
        value={val}
        options={options}
        defaultOpen={autoOpen}
        onChange={onValueChange}
        onAddOption={handleAddOption}
        onRemoveOption={handleRemoveOption}
      />
    )
  }

  return (
    <SelectEditor
      value={(property.value as string) ?? null}
      options={options}
      defaultOpen={autoOpen}
      onChange={onValueChange}
      onAddOption={handleAddOption}
      onRemoveOption={handleRemoveOption}
    />
  )
}

function PropertyValueRenderer({
  property,
  isEditing,
  autoOpen,
  onValueChange,
  onEndEdit
}: PropertyValueRendererProps) {
  if (property.type === 'checkbox') {
    return <CheckboxEditor value={Boolean(property.value)} onChange={onValueChange} />
  }

  if (SELECT_TYPES.has(property.type)) {
    return (
      <SelectPropertyRenderer
        property={property}
        autoOpen={autoOpen}
        onValueChange={onValueChange}
      />
    )
  }

  if (isEditing) {
    return (
      <PropertyValueEditor
        property={property}
        onValueChange={onValueChange}
        onEndEdit={onEndEdit}
      />
    )
  }

  return <PropertyValueDisplay property={property} />
}

interface PropertyRowProps {
  property: Property
  onValueChange: (value: unknown) => void
  onNameChange?: (newName: string) => void
  onDelete?: () => void
  disabled?: boolean
  autoFocus?: boolean
  isSortable?: boolean
}

export function PropertyRow({
  property,
  onValueChange,
  onNameChange,
  onDelete,
  disabled,
  autoFocus = false,
  isSortable = false
}: PropertyRowProps) {
  const [isEditing, setIsEditing] = useState(
    autoFocus && property.type !== 'checkbox' && !SELECT_TYPES.has(property.type)
  )
  const [isEditingName, setIsEditingName] = useState(false)
  const [editedName, setEditedName] = useState(property.name)
  const [isHovered, setIsHovered] = useState(false)
  const [isNameHovered, setIsNameHovered] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const config = PROPERTY_TYPE_CONFIG[property.type]
  const IconComponent = config.icon
  const isDragEnabled = isSortable && !disabled

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: property.id,
    disabled: !isDragEnabled
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 150ms ease'
  }

  const showDragHandle = isDragEnabled && !isEditingName && (isNameHovered || isDragging)
  const isAlwaysInteractive = property.type === 'checkbox' || SELECT_TYPES.has(property.type)

  // Handle autoFocus - start editing when mounted with autoFocus
  useEffect(() => {
    if (autoFocus && !isAlwaysInteractive) {
      setIsEditing(true)
    }
  }, [autoFocus, isAlwaysInteractive])

  const handleStartEdit = useCallback(() => {
    if (!disabled && !isAlwaysInteractive) {
      setIsEditing(true)
    }
  }, [disabled, isAlwaysInteractive])

  const handleEndEdit = useCallback(() => {
    setIsEditing(false)
  }, [])

  // Name editing handlers
  const handleStartNameEdit = useCallback(() => {
    if (!disabled && onNameChange) {
      setEditedName(property.name)
      setIsEditingName(true)
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'flex items-center py-[0px]',
        'transition-colors duration-150',
        isDragging && 'opacity-60 bg-muted/20 rounded'
      )}
    >
      <div
        className="flex items-center"
        onMouseEnter={() => setIsNameHovered(true)}
        onMouseLeave={() => setIsNameHovered(false)}
      >
        {/* Icon / Drag Handle — fixed w-5 slot */}
        <div className="flex items-center w-5 shrink-0">
          {showDragHandle ? (
            <button
              type="button"
              {...attributes}
              {...listeners}
              data-drag-handle
              aria-label={`Drag to reorder property: ${property.name}`}
              className={cn(
                'flex items-center justify-center',
                'cursor-grab text-text-tertiary',
                'hover:text-muted-foreground',
                'active:cursor-grabbing',
                'touch-none'
              )}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
          ) : (
            <IconComponent className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
          )}
        </div>

        {/* Label — fixed w-24 slot */}
        {isEditingName ? (
          <input
            ref={nameInputRef}
            type="text"
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            onBlur={handleEndNameEdit}
            onKeyDown={handleNameKeyDown}
            className={cn(
              'w-24 shrink-0',
              'text-[13px] text-muted-foreground font-sans',
              'bg-transparent border-b border-border',
              'focus:outline-none focus:border-muted-foreground',
              'px-0 py-0'
            )}
            aria-label="Edit property name"
          />
        ) : (
          <span
            onClick={onNameChange ? handleStartNameEdit : undefined}
            className={cn(
              'w-24 shrink-0',
              'text-[13px] text-muted-foreground font-sans leading-4',
              'truncate',
              onNameChange && !disabled && 'cursor-pointer hover:text-text-secondary'
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
      </div>

      {/* Value */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleStartEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleStartEdit()
          }
        }}
        className={cn(
          'flex-1 min-w-0 transition-colors rounded px-1 -mx-1',
          !isEditing && !isAlwaysInteractive && 'cursor-pointer hover:bg-surface'
        )}
      >
        <PropertyValueRenderer
          property={property}
          isEditing={isEditing}
          autoOpen={autoFocus && isAlwaysInteractive}
          onValueChange={onValueChange}
          onEndEdit={handleEndEdit}
        />
      </div>

      {/* Delete button */}
      {property.isCustom && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete property: ${property.name}`}
          className={cn(
            'ml-2 flex h-6 w-6 items-center justify-center',
            'rounded text-text-tertiary',
            'transition-all duration-150',
            'hover:bg-destructive/10 hover:text-destructive',
            isHovered && !isEditing ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
