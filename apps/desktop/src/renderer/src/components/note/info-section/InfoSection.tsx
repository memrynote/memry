import { useState, useCallback, useMemo, useEffect, memo } from 'react'
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
import { Property, PropertyTemplate, NewProperty, PropertyType } from './types'
import { InfoHeader } from './InfoHeader'
import { PropertyRow } from './PropertyRow'
import { AddPropertyPopup } from './AddPropertyPopup'
import { useT } from '@memry/i18n/renderer'

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
  /** Types this surface cannot store, and so must not offer when adding. */
  excludeTypes?: PropertyType[]
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
  hideAddButton = false,
  excludeTypes
}: InfoSectionProps) {
  const { t } = useT('notes')
  const [internalNewlyAdded, setInternalNewlyAdded] = useState<{
    propertiesLength: number
    id: string | null
  }>({
    propertiesLength: properties.length,
    id: null
  })
  if (internalNewlyAdded.propertiesLength !== properties.length) {
    setInternalNewlyAdded({
      propertiesLength: properties.length,
      id:
        properties.length > internalNewlyAdded.propertiesLength
          ? (properties[properties.length - 1]?.id ?? null)
          : null
    })
  }
  const newlyAddedPropertyId = externalNewlyAddedId ?? internalNewlyAdded.id
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

  useEffect(() => {
    if (!internalNewlyAdded.id) return
    const clearHighlightTimer = window.setTimeout(() => {
      setInternalNewlyAdded((current) =>
        current.id === internalNewlyAdded.id ? { ...current, id: null } : current
      )
    }, 500)
    return () => window.clearTimeout(clearHighlightTimer)
  }, [internalNewlyAdded.id])

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
    <section className="flex flex-col" aria-label={t('properties.noteAria')}>
      {/* Toggle Header — hidden in inline mode */}
      {!isInline && (
        <InfoHeader
          isExpanded={isExpanded}
          onToggle={onToggleExpand}
          variant={variant}
          propertyCount={properties.length}
        />
      )}

      {/* Collapsible Content */}
      {effectiveExpanded && (
        <div
          id="properties-content"
          className={cn(variant === 'embedded' && 'mt-1.5 border-t border-border/60 pt-2.5')}
        >
          {/* Section Header */}
          {folderProperties && folderProperties.length > 0 && (
            <div className="mb-3 flex items-center gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                {t('properties.workspaceAria')}
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
              <ul aria-label={t('properties.listAria')}>
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
              </ul>
            </SortableContext>
          </DndContext>

          {showAddBtn && (
            <div className="pt-2 pb-2.5">
              <AddPropertyPopup
                onAdd={handleAddProperty}
                disabled={disabled}
                excludeTypes={excludeTypes}
                existingNames={properties.map((p) => p.name)}
              >
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
                  aria-label={t('properties.addDescription')}
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                  {t('properties.add')}
                </button>
              </AddPropertyPopup>
            </div>
          )}
        </div>
      )}
    </section>
  )
})
