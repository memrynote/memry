import { useCallback, useMemo, useState, useRef } from 'react'
import { type NewProperty, type Property } from '@/components/note/info-section'
import { useProperties } from '@/hooks/use-properties'
import {
  getDefaultValueForType,
  getUniquePropertyName,
  mapPropertyType
} from '@/lib/property-utils'

export type PropertySectionAction = 'update' | 'add' | 'remove' | 'rename' | 'reorder'

export interface UsePropertySectionOptions {
  entityId: string | null
  canEdit?: () => boolean
  onBlocked?: (action: PropertySectionAction) => void
  onError?: (action: PropertySectionAction, error: unknown) => void
  includeExplicitType?: boolean
}

export interface UsePropertySectionResult {
  properties: Property[]
  newlyAddedPropertyId: string | null
  handlePropertyChange: (propertyId: string, value: unknown) => void
  handleAddProperty: (property: NewProperty) => void
  handleDeleteProperty: (propertyId: string) => void
  handlePropertyNameChange: (propertyId: string, newName: string) => void
  handlePropertyOrderChange: (newOrder: string[]) => void
}

export function usePropertySection({
  entityId,
  canEdit,
  onBlocked,
  onError,
  includeExplicitType = false
}: UsePropertySectionOptions): UsePropertySectionResult {
  const {
    properties: backendProperties,
    updateProperty,
    addProperty,
    removeProperty,
    renameProperty,
    reorderProperties
  } = useProperties(entityId)

  const [newlyAddedPropertyId, setNewlyAddedPropertyId] = useState<string | null>(null)
  const clearTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const properties: Property[] = useMemo(() => {
    return backendProperties.map((prop) => ({
      id: prop.name,
      name: prop.name,
      type: mapPropertyType(prop.type),
      value: prop.value,
      isCustom: true
    }))
  }, [backendProperties, mapPropertyType])

  const canPerformAction = useCallback(
    (action: PropertySectionAction) => {
      if (!canEdit) return true
      if (canEdit()) return true
      onBlocked?.(action)
      return false
    },
    [canEdit, onBlocked]
  )

  const handlePropertyChange = useCallback(
    async (propertyId: string, value: unknown) => {
      if (!canPerformAction('update')) return
      try {
        await updateProperty(propertyId, value)
      } catch (error) {
        onError?.('update', error)
      }
    },
    [canPerformAction, updateProperty, onError]
  )

  const handleAddProperty = useCallback(
    async (newProp: NewProperty) => {
      if (!canPerformAction('add')) return
      const defaultValue = getDefaultValueForType(newProp.type)
      try {
        const selectTypes = new Set(['status', 'select', 'multiselect'])
        if (selectTypes.has(newProp.type)) {
          const { notesService } = await import('@/services/notes-service')
          await notesService.ensurePropertyDefinition(newProp.name, newProp.type)
        }
        const existingNames = properties.map((p) => p.name)
        const uniqueName = getUniquePropertyName(newProp.name, existingNames)
        clearTimeout(clearTimerRef.current)
        setNewlyAddedPropertyId(uniqueName)
        clearTimerRef.current = setTimeout(() => setNewlyAddedPropertyId(null), 2000)
        await addProperty(
          newProp.name,
          defaultValue,
          includeExplicitType ? newProp.type : undefined
        )
      } catch (error) {
        onError?.('add', error)
      }
    },
    [canPerformAction, addProperty, includeExplicitType, onError, getDefaultValueForType]
  )

  const handleDeleteProperty = useCallback(
    async (propertyId: string) => {
      if (!canPerformAction('remove')) return
      try {
        await removeProperty(propertyId)
      } catch (error) {
        onError?.('remove', error)
      }
    },
    [canPerformAction, removeProperty, onError]
  )

  const handlePropertyNameChange = useCallback(
    async (propertyId: string, newName: string) => {
      if (!canPerformAction('rename')) return
      try {
        await renameProperty(propertyId, newName)
      } catch (error) {
        onError?.('rename', error)
      }
    },
    [canPerformAction, renameProperty, onError]
  )

  const handlePropertyOrderChange = useCallback(
    async (newOrder: string[]) => {
      if (!canPerformAction('reorder')) return
      try {
        await reorderProperties(newOrder)
      } catch (error) {
        onError?.('reorder', error)
      }
    },
    [canPerformAction, reorderProperties, onError]
  )

  return {
    properties,
    newlyAddedPropertyId,
    handlePropertyChange,
    handleAddProperty,
    handleDeleteProperty,
    handlePropertyNameChange,
    handlePropertyOrderChange
  }
}
