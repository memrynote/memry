import { eq, and, inArray, sql } from 'drizzle-orm'
import {
  noteCache,
  noteProperties,
  propertyDefinitions,
  type NoteCache,
  type NewNoteProperty,
  type PropertyDefinition,
  type NewPropertyDefinition,
  type PropertyType
} from '@memry/db-schema/schema/notes-cache'
import { isRelationValue } from '@memry/contracts/relation-uri'
import type { IndexDb } from '../../types'
import { serializeValue, deserializeValue } from './query-helpers'
import { setPropertyRefs } from './property-ref-queries'

// ============================================================================
// Property Value Operations
// ============================================================================

export interface PropertyValue {
  name: string
  value: unknown
  type: PropertyType
}

export function setNoteProperties(
  db: IndexDb,
  noteId: string,
  properties: Record<string, unknown>,
  getType: (name: string, value: unknown) => PropertyType
): void {
  db.delete(noteProperties).where(eq(noteProperties.noteId, noteId)).run()

  const entries = Object.entries(properties)

  if (entries.length > 0) {
    const propertyRecords: NewNoteProperty[] = entries.map(([name, value]) => {
      const type = getType(name, value)
      ensurePropertyDefinition(db, name, type)
      return {
        noteId,
        name,
        value: serializeValue(value),
        type
      }
    })
    db.insert(noteProperties).values(propertyRecords).run()
  }

  setPropertyRefs(db, noteId, properties)
}

export function getNoteProperties(db: IndexDb, noteId: string): PropertyValue[] {
  const results = db
    .select()
    .from(noteProperties)
    .where(eq(noteProperties.noteId, noteId))
    .orderBy(sql`rowid`)
    .all()

  return results.map((row) => ({
    name: row.name,
    value: deserializeValue(row.value, row.type as PropertyType),
    type: row.type as PropertyType
  }))
}

export function getNotePropertiesAsRecord(db: IndexDb, noteId: string): Record<string, unknown> {
  const properties = getNoteProperties(db, noteId)
  const result: Record<string, unknown> = {}
  for (const prop of properties) {
    result[prop.name] = prop.value
  }
  return result
}

export function getPropertiesForNotes(
  db: IndexDb,
  noteIds: string[]
): Map<string, Record<string, unknown>> {
  if (noteIds.length === 0) {
    return new Map()
  }

  const results = db
    .select({
      noteId: noteProperties.noteId,
      name: noteProperties.name,
      value: noteProperties.value,
      type: noteProperties.type
    })
    .from(noteProperties)
    .where(inArray(noteProperties.noteId, noteIds))
    .all()

  const propsMap = new Map<string, Record<string, unknown>>()

  for (const noteId of noteIds) {
    propsMap.set(noteId, {})
  }

  for (const row of results) {
    const props = propsMap.get(row.noteId)
    if (props) {
      props[row.name] = deserializeValue(row.value, row.type as PropertyType)
    }
  }

  return propsMap
}

export function deleteNoteProperties(db: IndexDb, noteId: string): void {
  db.delete(noteProperties).where(eq(noteProperties.noteId, noteId)).run()
}

export function filterNotesByProperty(
  db: IndexDb,
  propertyName: string,
  propertyValue: string
): NoteCache[] {
  const noteIds = db
    .select({ noteId: noteProperties.noteId })
    .from(noteProperties)
    .where(and(eq(noteProperties.name, propertyName), eq(noteProperties.value, propertyValue)))
    .all()
    .map((r) => r.noteId)

  if (noteIds.length === 0) {
    return []
  }

  return db.select().from(noteCache).where(inArray(noteCache.id, noteIds)).all()
}

// ============================================================================
// Property Definitions
// ============================================================================

export function getPropertyDefinition(db: IndexDb, name: string): PropertyDefinition | undefined {
  return db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, name)).get()
}

export function insertPropertyDefinition(
  db: IndexDb,
  definition: NewPropertyDefinition
): PropertyDefinition {
  return db.insert(propertyDefinitions).values(definition).returning().get()
}

export function updatePropertyDefinition(
  db: IndexDb,
  name: string,
  updates: Partial<Omit<PropertyDefinition, 'name' | 'createdAt'>>
): PropertyDefinition | undefined {
  return db
    .update(propertyDefinitions)
    .set(updates)
    .where(eq(propertyDefinitions.name, name))
    .returning()
    .get()
}

export function deletePropertyDefinition(db: IndexDb, name: string): void {
  db.delete(propertyDefinitions).where(eq(propertyDefinitions.name, name)).run()
}

export function getAllPropertyDefinitions(db: IndexDb): PropertyDefinition[] {
  return db.select().from(propertyDefinitions).all()
}

export function ensurePropertyDefinition(
  db: IndexDb,
  name: string,
  inferredType: PropertyType
): PropertyDefinition {
  const existing = getPropertyDefinition(db, name)
  if (existing) {
    return existing
  }
  const result = insertPropertyDefinition(db, {
    name,
    type: inferredType,
    options: null,
    defaultValue: null,
    color: null
  })
  return result
}

export function getPropertyType(
  db: IndexDb,
  name: string,
  value: unknown,
  inferFn: (name: string, value: unknown) => PropertyType
): PropertyType {
  // Structural override: a value that IS an array of memry:// URIs is a
  // relation, whatever the stored definition claims. Without this, a relation
  // added through the UI is pinned to `text` forever — its first write is the
  // empty default `[]`, `isRelationValue([])` is false, so `inferFn` yields
  // `text` and `ensurePropertyDefinition` writes that definition row. On the
  // next read `deserializeValue(value, 'text')` hands back the raw string, the
  // renderer stops treating the row as a relation, and the following property
  // edit round-trips that string into the vault file — dropping the
  // `property_refs` rows, the graph edge and the backlink with it.
  //
  // Read-time only, deliberately (no stored-definition update):
  //   1. The `property_definitions` table is a derived cache of
  //      `.memry/properties.md` — `PropertyDefinitionsService.rebuildDbCache`
  //      deletes and reinserts the whole table on every reload/upsert, so a row
  //      written here would not survive.
  //   2. `PropertyDefinitionSchema` (contracts/property-types.ts) has no
  //      `relation` member. Persisting one into `.memry/properties.md` makes
  //      the file fail `safeParse`, which drops *every* definition in it.
  //   3. Deriving from the value is idempotent and self-healing: notes already
  //      damaged by the flow above recover on their next index pass, as long as
  //      the YAML array survived. This matches `setPropertyRefs`, which is
  //      likewise purely structural.
  if (isRelationValue(value)) {
    return 'relation'
  }

  const definition = getPropertyDefinition(db, name)
  if (definition) {
    return definition.type as PropertyType
  }
  return inferFn(name, value)
}
