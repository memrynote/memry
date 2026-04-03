import { eq, and, inArray, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
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
import * as schema from '@memry/db-schema/schema'
import { serializeValue, deserializeValue } from './query-helpers'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Property Value Operations
// ============================================================================

export interface PropertyValue {
  name: string
  value: unknown
  type: PropertyType
}

export function setNoteProperties(
  db: DrizzleDb,
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
}

export function getNoteProperties(db: DrizzleDb, noteId: string): PropertyValue[] {
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

export function getNotePropertiesAsRecord(db: DrizzleDb, noteId: string): Record<string, unknown> {
  const properties = getNoteProperties(db, noteId)
  const result: Record<string, unknown> = {}
  for (const prop of properties) {
    result[prop.name] = prop.value
  }
  return result
}

export function getPropertiesForNotes(
  db: DrizzleDb,
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

export function deleteNoteProperties(db: DrizzleDb, noteId: string): void {
  db.delete(noteProperties).where(eq(noteProperties.noteId, noteId)).run()
}

export function filterNotesByProperty(
  db: DrizzleDb,
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

export function getPropertyDefinition(db: DrizzleDb, name: string): PropertyDefinition | undefined {
  return db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, name)).get()
}

export function insertPropertyDefinition(
  db: DrizzleDb,
  definition: NewPropertyDefinition
): PropertyDefinition {
  return db.insert(propertyDefinitions).values(definition).returning().get()
}

export function updatePropertyDefinition(
  db: DrizzleDb,
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

export function deletePropertyDefinition(db: DrizzleDb, name: string): void {
  db.delete(propertyDefinitions).where(eq(propertyDefinitions.name, name)).run()
}

export function getAllPropertyDefinitions(db: DrizzleDb): PropertyDefinition[] {
  return db.select().from(propertyDefinitions).all()
}

export function ensurePropertyDefinition(
  db: DrizzleDb,
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
  db: DrizzleDb,
  name: string,
  value: unknown,
  inferFn: (name: string, value: unknown) => PropertyType
): PropertyType {
  const definition = getPropertyDefinition(db, name)
  if (definition) {
    return definition.type as PropertyType
  }
  return inferFn(name, value)
}
