import { and, asc, count, desc, eq, like, notLike, sql, type SQL } from 'drizzle-orm'
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

/**
 * A note path as a case-insensitive file system compares it. APFS and NTFS
 * fold Unicode case, and APFS also ignores normalization, so `Ärzte/a.md` and
 * `ärzte/a.md` name one file there. Folding only finds candidates: the caller
 * proves each one against the disk.
 */
export function foldNotePath(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

/**
 * Candidate row ids by folded path, for one database connection. A cache of
 * `note_metadata`, never an answer: it only grows between rebuilds, so a
 * rolled-back write or a deleted row leaves a stale id that the read filters
 * out, and a live row is never missing from it.
 */
interface FoldedPathIndex {
  /** `PRAGMA data_version` at build: it moves when another connection commits. */
  dataVersion: number
  idsByKey: Map<string, Set<string>>
}

const foldedPathIndexes = new WeakMap<object, FoldedPathIndex>()

/**
 * The connection a database or a transaction writes through. Drizzle gives a
 * transaction its own object over the same client, and a write inside one has
 * to reach the index the outer database reads.
 */
function connectionOf(db: NoteMetadataDb): object {
  if (!('session' in db)) return db
  const { session } = db
  if (typeof session !== 'object' || session === null || !('client' in session)) return db
  const { client } = session
  return typeof client === 'object' && client !== null ? client : db
}

function trackPath(index: FoldedPathIndex, id: string, path: string): void {
  const key = foldNotePath(path)
  const ids = index.idsByKey.get(key)
  if (ids) ids.add(id)
  else index.idsByKey.set(key, new Set([id]))
}

function recordPathWrite(db: NoteMetadataDb, row: NoteMetadata | undefined): void {
  const index = foldedPathIndexes.get(connectionOf(db))
  if (index && row) trackPath(index, row.id, row.path)
}

/**
 * Every row whose path folds to the same key as `path`, `path` itself
 * included. Each candidate is read back by id, so the rows come from the
 * table, not the index.
 *
 * The index is built from one table read on first use, then extended by this
 * module's writes, so a miss costs a map lookup instead of a table scan per
 * file. A commit by another connection (the CLI) rebuilds it. A write to
 * `note_metadata` on this connection that bypasses this module would be
 * missed until the next rebuild.
 */
export function listNoteMetadataByFoldedPath(db: NoteMetadataDb, path: string): NoteMetadata[] {
  const connection = connectionOf(db)
  const dataVersion = db.get<{ data_version: number }>(sql`PRAGMA data_version`)?.data_version ?? 0
  let index = foldedPathIndexes.get(connection)
  if (!index || index.dataVersion !== dataVersion) {
    index = { dataVersion, idsByKey: new Map() }
    for (const row of db
      .select({ id: noteMetadata.id, path: noteMetadata.path })
      .from(noteMetadata)
      .all()) {
      trackPath(index, row.id, row.path)
    }
    foldedPathIndexes.set(connection, index)
  }
  const key = foldNotePath(path)
  return [...(index.idsByKey.get(key) ?? [])]
    .map((id) => getNoteMetadataById(db, id))
    .filter((row): row is NoteMetadata => row !== undefined && foldNotePath(row.path) === key)
}

export function upsertNoteMetadata(db: NoteMetadataDb, metadata: NewNoteMetadata): NoteMetadata {
  const row = db
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
  recordPathWrite(db, row)
  return row
}

export function updateNoteMetadata(
  db: NoteMetadataDb,
  id: string,
  updates: Partial<Omit<NoteMetadata, 'id'>>
): NoteMetadata | undefined {
  const row = db
    .update(noteMetadata)
    .set({
      ...updates,
      storedAt: new Date().toISOString()
    })
    .where(eq(noteMetadata.id, id))
    .returning()
    .get()
  recordPathWrite(db, row)
  return row
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
  const conditions: SQL[] = []

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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- drizzle's where() returns a different builder type than the dynamic query it replaces; the cast keeps the original type for the reassignment
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
