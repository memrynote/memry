import { useState, useCallback, useRef, useMemo } from 'react'
import { isValid } from 'date-fns'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GripVertical,
  Trash2,
  Calendar,
  Type,
  Hash,
  CheckSquare,
  List,
  Tags,
  Link,
  Link2,
  Star,
  FolderKanban,
  type AppIcon
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Property } from './types'
import {
  TextEditor,
  NumberEditor,
  CheckboxEditor,
  DateEditor,
  UrlEditor,
  SelectEditor,
  MultiselectEditor,
  StatusEditor,
  RelationEditor,
  ProjectEditor
} from './editors'
import { usePropertyDefinitions } from '@/hooks/use-property-definitions'
import { stringifyUnknown } from '@/lib/stringify-unknown'
import {
  DEFAULT_STATUS_DEFINITION,
  type SelectOption,
  type StatusCategories,
  type StatusCategoryKey
} from '@memry/contracts/property-types'
import { useT } from '@memry/i18n/renderer'
import { useCalendarProperties } from '@/hooks/use-calendar-properties'
import { getEventBaseColor } from '@/lib/event-type-colors'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const PROPERTY_TYPE_ICONS: Record<string, AppIcon> = {
  text: Type,
  number: Hash,
  checkbox: CheckSquare,
  date: Calendar,
  select: List,
  multiselect: Tags,
  status: List,
  url: Link,
  rating: Star,
  relation: Link2,
  project: FolderKanban
}

interface PropertyValueRendererProps {
  property: Property
  isEditing: boolean
  autoOpen?: boolean
  onValueChange: (value: unknown) => void
  onEndEdit: () => void
}

function PropertyValueDisplay({ property }: { property: Property }) {
  const { t } = useT('notes')
  const value = property.value

  if (value === null || value === undefined || value === '') {
    return <span className="text-[13px] text-text-tertiary font-sans">{t('properties.empty')}</span>
  }

  switch (property.type) {
    case 'url':
      return (
        <span className="text-[13px] text-tint font-sans leading-4 truncate max-w-[200px] hover:underline">
          {stringifyUnknown(value)}
        </span>
      )

    default:
      return (
        <span className="text-[13px] text-foreground font-sans leading-4">
          {stringifyUnknown(value)}
        </span>
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
          value={stringifyUnknown(property.value)}
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

    case 'url':
      return (
        <UrlEditor
          value={stringifyUnknown(property.value)}
          onChange={onValueChange}
          onBlur={onEndEdit}
        />
      )

    default:
      return (
        <TextEditor
          value={stringifyUnknown(property.value)}
          onChange={onValueChange}
          onBlur={onEndEdit}
        />
      )
  }
}

const SELECT_TYPES = new Set(['select', 'multiselect', 'status'])

// Types that manage their own popup/toggle and never use the inline text-edit
// (isEditing) path — so their type icon must not show the editing tint.
const isAlwaysInteractiveType = (type: string): boolean =>
  type === 'checkbox' ||
  type === 'date' ||
  type === 'relation' ||
  type === 'project' ||
  SELECT_TYPES.has(type)

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
        onAddOption={(...args) => void handleAddStatusOption(...args)}
        onRemoveOption={(...args) => void handleRemoveOption(...args)}
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
        onAddOption={(...args) => void handleAddOption(...args)}
        onRemoveOption={(...args) => void handleRemoveOption(...args)}
      />
    )
  }

  return (
    <SelectEditor
      value={(property.value as string) ?? null}
      options={options}
      defaultOpen={autoOpen}
      onChange={onValueChange}
      onAddOption={(...args) => void handleAddOption(...args)}
      onRemoveOption={(...args) => void handleRemoveOption(...args)}
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

  if (property.type === 'project') {
    const names = Array.isArray(property.value) ? (property.value as string[]) : []
    return <ProjectEditor value={names} defaultOpen={autoOpen} onChange={onValueChange} />
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

  if (property.type === 'relation') {
    const val = Array.isArray(property.value) ? (property.value as string[]) : []
    return <RelationEditor value={val} onChange={onValueChange} />
  }

  if (property.type === 'date') {
    // An unparseable stored value yields an Invalid Date (still truthy); pass null
    // so the editor and calendar never receive one and read it as empty.
    const rawDate = property.value ? new Date(property.value as string | number | Date) : null
    const dateValue = rawDate && isValid(rawDate) ? rawDate : null
    return (
      <DateEditor
        value={dateValue}
        onChange={(date) => onValueChange(date?.toISOString() ?? null)}
        defaultOpen={autoOpen}
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
  const { t } = useT('notes')
  const { isEnabled, setEnabled } = useCalendarProperties()
  const [isEditing, setIsEditing] = useState(autoFocus && !isAlwaysInteractiveType(property.type))
  const [isEditingName, setIsEditingName] = useState(false)
  const [editedName, setEditedName] = useState(property.name)
  const [isHovered, setIsHovered] = useState(false)
  const [isNameHovered, setIsNameHovered] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // The reserved `project` key is what the reconciler reads; renaming it would
  // silently unlink the note.
  const canRenameName = property.type !== 'project' ? onNameChange : undefined

  const isDragEnabled = isSortable && !disabled

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: property.id,
    disabled: !isDragEnabled
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || 'transform 150ms ease'
  }

  const showDragHandle =
    isDragEnabled && !isEditingName && !isEditing && (isNameHovered || isDragging)
  const isAlwaysInteractive = isAlwaysInteractiveType(property.type)
  const PropertyTypeIcon = PROPERTY_TYPE_ICONS[property.type] ?? Type

  // Handle autoFocus - start editing when mounted with autoFocus. Computed
  // during render so the React linter can verify state isn't redundantly
  // derived from a prop inside an effect.
  const [autoFocusHandled, setAutoFocusHandled] = useState(false)
  if (autoFocus && !isAlwaysInteractive && !autoFocusHandled) {
    setAutoFocusHandled(true)
    setIsEditing(true)
  }

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
    if (!disabled && canRenameName) {
      setEditedName(property.name)
      setIsEditingName(true)
      requestAnimationFrame(() => {
        nameInputRef.current?.focus()
        nameInputRef.current?.select()
      })
    }
  }, [disabled, canRenameName, property.name])

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
        'flex items-center py-1.5',
        'transition-colors duration-150',
        isDragging && 'opacity-60 bg-muted/20 rounded'
      )}
    >
      <div
        className={cn(
          'flex items-center rounded -ms-1 me-2 ps-1 pe-1 py-0.5 -my-0.5 transition-colors',
          isDragEnabled && !isEditingName && 'hover:bg-surface'
        )}
        onMouseEnter={() => setIsNameHovered(true)}
        onMouseLeave={() => setIsNameHovered(false)}
      >
        {/* Leading slot — property type icon at rest, crossfades to drag handle on hover */}
        <div className="relative flex h-4 w-5 shrink-0 items-center">
          <PropertyTypeIcon
            aria-hidden
            className={cn(
              'absolute start-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-opacity duration-150',
              showDragHandle ? 'opacity-0' : 'opacity-100',
              isEditing || isEditingName ? 'text-tint' : 'text-text-tertiary'
            )}
          />
          {isDragEnabled && (
            <button
              type="button"
              {...attributes}
              {...listeners}
              data-drag-handle
              aria-label={`${t('properties.dragAria')}: ${property.name}`}
              className={cn(
                'absolute start-0 top-1/2 flex h-4 -translate-y-1/2 items-center justify-center',
                'cursor-grab text-text-tertiary transition-opacity duration-150',
                'hover:text-muted-foreground active:cursor-grabbing touch-none',
                showDragHandle ? 'opacity-100' : 'pointer-events-none opacity-0'
              )}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
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
              'w-28 shrink-0',
              'text-[13px] text-muted-foreground font-sans',
              'bg-transparent border-b border-border',
              'focus:outline-none focus:border-muted-foreground',
              'px-0 py-0'
            )}
            aria-label={t('properties.editName')}
          />
        ) : (
          <span
            onClick={canRenameName ? handleStartNameEdit : undefined}
            className={cn(
              'w-28 shrink-0',
              'text-[13px] text-text-tertiary font-sans leading-4',
              'truncate',
              canRenameName && !disabled && 'cursor-pointer hover:text-text-secondary'
            )}
            title={property.name}
            role={canRenameName ? 'button' : undefined}
            tabIndex={canRenameName && !disabled ? 0 : undefined}
            onKeyDown={
              canRenameName && !disabled
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

      {/* Calendar toggle — date properties only. One click toggles; the icon
          stays visible and tinted (chip color) while enabled so the state is
          readable without opening anything. The tooltip names the action. */}
      {property.type === 'date' && (
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('properties.showOnCalendar')}
                aria-pressed={isEnabled(property.name)}
                onClick={() => void setEnabled(property.name, !isEnabled(property.name))}
                style={isEnabled(property.name) ? { color: getEventBaseColor('note') } : undefined}
                className={cn(
                  'ms-1 flex h-6 w-6 items-center justify-center rounded transition-all duration-150 hover:bg-surface',
                  isEnabled(property.name)
                    ? 'opacity-100'
                    : isHovered
                      ? 'opacity-100 text-text-tertiary hover:text-muted-foreground'
                      : 'opacity-0 pointer-events-none'
                )}
              >
                <Calendar className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {isEnabled(property.name)
                ? t('properties.showingOnCalendar')
                : t('properties.showOnCalendar')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Delete button */}
      {property.isCustom && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`${t('properties.delete')}: ${property.name}`}
          className={cn(
            'ms-2 flex h-6 w-6 items-center justify-center',
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
