import fs from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import {
  deletePropertyDefinition,
  getPropertyDefinition,
  listPropertyDefinitions,
  upsertPropertyDefinition
} from '@memry/storage-data'
import type { NewPropertyDefinition, PropertyDefinition } from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'
import type { NotesService } from './notes.ts'
import { getMemryDir } from './paths.ts'

export interface PropertyDefinitionInput {
  name: string
  type: string
  options?: string | null
  defaultValue?: string | null
  color?: string | null
}

export interface PropertyDefinitionUpdate {
  type?: string
  options?: string | null
  defaultValue?: string | null
  color?: string | null
}

export interface PropertiesService {
  get(entityId: string): Promise<Record<string, unknown>>
  set(entityId: string, properties: Record<string, unknown>): Promise<Record<string, unknown>>
  rename(entityId: string, oldName: string, newName: string): Promise<Record<string, unknown>>
  definitions(): Promise<PropertyDefinition[]>
  createDefinition(input: PropertyDefinitionInput): Promise<PropertyDefinition>
  updateDefinition(
    name: string,
    updates: PropertyDefinitionUpdate
  ): Promise<PropertyDefinition | null>
  deleteDefinition(name: string): Promise<boolean>
}

// The types desktop's PropertyDefinitionsFileSchema accepts in
// `.memry/properties.md`. `relation` is deliberately absent — desktop types a
// relation from its value every time, and an unknown entry in the file fails
// the schema's safeParse, which discards every definition at once.
const portableDefinitionTypes = new Set(['select', 'multiselect', 'status', 'date', 'project'])

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function defaultStatusCategories() {
  return {
    todo: {
      label: 'To-do',
      options: [{ value: 'Not started', color: 'stone', default: true }]
    },
    in_progress: {
      label: 'In progress',
      options: [{ value: 'In Progress', color: 'amber' }]
    },
    done: {
      label: 'Complete',
      options: [
        { value: 'Done', color: 'emerald' },
        { value: 'Abandoned', color: 'rose' }
      ]
    }
  }
}

function propertiesFileEntry(definition: PropertyDefinition): unknown {
  if (definition.type === 'status') {
    const parsed = parseJson(definition.options)
    const categories =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'categories' in parsed
        ? (parsed as { categories: unknown }).categories
        : defaultStatusCategories()
    return {
      type: 'status',
      categories
    }
  }

  if (definition.type === 'date') {
    const parsed = parseJson(definition.options)
    const showOnCalendar =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { showOnCalendar?: unknown }).showOnCalendar
        : undefined
    return typeof showOnCalendar === 'boolean' ? { type: 'date', showOnCalendar } : { type: 'date' }
  }

  if (definition.type === 'project') {
    return { type: 'project' }
  }

  return {
    type: definition.type,
    options: Array.isArray(parseJson(definition.options)) ? parseJson(definition.options) : []
  }
}

async function persistPortableDefinitions(
  vaultPath: string,
  definitions: PropertyDefinition[]
): Promise<void> {
  const properties: Record<string, unknown> = {}
  for (const definition of definitions) {
    if (!portableDefinitionTypes.has(definition.type)) continue
    properties[definition.name] = propertiesFileEntry(definition)
  }

  await fs.mkdir(getMemryDir(vaultPath), { recursive: true })
  await fs.writeFile(
    path.join(getMemryDir(vaultPath), 'properties.md'),
    matter.stringify('', { properties })
  )
}

export function createPropertiesService({
  notes,
  dataDb,
  vaultPath
}: {
  notes: NotesService
  dataDb: DataDb
  vaultPath: string
}): PropertiesService {
  return {
    async get(entityId) {
      const note = await notes.get(entityId)
      if (!note) throw new Error(`Entity not found: ${entityId}`)
      return note.properties
    },

    async set(entityId, properties) {
      const updated = await notes.update({ id: entityId, properties })
      return updated.properties
    },

    async definitions() {
      return listPropertyDefinitions(dataDb)
    },

    async createDefinition(input) {
      const definition = upsertPropertyDefinition(dataDb, {
        name: input.name,
        type: input.type,
        options: input.options ?? null,
        defaultValue: input.defaultValue ?? null,
        color: input.color ?? null
      } satisfies NewPropertyDefinition)
      await persistPortableDefinitions(vaultPath, listPropertyDefinitions(dataDb))
      return definition
    },

    async updateDefinition(name, updates) {
      const existing = getPropertyDefinition(dataDb, name)
      if (!existing) return null

      const definition = upsertPropertyDefinition(dataDb, {
        name,
        type: updates.type ?? existing.type,
        options: 'options' in updates ? (updates.options ?? null) : existing.options,
        defaultValue:
          'defaultValue' in updates ? (updates.defaultValue ?? null) : existing.defaultValue,
        color: 'color' in updates ? (updates.color ?? null) : existing.color
      } satisfies NewPropertyDefinition)
      await persistPortableDefinitions(vaultPath, listPropertyDefinitions(dataDb))
      return definition
    },

    async deleteDefinition(name) {
      deletePropertyDefinition(dataDb, name)
      await persistPortableDefinitions(vaultPath, listPropertyDefinitions(dataDb))
      return true
    },

    async rename(entityId, oldName, newName) {
      const note = await notes.get(entityId)
      if (!note) throw new Error(`Entity not found: ${entityId}`)
      if (!Object.prototype.hasOwnProperty.call(note.properties, oldName)) {
        throw new Error(`Property not found: ${oldName}`)
      }
      if (Object.prototype.hasOwnProperty.call(note.properties, newName)) {
        throw new Error(`Property already exists: ${newName}`)
      }

      const properties: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(note.properties)) {
        properties[name === oldName ? newName : name] = value
      }
      const updated = await notes.update({ id: entityId, properties })
      return updated.properties
    }
  }
}
