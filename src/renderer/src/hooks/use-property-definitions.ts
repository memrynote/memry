/**
 * T023: Property Definitions Hook
 *
 * Provides access to vault-wide property definitions with CRUD operations.
 *
 * @module hooks/use-property-definitions
 */

import { useState, useEffect, useCallback } from 'react'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'

const log = createLogger('Hook:PropertyDefinitions')
import {
  notesService,
  type PropertyDefinition,
  type CreatePropertyDefinitionInput
} from '@/services/notes-service'

export interface UsePropertyDefinitionsReturn {
  /** All property definitions */
  definitions: PropertyDefinition[]
  /** Loading state */
  isLoading: boolean
  /** Error state */
  error: string | null
  /** Create a new property definition */
  createDefinition: (input: CreatePropertyDefinitionInput) => Promise<PropertyDefinition | null>
  /** Update an existing property definition */
  updateDefinition: (
    name: string,
    updates: Partial<Omit<CreatePropertyDefinitionInput, 'name'>>
  ) => Promise<PropertyDefinition | null>
  /** Refresh definitions from server */
  refresh: () => Promise<void>
  /** Get a definition by name */
  getDefinition: (name: string) => PropertyDefinition | undefined
}

/**
 * Hook for managing vault-wide property definitions.
 *
 * Property definitions define the schema for properties used across all notes:
 * - Type (text, number, checkbox, date, select, multiselect, url, rating)
 * - Options (for select/multiselect types)
 * - Default value
 * - Color (for visual styling)
 *
 * @example
 * ```tsx
 * function PropertySchemaEditor() {
 *   const { definitions, createDefinition, updateDefinition, isLoading } =
 *     usePropertyDefinitions()
 *
 *   const handleAddProperty = async () => {
 *     await createDefinition({
 *       name: 'status',
 *       type: 'select',
 *       options: ['draft', 'review', 'published'],
 *       color: '#3B82F6'
 *     })
 *   }
 *
 *   if (isLoading) return <Spinner />
 *
 *   return (
 *     <div>
 *       {definitions.map(def => (
 *         <PropertyDefinitionRow
 *           key={def.name}
 *           definition={def}
 *           onUpdate={(updates) => updateDefinition(def.name, updates)}
 *         />
 *       ))}
 *       <Button onClick={handleAddProperty}>Add Property</Button>
 *     </div>
 *   )
 * }
 * ```
 */
export function usePropertyDefinitions(): UsePropertyDefinitionsReturn {
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fetch all definitions
  const fetchDefinitions = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const result = await notesService.getPropertyDefinitions()
      setDefinitions(result)
    } catch (err) {
      const message = extractErrorMessage(err, 'Failed to load property definitions')
      setError(message)
      log.error('Error fetching definitions:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchDefinitions()
  }, [fetchDefinitions])

  // Create a new definition
  const createDefinition = useCallback(
    async (input: CreatePropertyDefinitionInput): Promise<PropertyDefinition | null> => {
      try {
        const result = await notesService.createPropertyDefinition(input)
        if (!result.success || !result.definition) {
          throw new Error(result.error ?? 'Failed to create property definition')
        }
        // Add to local state
        setDefinitions((prev) => [...prev, result.definition!])
        return result.definition
      } catch (err) {
        log.error('Error creating definition:', err)
        throw err
      }
    },
    []
  )

  // Update an existing definition
  const updateDefinition = useCallback(
    async (
      name: string,
      updates: Partial<Omit<CreatePropertyDefinitionInput, 'name'>>
    ): Promise<PropertyDefinition | null> => {
      try {
        const result = await notesService.updatePropertyDefinition({
          name,
          ...updates
        })
        if (!result.success || !result.definition) {
          throw new Error(result.error ?? 'Failed to update property definition')
        }
        // Update local state
        setDefinitions((prev) => prev.map((def) => (def.name === name ? result.definition! : def)))
        return result.definition
      } catch (err) {
        log.error('Error updating definition:', err)
        throw err
      }
    },
    []
  )

  // Get a definition by name
  const getDefinition = useCallback(
    (name: string): PropertyDefinition | undefined => {
      return definitions.find((def) => def.name === name)
    },
    [definitions]
  )

  return {
    definitions,
    isLoading,
    error,
    createDefinition,
    updateDefinition,
    refresh: fetchDefinitions,
    getDefinition
  }
}

/**
 * Parse options from a PropertyDefinition.
 * Options are stored as JSON string in the database.
 */
export function parsePropertyOptions(definition: PropertyDefinition): string[] {
  if (!definition.options) return []
  try {
    return JSON.parse(definition.options)
  } catch {
    return []
  }
}

/**
 * Parse default value from a PropertyDefinition.
 * Default values are stored as JSON string in the database.
 */
export function parsePropertyDefaultValue(definition: PropertyDefinition): unknown {
  if (!definition.defaultValue) return null
  try {
    return JSON.parse(definition.defaultValue)
  } catch {
    return definition.defaultValue
  }
}
