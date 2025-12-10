import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Plus, ChevronDown, ChevronUp } from 'lucide-react'
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
  onAddProperty: (property: NewProperty) => void
  onDeleteProperty: (propertyId: string) => void
  disabled?: boolean
  initialVisibleCount?: number
}

export function InfoSection({
  properties,
  folderProperties,
  isExpanded,
  onToggleExpand,
  onPropertyChange,
  onAddProperty,
  onDeleteProperty,
  disabled = false,
  initialVisibleCount = 4
}: InfoSectionProps) {
  const [showAllProperties, setShowAllProperties] = useState(false)
  const [isAddPopupOpen, setIsAddPopupOpen] = useState(false)
  const [popupPosition, setPopupPosition] = useState<{ top: number; left: number } | null>(null)
  const [newlyAddedPropertyId, setNewlyAddedPropertyId] = useState<string | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)

  // Split properties into visible and hidden
  const { visibleProperties, hiddenProperties } = useMemo(() => {
    if (showAllProperties) {
      return { visibleProperties: properties, hiddenProperties: [] }
    }

    // Properties with values come first
    const withValue = properties.filter(
      (p) => p.value !== null && p.value !== undefined && p.value !== ''
    )
    const withoutValue = properties.filter(
      (p) => p.value === null || p.value === undefined || p.value === ''
    )

    const sorted = [...withValue, ...withoutValue]
    const visible = sorted.slice(0, initialVisibleCount)
    const hidden = sorted.slice(initialVisibleCount)

    return { visibleProperties: visible, hiddenProperties: hidden }
  }, [properties, showAllProperties, initialVisibleCount])

  const handlePropertyChange = useCallback(
    (propertyId: string) => (value: unknown) => {
      onPropertyChange(propertyId, value)
    },
    [onPropertyChange]
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

  // Handle adding new property
  const handleAddProperty = useCallback((newProp: NewProperty) => {
    onAddProperty(newProp)
  }, [onAddProperty])

  return (
    <div className="mb-4">
      {/* Toggle Header */}
      <InfoHeader isExpanded={isExpanded} onToggle={onToggleExpand} />

      {/* Collapsible Content */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-200',
          isExpanded ? 'opacity-100' : 'max-h-0 opacity-0'
        )}
        aria-hidden={!isExpanded}
      >
        <div
          className={cn(
            'mt-2 rounded-lg',
            'border border-stone-200',
            'bg-[#fafaf9]',
            'p-4'
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
          <div className="space-y-0.5">
            {visibleProperties.map((property) => (
              <PropertyRow
                key={property.id}
                property={property}
                onValueChange={handlePropertyChange(property.id)}
                onDelete={
                  property.isCustom
                    ? handleDeleteProperty(property.id)
                    : undefined
                }
                disabled={disabled}
                autoFocus={property.id === newlyAddedPropertyId}
              />
            ))}
          </div>

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
            >
              <ChevronDown className="h-3 w-3" />
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
            >
              <ChevronUp className="h-3 w-3" />
              Show less
            </button>
          )}

          {/* Add Property Button */}
          <div className="mt-3 border-t border-stone-200 pt-3">
            <button
              ref={addButtonRef}
              type="button"
              onClick={handleOpenAddPopup}
              disabled={disabled}
              className={cn(
                'flex items-center gap-1.5',
                'text-[13px] text-stone-500',
                'transition-colors duration-150',
                'hover:text-stone-700',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              Add property
            </button>
          </div>
        </div>
      </div>

      {/* Portal for AddPropertyPopup - renders at document body level */}
      {isAddPopupOpen && popupPosition && createPortal(
        <AddPropertyPopup
          isOpen={isAddPopupOpen}
          onClose={handleCloseAddPopup}
          onAdd={handleAddProperty}
          position={popupPosition}
        />,
        document.body
      )}
    </div>
  )
}
