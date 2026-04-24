import { useState, useEffect, useCallback, useMemo } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { propertiesService, type PropertyValue } from '@/services/properties-service'
import { inferType, getUniquePropertyName } from '@/lib/property-utils'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import { toast } from 'sonner'

interface ItemSyncedEvent {
  operation: 'push' | 'pull'
  itemId: string
  type: string
}

const log = createLogger('Hook:Properties')

function toRecord(props: PropertyValue[]): Record<string, unknown> {
  return Object.fromEntries(props.map((p) => [p.name, p.value]))
}

export interface UsePropertiesReturn {
  properties: PropertyValue[]
  propertiesRecord: Record<string, unknown>
  isLoading: boolean
  error: string | null
  updateProperty: (name: string, value: unknown) => Promise<void>
  addProperty: (name: string, value: unknown, explicitType?: string) => Promise<void>
  removeProperty: (name: string) => Promise<void>
  renameProperty: (oldName: string, newName: string) => Promise<void>
  reorderProperties: (orderedNames: string[]) => Promise<void>
  refresh: () => Promise<void>
}

export function useProperties(entityId: string | null): UsePropertiesReturn {
  const [properties, setProperties] = useState<PropertyValue[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const propertiesRecord = useMemo(() => toRecord(properties), [properties])

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

  useEffect(() => {
    fetchProperties()
  }, [fetchProperties])

  useEffect(() => {
    if (!entityId) return
    return subscribeEvent<ItemSyncedEvent>('item-synced', (event) => {
      if (event.operation !== 'pull') return
      if (event.itemId !== entityId) return
      if (event.type !== 'note' && event.type !== 'journal') return
      fetchProperties()
    })
  }, [entityId, fetchProperties])

  const updateProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!entityId) return

      let record: Record<string, unknown> = {}
      setProperties((prev) => {
        const next = prev.map((p) => (p.name === name ? { ...p, value } : p))
        record = toRecord(next)
        return next
      })

      try {
        const result = await propertiesService.set(entityId, record)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update property')
        }
      } catch (err) {
        log.error('Error updating:', err)
        toast.error('Failed to update property')
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties]
  )

  const addProperty = useCallback(
    async (name: string, value: unknown, explicitType?: string) => {
      if (!entityId) return

      const type = explicitType ?? inferType(value)
      let record: Record<string, unknown> = {}
      setProperties((prev) => {
        const existingNames = prev.map((p) => p.name)
        const uniqueName = getUniquePropertyName(name, existingNames)
        const next = [...prev, { name: uniqueName, value, type }]
        record = toRecord(next)
        return next
      })

      try {
        const result = await propertiesService.set(entityId, record)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to add property')
        }
      } catch (err) {
        log.error('Error adding:', err)
        toast.error('Failed to add property')
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties]
  )

  const removeProperty = useCallback(
    async (name: string) => {
      if (!entityId) return

      let record: Record<string, unknown> = {}
      setProperties((prev) => {
        const next = prev.filter((p) => p.name !== name)
        record = toRecord(next)
        return next
      })

      try {
        const result = await propertiesService.set(entityId, record)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to remove property')
        }
      } catch (err) {
        log.error('Error removing:', err)
        toast.error('Failed to delete property')
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties]
  )

  const renameProperty = useCallback(
    async (oldName: string, newName: string) => {
      if (!entityId) return
      if (oldName === newName) return

      setProperties((prev) => prev.map((p) => (p.name === oldName ? { ...p, name: newName } : p)))

      try {
        const result = await propertiesService.rename(entityId, oldName, newName)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to rename property')
        }
      } catch (err) {
        log.error('Error renaming:', err)
        toast.error('Failed to rename property')
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties]
  )

  const reorderProperties = useCallback(
    async (orderedNames: string[]) => {
      if (!entityId) return

      let record: Record<string, unknown> = {}
      let changed = false
      setProperties((prev) => {
        const currentOrder = prev.map((p) => p.name)
        const isSameOrder =
          orderedNames.length === currentOrder.length &&
          orderedNames.every((n, i) => n === currentOrder[i])
        if (isSameOrder) return prev

        const orderSet = new Set(orderedNames)
        const propertyMap = new Map(prev.map((p) => [p.name, p]))
        const next = [
          ...orderedNames
            .map((n) => propertyMap.get(n))
            .filter((p): p is PropertyValue => Boolean(p)),
          ...prev.filter((p) => !orderSet.has(p.name))
        ]
        record = toRecord(next)
        changed = true
        return next
      })

      if (!changed) return

      try {
        const result = await propertiesService.set(entityId, record)
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
    [entityId, fetchProperties]
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
