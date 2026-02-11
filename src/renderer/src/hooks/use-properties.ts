/**
 * Unified Properties Hook
 *
 * Provides reactive access to properties with optimistic updates.
 * Works with any entity ID (note or journal entry).
 *
 * @module hooks/use-properties
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Hook:Properties')
import { propertiesService, type PropertyValue } from '@/services/properties-service'
import { inferType } from '@/lib/property-utils'
import { toast } from 'sonner'

export interface UsePropertiesReturn {
  /** Current properties as an array of PropertyValue */
  properties: PropertyValue[]
  /** Properties as a Record for easy access by name */
  propertiesRecord: Record<string, unknown>
  /** Loading state */
  isLoading: boolean
  /** Error state */
  error: string | null
  /** Update a single property */
  updateProperty: (name: string, value: unknown) => Promise<void>
  /** Add a new property with optional explicit type */
  addProperty: (name: string, value: unknown, explicitType?: string) => Promise<void>
  /** Remove a property */
  removeProperty: (name: string) => Promise<void>
  /** Rename a property (note-only scope) */
  renameProperty: (oldName: string, newName: string) => Promise<void>
  /** Reorder properties by name (persists order in frontmatter) */
  reorderProperties: (orderedNames: string[]) => Promise<void>
  /** Refresh properties from server */
  refresh: () => Promise<void>
}

/**
 * Hook for managing properties on any entity (note or journal entry).
 *
 * @param entityId - The ID of the entity (note ID or journal entry ID)
 * @returns Object with properties state and mutation functions
 *
 * @example
 * ```tsx
 * function PropertiesPanel({ entityId }) {
 *   const {
 *     properties,
 *     updateProperty,
 *     addProperty,
 *     removeProperty,
 *     isLoading
 *   } = useProperties(entityId)
 *
 *   if (isLoading) return <Spinner />
 *
 *   return (
 *     <div>
 *       {properties.map(prop => (
 *         <PropertyRow
 *           key={prop.name}
 *           property={prop}
 *           onUpdate={(value) => updateProperty(prop.name, value)}
 *           onRemove={() => removeProperty(prop.name)}
 *         />
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 */
export function useProperties(entityId: string | null): UsePropertiesReturn {
  const [properties, setProperties] = useState<PropertyValue[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Convert properties array to Record for easy access
  const propertiesRecord = useMemo(() => {
    const record: Record<string, unknown> = {}
    for (const prop of properties) {
      record[prop.name] = prop.value
    }
    return record
  }, [properties])

  // Fetch properties from server
  const fetchProperties = useCallback(async () => {
    if (!entityId) {
      setProperties([])
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await propertiesService.get(entityId)
      setProperties(result)
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to load properties')
      setError(message)
      log.error('Error fetching:', err)
    } finally {
      setIsLoading(false)
    }
  }, [entityId])

  // Initial fetch
  useEffect(() => {
    fetchProperties()
  }, [fetchProperties])

  // Update a single property
  const updateProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!entityId) return

      // Optimistic update
      setProperties((prev) => prev.map((p) => (p.name === name ? { ...p, value } : p)))

      try {
        const newRecord = { ...propertiesRecord, [name]: value }
        const result = await propertiesService.set(entityId, newRecord)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update property')
        }
      } catch (err) {
        log.error('Error updating:', err)
        toast.error('Failed to update property')
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [entityId, propertiesRecord, fetchProperties]
  )

  // Add a new property
  const addProperty = useCallback(
    async (name: string, value: unknown, explicitType?: string) => {
      if (!entityId) return

      // Optimistic update
      const type = explicitType ?? inferType(value)
      setProperties((prev) => [...prev, { name, value, type }])

      try {
        const newRecord = { ...propertiesRecord, [name]: value }
        const result = await propertiesService.set(entityId, newRecord)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to add property')
        }
        // Don't refresh - trust optimistic update to preserve order and type
      } catch (err) {
        log.error('Error adding:', err)
        toast.error('Failed to add property')
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [entityId, propertiesRecord, fetchProperties]
  )

  // Remove a property
  const removeProperty = useCallback(
    async (name: string) => {
      if (!entityId) return

      // Optimistic update
      setProperties((prev) => prev.filter((p) => p.name !== name))

      try {
        const newRecord = { ...propertiesRecord }
        delete newRecord[name]
        const result = await propertiesService.set(entityId, newRecord)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to remove property')
        }
      } catch (err) {
        log.error('Error removing:', err)
        toast.error('Failed to delete property')
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [entityId, propertiesRecord, fetchProperties]
  )

  // Rename a property (note-only scope)
  const renameProperty = useCallback(
    async (oldName: string, newName: string) => {
      if (!entityId) return

      // Don't rename to same name
      if (oldName === newName) return

      // Optimistic update
      setProperties((prev) => prev.map((p) => (p.name === oldName ? { ...p, name: newName } : p)))

      try {
        const result = await propertiesService.rename(entityId, oldName, newName)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to rename property')
        }
      } catch (err) {
        log.error('Error renaming:', err)
        toast.error('Failed to rename property')
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties]
  )

  // Reorder properties
  const reorderProperties = useCallback(
    async (orderedNames: string[]) => {
      if (!entityId) return

      const currentOrder = properties.map((prop) => prop.name)
      const isSameOrder =
        orderedNames.length === currentOrder.length &&
        orderedNames.every((name, index) => name === currentOrder[index])

      if (isSameOrder) return

      const orderSet = new Set(orderedNames)
      const propertyMap = new Map(properties.map((prop) => [prop.name, prop]))
      const orderedProperties = [
        ...orderedNames
          .map((name) => propertyMap.get(name))
          .filter((prop): prop is PropertyValue => Boolean(prop)),
        ...properties.filter((prop) => !orderSet.has(prop.name))
      ]

      // Optimistic update
      setProperties(orderedProperties)

      try {
        const newRecord: Record<string, unknown> = {}
        for (const prop of orderedProperties) {
          newRecord[prop.name] = prop.value
        }
        const result = await propertiesService.set(entityId, newRecord)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to reorder properties')
        }
      } catch (err) {
        log.error('Error reordering:', err)
        toast.error('Failed to reorder properties')
        await fetchProperties()
        throw err
      }
    },
    [entityId, properties, fetchProperties]
  )

  return {
    properties,
    propertiesRecord,
    isLoading,
    error,
    updateProperty,
    addProperty,
    removeProperty,
    renameProperty,
    reorderProperties,
    refresh: fetchProperties
  }
}
