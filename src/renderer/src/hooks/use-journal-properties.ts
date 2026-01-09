/**
 * Journal Properties Hook
 *
 * Provides reactive access to a journal entry's properties with optimistic updates.
 * Uses the journalService to update properties via the updateEntry API.
 *
 * @module hooks/use-journal-properties
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { journalService } from '@/services/journal-service'

export interface PropertyValue {
  name: string
  value: unknown
  type: string
}

export interface UseJournalPropertiesReturn {
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
  /** Add a new property */
  addProperty: (name: string, value: unknown) => Promise<void>
  /** Remove a property */
  removeProperty: (name: string) => Promise<void>
  /** Set all properties at once */
  setAllProperties: (properties: Record<string, unknown>) => Promise<void>
  /** Refresh properties from server */
  refresh: () => Promise<void>
}

/**
 * Infer property type from value (client-side helper).
 */
function inferType(
  value: unknown
): 'text' | 'number' | 'checkbox' | 'date' | 'multiselect' | 'url' | 'rating' {
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'multiselect'
  if (typeof value === 'string') {
    // Check for ISO date
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date'
    // Check for URL
    if (/^https?:\/\//.test(value)) return 'url'
  }
  return 'text'
}

/**
 * Convert properties record to PropertyValue array.
 */
function recordToProperties(record: Record<string, unknown>): PropertyValue[] {
  return Object.entries(record).map(([name, value]) => ({
    name,
    value,
    type: inferType(value)
  }))
}

/**
 * Hook for managing journal entry properties.
 *
 * @param date - The date of the journal entry (YYYY-MM-DD format) or null
 * @param initialProperties - Optional initial properties from the entry
 * @returns Object with properties state and mutation functions
 *
 * @example
 * ```tsx
 * function JournalPropertiesPanel({ date, entry }) {
 *   const { properties, updateProperty, addProperty, removeProperty, isLoading } =
 *     useJournalProperties(date, entry?.properties)
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
export function useJournalProperties(
  date: string | null,
  initialProperties?: Record<string, unknown>
): UseJournalPropertiesReturn {
  // Track local edits separately from initialProperties (optimistic updates pattern)
  const [localEdits, setLocalEdits] = useState<Record<string, unknown>>({})
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Ref for stabilizing fetchProperties callback
  const fetchPropertiesRef = useRef<() => Promise<void>>()

  // Compute merged properties during render (derived state done correctly)
  const propertiesRecord = useMemo(() => {
    const base = initialProperties ?? {}
    const merged = { ...base, ...localEdits }
    // Remove deleted keys
    for (const key of deletedKeys) {
      delete merged[key]
    }
    return merged
  }, [initialProperties, localEdits, deletedKeys])

  // Convert to PropertyValue array
  const properties = useMemo(() => recordToProperties(propertiesRecord), [propertiesRecord])

  // Clear local edits (used after successful API calls or refresh)
  const clearLocalEdits = useCallback(() => {
    setLocalEdits({})
    setDeletedKeys(new Set())
  }, [])

  // Fetch properties (reload from entry) - use ref pattern to stabilize callback
  useEffect(() => {
    fetchPropertiesRef.current = async () => {
      if (!date) {
        clearLocalEdits()
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        // Fetching will update initialProperties via parent, so clear local edits
        await journalService.getEntry(date)
        clearLocalEdits()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load properties'
        setError(message)
        console.error('[useJournalProperties] Error fetching properties:', err)
      } finally {
        setIsLoading(false)
      }
    }
  }, [date, clearLocalEdits])

  // Stable reference to fetchProperties
  const fetchProperties = useCallback(async () => {
    await fetchPropertiesRef.current?.()
  }, [])

  // Update a single property
  const updateProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!date) return

      // Capture current record before optimistic update
      const currentRecord = { ...propertiesRecord }

      // Optimistic update via local edits
      setLocalEdits((prev) => ({ ...prev, [name]: value }))
      // If it was deleted, un-delete it
      setDeletedKeys((prev) => {
        if (prev.has(name)) {
          const next = new Set(prev)
          next.delete(name)
          return next
        }
        return prev
      })

      try {
        const newRecord = { ...currentRecord, [name]: value }
        await journalService.updateEntry({ date, properties: newRecord })
      } catch (err) {
        console.error('[useJournalProperties] Error updating property:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [date, propertiesRecord, fetchProperties]
  )

  // Add a new property
  const addProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!date) return

      // Capture current record before optimistic update
      const currentRecord = { ...propertiesRecord }

      // Optimistic update via local edits
      setLocalEdits((prev) => ({ ...prev, [name]: value }))
      // If it was deleted, un-delete it
      setDeletedKeys((prev) => {
        if (prev.has(name)) {
          const next = new Set(prev)
          next.delete(name)
          return next
        }
        return prev
      })

      try {
        const newRecord = { ...currentRecord, [name]: value }
        await journalService.updateEntry({ date, properties: newRecord })
      } catch (err) {
        console.error('[useJournalProperties] Error adding property:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [date, propertiesRecord, fetchProperties]
  )

  // Remove a property
  const removeProperty = useCallback(
    async (name: string) => {
      if (!date) return

      // Capture current record before optimistic update
      const currentRecord = { ...propertiesRecord }

      // Optimistic update via deletedKeys
      setDeletedKeys((prev) => new Set(prev).add(name))
      // Remove from local edits if present
      setLocalEdits((prev) => {
        if (name in prev) {
          const next = { ...prev }
          delete next[name]
          return next
        }
        return prev
      })

      try {
        const newRecord = { ...currentRecord }
        delete newRecord[name]
        await journalService.updateEntry({ date, properties: newRecord })
      } catch (err) {
        console.error('[useJournalProperties] Error removing property:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [date, propertiesRecord, fetchProperties]
  )

  // Set all properties at once
  const setAllProperties = useCallback(
    async (newProperties: Record<string, unknown>) => {
      if (!date) return

      // For setAll, we replace everything with local edits matching the new properties
      // and mark all other keys as deleted
      const base = initialProperties ?? {}
      const allBaseKeys = Object.keys(base)

      // Set local edits to the new values
      setLocalEdits(newProperties)
      // Mark keys that exist in base but not in new as deleted
      const toDelete = allBaseKeys.filter((k) => !(k in newProperties))
      setDeletedKeys(new Set(toDelete))

      try {
        await journalService.updateEntry({ date, properties: newProperties })
      } catch (err) {
        console.error('[useJournalProperties] Error setting properties:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [date, initialProperties, fetchProperties]
  )

  return {
    properties,
    propertiesRecord,
    isLoading,
    error,
    updateProperty,
    addProperty,
    removeProperty,
    setAllProperties,
    refresh: fetchProperties
  }
}
