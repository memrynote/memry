import { useState, useEffect, useCallback, useMemo } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { propertiesService, type PropertyValue } from '@/services/properties-service'
import { inferType, getUniquePropertyName } from '@/lib/property-utils'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'

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
      const message = extractErrorMessage(
        err,
        getI18n().getFixedT(null, 'notes')('phaseI.errors.failedToLoadProperties')
      )
      setError(message)
      log.error('Error fetching:', err)
    } finally {
      setIsLoading(false)
    }
  }, [entityId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await fetchProperties()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [fetchProperties])

  useEffect(() => {
    if (!entityId) return
    const unsub = window.api.onItemSynced((event) => {
      if (event.operation !== 'pull') return
      if (event.itemId !== entityId) return
      if (event.type !== 'note' && event.type !== 'journal') return
      void fetchProperties()
    })
    return unsub
  }, [entityId, fetchProperties])

  const updateProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!entityId) return

      const next = properties.map((p) => (p.name === name ? { ...p, value } : p))
      const record = toRecord(next)
      setProperties(next)

      try {
        const result = await propertiesService.set(entityId, record)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update property')
        }
      } catch (err) {
        trackRendererError('note_property_update_failed', err)
        log.error('Error updating:', err)
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToUpdateProperty'))
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties, properties]
  )

  const addProperty = useCallback(
    async (name: string, value: unknown, explicitType?: string) => {
      if (!entityId) return

      const type = explicitType ?? inferType(value)
      const existingNames = properties.map((p) => p.name)
      const uniqueName = getUniquePropertyName(name, existingNames)
      const next = [...properties, { name: uniqueName, value, type }]
      const record = toRecord(next)
      setProperties(next)

      try {
        const result = await propertiesService.set(entityId, record)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to add property')
        }
      } catch (err) {
        trackRendererError('note_property_add_failed', err)
        log.error('Error adding:', err)
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToAddProperty'))
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties, properties]
  )

  const removeProperty = useCallback(
    async (name: string) => {
      if (!entityId) return

      const next = properties.filter((p) => p.name !== name)
      const record = toRecord(next)
      setProperties(next)

      try {
        const result = await propertiesService.set(entityId, record)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to remove property')
        }
      } catch (err) {
        trackRendererError('note_property_remove_failed', err)
        log.error('Error removing:', err)
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToDeleteProperty'))
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties, properties]
  )

  const renameProperty = useCallback(
    async (oldName: string, newName: string) => {
      if (!entityId) return
      if (oldName === newName) return

      setProperties(properties.map((p) => (p.name === oldName ? { ...p, name: newName } : p)))

      try {
        const result = await propertiesService.rename(entityId, oldName, newName)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to rename property')
        }
      } catch (err) {
        trackRendererError('note_property_rename_failed', err)
        log.error('Error renaming:', err)
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToRenameProperty'))
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties, properties]
  )

  const reorderProperties = useCallback(
    async (orderedNames: string[]) => {
      if (!entityId) return

      const currentOrder = properties.map((p) => p.name)
      const isSameOrder =
        orderedNames.length === currentOrder.length &&
        orderedNames.every((n, i) => n === currentOrder[i])
      if (isSameOrder) return

      const orderSet = new Set(orderedNames)
      const propertyMap = new Map(properties.map((p) => [p.name, p]))
      const next = [
        ...orderedNames
          .map((n) => propertyMap.get(n))
          .filter((p): p is PropertyValue => Boolean(p)),
        ...properties.filter((p) => !orderSet.has(p.name))
      ]
      const record = toRecord(next)
      setProperties(next)

      try {
        const result = await propertiesService.set(entityId, record)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to reorder properties')
        }
      } catch (err) {
        trackRendererError('note_property_reorder_failed', err)
        log.error('Error reordering:', err)
        toast.error(getI18n().getFixedT(null, 'notes')('phaseI.toasts.failedToReorderProperties'))
        await fetchProperties()
        throw err
      }
    },
    [entityId, fetchProperties, properties]
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
