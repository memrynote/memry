/**
 * T022: Note Properties Hook
 *
 * Provides reactive access to a note's properties with optimistic updates.
 *
 * @module hooks/use-note-properties
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { notesService, type PropertyValue } from '@/services/notes-service'

export interface UseNotePropertiesReturn {
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
  /** Refresh properties from server */
  refresh: () => Promise<void>
}

/**
 * Hook for managing note properties.
 *
 * @param noteId - The ID of the note to get properties for
 * @returns Object with properties state and mutation functions
 *
 * @example
 * ```tsx
 * function NotePropertiesPanel({ noteId }) {
 *   const { properties, updateProperty, addProperty, removeProperty, isLoading } =
 *     useNoteProperties(noteId)
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
export function useNoteProperties(noteId: string | null): UseNotePropertiesReturn {
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

  // Fetch properties
  const fetchProperties = useCallback(async () => {
    if (!noteId) {
      setProperties([])
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await notesService.getProperties(noteId)
      setProperties(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load properties'
      setError(message)
      console.error('[useNoteProperties] Error fetching properties:', err)
    } finally {
      setIsLoading(false)
    }
  }, [noteId])

  // Initial fetch
  useEffect(() => {
    fetchProperties()
  }, [fetchProperties])

  // Update a property
  const updateProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!noteId) return

      // Optimistic update
      setProperties((prev) =>
        prev.map((prop) => (prop.name === name ? { ...prop, value } : prop))
      )

      try {
        const newRecord = { ...propertiesRecord, [name]: value }
        const result = await notesService.setProperties(noteId, newRecord)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to update property')
        }
      } catch (err) {
        console.error('[useNoteProperties] Error updating property:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [noteId, propertiesRecord, fetchProperties]
  )

  // Add a new property
  const addProperty = useCallback(
    async (name: string, value: unknown) => {
      if (!noteId) return

      // Optimistic update - infer type from value
      const type = inferType(value)
      setProperties((prev) => [...prev, { name, value, type }])

      try {
        const newRecord = { ...propertiesRecord, [name]: value }
        const result = await notesService.setProperties(noteId, newRecord)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to add property')
        }
        // Refresh to get the correct type from server
        await fetchProperties()
      } catch (err) {
        console.error('[useNoteProperties] Error adding property:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [noteId, propertiesRecord, fetchProperties]
  )

  // Remove a property
  const removeProperty = useCallback(
    async (name: string) => {
      if (!noteId) return

      // Optimistic update
      setProperties((prev) => prev.filter((prop) => prop.name !== name))

      try {
        const newRecord = { ...propertiesRecord }
        delete newRecord[name]
        const result = await notesService.setProperties(noteId, newRecord)
        if (!result.success) {
          throw new Error(result.error ?? 'Failed to remove property')
        }
      } catch (err) {
        console.error('[useNoteProperties] Error removing property:', err)
        // Revert on error
        await fetchProperties()
        throw err
      }
    },
    [noteId, propertiesRecord, fetchProperties]
  )

  return {
    properties,
    propertiesRecord,
    isLoading,
    error,
    updateProperty,
    addProperty,
    removeProperty,
    refresh: fetchProperties
  }
}

/**
 * Infer property type from value (client-side helper).
 */
function inferType(
  value: unknown
): 'text' | 'number' | 'checkbox' | 'date' | 'multiselect' | 'url' {
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
