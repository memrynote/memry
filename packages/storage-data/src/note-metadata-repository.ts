import { and, asc, count, desc, eq, like, notLike, type SQL } from 'drizzle-orm'
import {
  noteMetadata,
  propertyDefinitions,
  type NewNoteMetadata,
  type NoteMetadata,
  type PropertyDefinition,
  type NewPropertyDefinition
} from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/db-schema/drizzle-db'

export type NoteMetadataDb = DrizzleDb

export interface ListCanonicalNoteMetadataOptions {
  folder?: string
  journalOnly?: boolean
  sortBy?: 'modified' | 'created' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

function trimPathSlashes(value: string): string {
  let start = 0
  let end = value.length

  while (start < end && value[start] === '/') {
    start += 1
  }

  while (end > start && value[end - 1] === '/') {
    end -= 1
  }

  return value.slice(start, end)
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
        // createdAt intentionally omitted: preserve the original value on
        // conflict (matches insertNoteCache in the index DB)
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
    // Flat vault root (#571): regular notes live anywhere except journal/, not just
    // under notes/. Match "not a journal note" so root- and custom-folder notes list.
    conditions.push(notLike(noteMetadata.path, 'journal/%'))
  }

  if (folder) {
    // `folder` is a full vault-relative folder prefix (callers prepend the configured
    // note root, e.g. 'notes/sub' or — for a flat vault root — 'Projects'). Don't assume
    // a 'notes/' prefix here, or flat-vault notes never match.
    const normalized = trimPathSlashes(folder)
    if (normalized.length > 0) {
      conditions.push(like(noteMetadata.path, `${normalized}/%`))
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
