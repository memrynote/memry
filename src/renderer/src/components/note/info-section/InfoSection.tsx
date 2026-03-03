import { useState, useCallback, useMemo, useRef, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
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
import { Plus, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Property, PropertyTemplate, NewProperty } from './types'
import { InfoHeader } from './InfoHeader'
import { PropertyRow } from './PropertyRow'
import { AddPropertyPopup } from './AddPropertyPopup'

/**
 * Generate a unique property name by adding incrementing suffix if needed.
 * E.g., "URL" → "URL", "URL 1", "URL 2", etc.
 */
function getUniquePropertyName(baseName: string, existingNames: string[]): string {
  if (!existingNames.includes(baseName)) return baseName
  let counter = 1
  while (existingNames.includes(`${baseName} ${counter}`)) {
    counter++
  }
  return `${baseName} ${counter}`
}

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
  variant?: 'default' | 'embedded'
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
  variant = 'default'
}: InfoSectionProps) {
  const [showAllProperties, setShowAllProperties] = useState(false)
  const [isAddPopupOpen, setIsAddPopupOpen] = useState(false)
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number } | null>(null)
  const [newlyAddedPropertyId, setNewlyAddedPropertyId] = useState<string | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
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

  const handleOpenAddPopup = useCallback(() => {
    if (addButtonRef.current) {
      const rect = addButtonRef.current.getBoundingClientRect()
      setPopupPosition({
        top: rect.bottom + 8,
        left: rect.left
      })
    }
    setIsAddPopupOpen(true)
  }, [])

  const handleCloseAddPopup = useCallback(() => {
    setIsAddPopupOpen(false)
    setPopupPosition(null)
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

  // Get list of existing property names for uniqueness check
  const existingPropertyNames = useMemo(() => properties.map((p) => p.name), [properties])

  // Handle adding new property with auto-increment for duplicate names
  const handleAddProperty = useCallback(
    (newProp: NewProperty) => {
      const uniqueName = getUniquePropertyName(newProp.name, existingPropertyNames)
      onAddProperty({ ...newProp, name: uniqueName })
    },
    [onAddProperty, existingPropertyNames]
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

  return (
    <div className={cn(variant === 'default' && 'mb-4')} role="region" aria-label="Note properties">
      {/* Toggle Header */}
      <InfoHeader
        isExpanded={isExpanded}
        onToggle={onToggleExpand}
        variant={variant}
        propertyCount={properties.length}
      />

      {/* Collapsible Content - Only rendered when expanded to prevent focus trap */}
      {isExpanded && (
        <div
          id="properties-content"
          className={cn(
            'mt-1 rounded-lg',
            'bg-transparent',
            variant === 'default' ? 'py-2 px-4' : 'py-0 px-0'
          )}
        >
          {/* Section Header */}
          {folderProperties && folderProperties.length > 0 && (
            <div className="mb-3 flex items-center gap-1">
              <span
                className={cn(
                  'text-[11px] font-semibold uppercase tracking-wide',
                  'text-stone-400'
                )}
              >
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
              <div className="space-y-0.5" role="list" aria-label="Properties list">
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
                'mt-3 flex items-center gap-1',
                'text-xs text-stone-500',
                'transition-colors duration-150',
                'hover:text-stone-700 hover:underline'
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
                'mt-3 flex items-center gap-1',
                'text-xs text-stone-500',
                'transition-colors duration-150',
                'hover:text-stone-700 hover:underline'
              )}
              aria-label="Show fewer properties"
            >
              <ChevronUp className="h-3 w-3" aria-hidden="true" />
              Show less
            </button>
          )}

          {/* Add Property Button */}
          <div className="mt-1 pt-1">
            <button
              ref={addButtonRef}
              type="button"
              onClick={handleOpenAddPopup}
              disabled={disabled}
              className={cn(
                'flex items-center gap-1.5',
                'text-[12px] text-stone-400',
                'transition-colors duration-150',
                'hover:text-stone-600',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              aria-label="Add a new property to this note"
              aria-haspopup="dialog"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              Add property
            </button>
          </div>
        </div>
      )}

      {/* Portal for AddPropertyPopup - renders at document body level */}
      {isAddPopupOpen &&
        popupPosition &&
        createPortal(
          <AddPropertyPopup
            isOpen={isAddPopupOpen}
            onClose={handleCloseAddPopup}
            onAdd={handleAddProperty}
            position={popupPosition}
            existingPropertyNames={existingPropertyNames}
          />,
          document.body
        )}
    </div>
  )
})
