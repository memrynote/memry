/**
 * Journal Properties Hook
 *
 * Provides reactive access to a journal entry's properties with optimistic updates.
 * Uses the journalService to update properties via the updateEntry API.
 *
 * @module hooks/use-journal-properties
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
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
  const [properties, setProperties] = useState<PropertyValue[]>(() =>
    initialProperties ? recordToProperties(initialProperties) : []
  )
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

  // Update properties when initialProperties changes
  useEffect(() => {
    if (initialProperties) {
      setProperties(recordToProperties(initialProperties))
    } else {
      setProperties([])
    }
  }, [initialProperties])

  // Fetch properties (reload from entry)
  const fetchProperties = useCallback(async () => {
    if (!date) {
      setProperties([])
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const entry = await journalService.getEntry(date)
      if (entry?.properties) {
        setProperties(recordToProperties(entry.properties))
      } else {
        setProperties([])
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load properties'
      setError(message)
      console.error('[useJournalProperties] Error fetching properties:', err)
    } finally {
      setIsLoading(false)
    }
  }, [date])

  // Update a single property
  const updateProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!date) return

      // Optimistic update
      setProperties((prev) =>
        prev.map((prop) => (prop.name === name ? { ...prop, value, type: inferType(value) } : prop))
      )

      try {
        const newRecord = { ...propertiesRecord, [name]: value }
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

      // Optimistic update
      const type = inferType(value)
      setProperties((prev) => [...prev, { name, value, type }])

      try {
        const newRecord = { ...propertiesRecord, [name]: value }
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

      // Optimistic update
      setProperties((prev) => prev.filter((prop) => prop.name !== name))

      try {
        const newRecord = { ...propertiesRecord }
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

      // Optimistic update
      setProperties(recordToProperties(newProperties))

      try {
        await journalService.updateEntry({ date, properties: newProperties })
      } catch (err) {
        console.error('[useJournalProperties] Error setting properties:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [date, fetchProperties]
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
