import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  arrayMove
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { Plus, ChevronDown, ChevronUp } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Property, PropertyTemplate, NewProperty } from './types'
import { InfoHeader } from './InfoHeader'
import { PropertyRow } from './PropertyRow'
import { AddPropertyPopup } from './AddPropertyPopup'

export interface InfoSectionProps {
  properties: Property[]
  folderProperties?: PropertyTemplate[]
  isExpanded: boolean
  onToggleExpand: () => void
  onPropertyChange: (propertyId: string, value: unknown) => void
  onPropertyNameChange?: (propertyId: string, newName: string) => void
  onPropertyOrderChange?: (newOrder: string[]) => void
  onAddProperty: (property: NewProperty) => void
  onDeleteProperty: (propertyId: string) => void
  disabled?: boolean
  initialVisibleCount?: number
  variant?: 'default' | 'embedded' | 'inline'
  hideAddButton?: boolean
}

export const InfoSection = memo(function InfoSection({
  properties,
  folderProperties,
  isExpanded,
  onToggleExpand,
  onPropertyChange,
  onPropertyNameChange,
  onPropertyOrderChange,
  onAddProperty,
  onDeleteProperty,
  disabled = false,
  initialVisibleCount = 4,
  variant = 'default',
  hideAddButton = false
}: InfoSectionProps) {
  const [showAllProperties, setShowAllProperties] = useState(false)
  const [newlyAddedPropertyId, setNewlyAddedPropertyId] = useState<string | null>(null)
  const isSortable = Boolean(onPropertyOrderChange) && !disabled && properties.length > 1

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  // Split properties into visible and hidden (keep insertion order)
  const { visibleProperties, hiddenProperties } = useMemo(() => {
    if (showAllProperties) {
      return { visibleProperties: properties, hiddenProperties: [] }
    }

    // Keep insertion order - no sorting
    const visible = properties.slice(0, initialVisibleCount)
    const hidden = properties.slice(initialVisibleCount)

    return { visibleProperties: visible, hiddenProperties: hidden }
  }, [properties, showAllProperties, initialVisibleCount])

  const handlePropertyChange = useCallback(
    (propertyId: string) => (value: unknown) => {
      onPropertyChange(propertyId, value)
    },
    [onPropertyChange]
  )

  const handlePropertyNameChange = useCallback(
    (propertyId: string) => (newName: string) => {
      onPropertyNameChange?.(propertyId, newName)
    },
    [onPropertyNameChange]
  )

  const handleDeleteProperty = useCallback(
    (propertyId: string) => () => {
      onDeleteProperty(propertyId)
    },
    [onDeleteProperty]
  )

  const toggleShowMore = useCallback(() => {
    setShowAllProperties((prev) => !prev)
  }, [])

  // Track the previous properties length to detect new additions
  const prevPropertiesLength = useRef(properties.length)

  // Detect when a new property is added and set it for auto-focus
  useEffect(() => {
    if (properties.length > prevPropertiesLength.current) {
      // A new property was added - it should be the last one
      const newProperty = properties[properties.length - 1]
      if (newProperty) {
        setNewlyAddedPropertyId(newProperty.id)
        setShowAllProperties(true)
        // Clear after a short delay
        setTimeout(() => setNewlyAddedPropertyId(null), 100)
      }
    }
    prevPropertiesLength.current = properties.length
  }, [properties])

  const handleAddProperty = useCallback(
    (newProp: NewProperty) => {
      onAddProperty(newProp)
    },
    [onAddProperty]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!onPropertyOrderChange) return

      const { active, over } = event
      if (!over || active.id === over.id) return

      const oldIndex = properties.findIndex((property) => property.id === active.id)
      const newIndex = properties.findIndex((property) => property.id === over.id)

      if (oldIndex === -1 || newIndex === -1) return

      const newOrder = arrayMove(
        properties.map((property) => property.id),
        oldIndex,
        newIndex
      )

      onPropertyOrderChange(newOrder)
    },
    [onPropertyOrderChange, properties]
  )

  const sortableIds = useMemo(
    () => visibleProperties.map((property) => property.id),
    [visibleProperties]
  )

  const isInline = variant === 'inline'
  const effectiveExpanded = isInline || isExpanded
  const showAddBtn = !hideAddButton && !isInline

  return (
    <div
      className={cn('flex flex-col', variant === 'default' && 'border-t border-b border-border')}
      role="region"
      aria-label="Note properties"
    >
      {/* Toggle Header — hidden in inline mode */}
      {!isInline && (
        <InfoHeader
          isExpanded={isExpanded}
          onToggle={onToggleExpand}
          variant={variant as 'default' | 'embedded'}
          propertyCount={properties.length}
        />
      )}

      {/* Collapsible Content */}
      {effectiveExpanded && (
        <div id="properties-content">
          {/* Section Header */}
          {folderProperties && folderProperties.length > 0 && (
            <div className="mb-3 flex items-center gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                Workspace properties
              </span>
            </div>
          )}

          {/* Properties List */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <div role="list" aria-label="Properties list">
                {visibleProperties.map((property) => (
                  <PropertyRow
                    key={property.id}
                    property={property}
                    onValueChange={handlePropertyChange(property.id)}
                    onNameChange={
                      onPropertyNameChange ? handlePropertyNameChange(property.id) : undefined
                    }
                    onDelete={property.isCustom ? handleDeleteProperty(property.id) : undefined}
                    disabled={disabled}
                    autoFocus={property.id === newlyAddedPropertyId}
                    isSortable={isSortable}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {/* Show More Toggle */}
          {hiddenProperties.length > 0 && (
            <button
              type="button"
              onClick={toggleShowMore}
              className={cn(
                'mt-2 flex items-center gap-1',
                'text-xs text-text-tertiary',
                'transition-colors duration-150',
                'hover:text-muted-foreground'
              )}
              aria-label={`Show ${hiddenProperties.length} more properties`}
            >
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
              {hiddenProperties.length} more properties
            </button>
          )}

          {showAllProperties && properties.length > initialVisibleCount && (
            <button
              type="button"
              onClick={toggleShowMore}
              className={cn(
                'mt-2 flex items-center gap-1',
                'text-xs text-text-tertiary',
                'transition-colors duration-150',
                'hover:text-muted-foreground'
              )}
              aria-label="Show fewer properties"
            >
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
              Show less
            </button>
          )}

          {showAddBtn && (
            <div className="pt-2 pb-2.5">
              <AddPropertyPopup onAdd={handleAddProperty} disabled={disabled}>
                <button
                  type="button"
                  disabled={disabled}
                  className={cn(
                    'flex items-center gap-1.5',
                    'text-[12px] text-text-tertiary font-sans',
                    'transition-colors duration-150',
                    'hover:text-muted-foreground',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                  aria-label="Add a new property to this note"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  Add property
                </button>
              </AddPropertyPopup>
            </div>
          )}
        </div>
      )}
    </div>
  )
})
