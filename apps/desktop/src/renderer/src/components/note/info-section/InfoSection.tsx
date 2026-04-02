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
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Property, PropertyTemplate, NewProperty } from './types'
import { InfoHeader } from './InfoHeader'
import { PropertyRow } from './PropertyRow'
import { AddPropertyPopup } from './AddPropertyPopup'

export interface InfoSectionProps {
  properties: Property[]
  folderProperties?: PropertyTemplate[]
  newlyAddedPropertyId?: string | null
  isExpanded: boolean
  onToggleExpand: () => void
  onPropertyChange: (propertyId: string, value: unknown) => void
  onPropertyNameChange?: (propertyId: string, newName: string) => void
  onPropertyOrderChange?: (newOrder: string[]) => void
  onAddProperty: (property: NewProperty) => void
  onDeleteProperty: (propertyId: string) => void
  disabled?: boolean
  variant?: 'default' | 'embedded' | 'inline'
  hideAddButton?: boolean
}

export const InfoSection = memo(function InfoSection({
  properties,
  folderProperties,
  newlyAddedPropertyId: externalNewlyAddedId,
  isExpanded,
  onToggleExpand,
  onPropertyChange,
  onPropertyNameChange,
  onPropertyOrderChange,
  onAddProperty,
  onDeleteProperty,
  disabled = false,
  variant = 'default',
  hideAddButton = false
}: InfoSectionProps) {
  const [internalNewlyAddedId, setInternalNewlyAddedId] = useState<string | null>(null)
  const newlyAddedPropertyId = externalNewlyAddedId ?? internalNewlyAddedId
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

  const sortableIds = useMemo(() => properties.map((property) => property.id), [properties])

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

  const prevPropertiesLength = useRef(properties.length)

  useEffect(() => {
    if (properties.length > prevPropertiesLength.current) {
      const newProperty = properties[properties.length - 1]
      if (newProperty) {
        setInternalNewlyAddedId(newProperty.id)
        setTimeout(() => setInternalNewlyAddedId(null), 500)
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
                {properties.map((property) => (
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
