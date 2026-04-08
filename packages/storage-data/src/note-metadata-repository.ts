import { and, asc, count, desc, eq, like, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  noteMetadata,
  propertyDefinitions,
  type NewNoteMetadata,
  type NoteMetadata,
  type PropertyDefinition,
  type NewPropertyDefinition
} from '@memry/db-schema/data-schema'
import type * as dataSchema from '@memry/db-schema/data-schema'

export type NoteMetadataDb = BetterSQLite3Database<typeof dataSchema>

export interface ListCanonicalNoteMetadataOptions {
  folder?: string
  journalOnly?: boolean
  sortBy?: 'modified' | 'created' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export function upsertNoteMetadata(db: NoteMetadataDb, metadata: NewNoteMetadata): NoteMetadata {
  return db
    .insert(noteMetadata)
    .values(metadata)
    .onConflictDoUpdate({
      target: noteMetadata.id,
      set: {
        path: metadata.path,
        title: metadata.title,
        emoji: metadata.emoji,
        fileType: metadata.fileType,
        mimeType: metadata.mimeType,
        fileSize: metadata.fileSize,
        attachmentId: metadata.attachmentId,
        attachmentReferences: metadata.attachmentReferences,
        localOnly: metadata.localOnly,
        syncPolicy: metadata.syncPolicy,
        journalDate: metadata.journalDate,
        propertyDefinitionNames: metadata.propertyDefinitionNames,
        clock: metadata.clock,
        syncedAt: metadata.syncedAt,
        createdAt: metadata.createdAt,
        modifiedAt: metadata.modifiedAt,
        storedAt: new Date().toISOString()
      }
    })
    .returning()
    .get()
}

export function updateNoteMetadata(
  db: NoteMetadataDb,
  id: string,
  updates: Partial<Omit<NoteMetadata, 'id'>>
): NoteMetadata | undefined {
  return db
    .update(noteMetadata)
    .set({
      ...updates,
      storedAt: new Date().toISOString()
    })
    .where(eq(noteMetadata.id, id))
    .returning()
    .get()
}

export function deleteNoteMetadata(db: NoteMetadataDb, id: string): void {
  db.delete(noteMetadata).where(eq(noteMetadata.id, id)).run()
}

export function getNoteMetadataById(db: NoteMetadataDb, id: string): NoteMetadata | undefined {
  return db.select().from(noteMetadata).where(eq(noteMetadata.id, id)).get()
}

export function getNoteMetadataByPath(
  db: NoteMetadataDb,
  canonicalPath: string
): NoteMetadata | undefined {
  return db.select().from(noteMetadata).where(eq(noteMetadata.path, canonicalPath)).get()
}

export function getJournalNoteMetadataByDate(
  db: NoteMetadataDb,
  journalDate: string
): NoteMetadata | undefined {
  return db.select().from(noteMetadata).where(eq(noteMetadata.journalDate, journalDate)).get()
}

export function listNoteMetadata(
  db: NoteMetadataDb,
  options: ListCanonicalNoteMetadataOptions = {}
): NoteMetadata[] {
  const { folder, journalOnly = false, sortBy = 'modified', sortOrder = 'desc' } = options
  const limit = options.limit ?? 100
  const offset = options.offset ?? 0
  const conditions: SQL<unknown>[] = []

  if (journalOnly) {
    conditions.push(like(noteMetadata.path, 'journal/%'))
  } else {
    conditions.push(like(noteMetadata.path, 'notes/%'))
  }

  if (folder) {
    const normalized = folder.replace(/^\/+|\/+$/g, '')
    if (normalized.length > 0) {
      conditions.push(like(noteMetadata.path, `notes/${normalized}/%`))
    }
  }

  const sortColumn =
    sortBy === 'created'
      ? noteMetadata.createdAt
      : sortBy === 'title'
        ? noteMetadata.title
        : noteMetadata.modifiedAt

  const orderFn = sortOrder === 'asc' ? asc : desc
  let query = db.select().from(noteMetadata)

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  return query.orderBy(orderFn(sortColumn)).limit(limit).offset(offset).all()
}

export function countLocalOnlyNoteMetadata(db: NoteMetadataDb): number {
  const result = db
    .select({ count: count() })
    .from(noteMetadata)
    .where(eq(noteMetadata.localOnly, true))
    .get()
  return result?.count ?? 0
}

export function getPropertyDefinition(
  db: NoteMetadataDb,
  name: string
): PropertyDefinition | undefined {
  return db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, name)).get()
}

export function upsertPropertyDefinition(
  db: NoteMetadataDb,
  definition: NewPropertyDefinition
): PropertyDefinition {
  return db
    .insert(propertyDefinitions)
    .values(definition)
    .onConflictDoUpdate({
      target: propertyDefinitions.name,
      set: {
        type: definition.type,
        options: definition.options,
        defaultValue: definition.defaultValue,
        color: definition.color
      }
    })
    .returning()
    .get()
}

export function listPropertyDefinitions(db: NoteMetadataDb): PropertyDefinition[] {
  return db.select().from(propertyDefinitions).orderBy(asc(propertyDefinitions.name)).all()
}

export function deletePropertyDefinition(db: NoteMetadataDb, name: string): void {
  db.delete(propertyDefinitions).where(eq(propertyDefinitions.name, name)).run()
}
