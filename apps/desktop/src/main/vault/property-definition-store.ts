import {
  deletePropertyDefinition as deletePropertyDefinitionCache,
  insertPropertyDefinition as insertPropertyDefinitionCache,
  updatePropertyDefinition as updatePropertyDefinitionCache
} from '@main/database/queries/notes'
import {
  deletePropertyDefinition as deleteCanonicalPropertyDefinition,
  getPropertyDefinition as getCanonicalPropertyDefinition,
  upsertPropertyDefinition
} from '@memry/storage-data'
import { getDatabase, getIndexDatabase } from '../database'

type PropertyDefinitionRecord = Parameters<typeof upsertPropertyDefinition>[1]
type PropertyDefinitionResult = ReturnType<typeof upsertPropertyDefinition>
type PropertyDefinitionUpdates = Partial<Omit<PropertyDefinitionResult, 'name' | 'createdAt'>>

function upsertPropertyDefinitionCache(definition: PropertyDefinitionRecord): void {
  const indexDb = getIndexDatabase()
  const updated = updatePropertyDefinitionCache(indexDb, definition.name, {
    type: definition.type,
    options: definition.options,
    defaultValue: definition.defaultValue,
    color: definition.color
  })

  if (!updated) {
    insertPropertyDefinitionCache(indexDb, definition)
  }
}

export function createPropertyDefinitionRecord(definition: PropertyDefinitionRecord) {
  const created = upsertPropertyDefinition(getDatabase(), definition)
  upsertPropertyDefinitionCache(definition)
  return created
}

export function updatePropertyDefinitionRecord(name: string, updates: PropertyDefinitionUpdates) {
  const existing = getCanonicalPropertyDefinition(getDatabase(), name)
  if (!existing) return existing

  const definition = upsertPropertyDefinition(getDatabase(), {
    name,
    type: 'type' in updates ? (updates.type ?? existing.type) : existing.type,
    options: 'options' in updates ? (updates.options ?? null) : existing.options,
    defaultValue:
      'defaultValue' in updates ? (updates.defaultValue ?? null) : existing.defaultValue,
    color: 'color' in updates ? (updates.color ?? null) : existing.color
  })

  upsertPropertyDefinitionCache({
    name: definition.name,
    type: definition.type,
    options: definition.options,
    defaultValue: definition.defaultValue,
    color: definition.color
  })

  return definition
}

export function deletePropertyDefinitionRecord(name: string): void {
  deleteCanonicalPropertyDefinition(getDatabase(), name)
  deletePropertyDefinitionCache(getIndexDatabase(), name)
}
