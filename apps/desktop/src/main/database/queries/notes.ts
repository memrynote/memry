/**
 * Note cache query functions for Drizzle ORM.
 * Note-cache queries use index.db; tag definition helpers use data.db.
 *
 * @module db/queries/notes
 */

import { eq, desc, asc, and, like, inArray, sql, count, type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  noteCache,
  noteTags,
  noteLinks,
  noteProperties,
  propertyDefinitions,
  noteSnapshots,
  type NoteCache,
  type NewNoteCache,
  type NoteTag,
  type NewNoteTag,
  type NoteLink,
  type NewNoteLink,
  type NoteProperty,
  type NewNoteProperty,
  type PropertyDefinition,
  type NewPropertyDefinition,
  type PropertyType,
  type NoteSnapshot,
  type NewNoteSnapshot,
  type SnapshotReason
} from '@memry/db-schema/schema/notes-cache'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import * as schema from '@memry/db-schema/schema'

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ============================================================================
// Note Cache CRUD
// ============================================================================

/**
 * Insert a new note into the cache.
 */
export function insertNoteCache(db: DrizzleDb, note: NewNoteCache): NoteCache {
  return db
    .insert(noteCache)
    .values(note)
    .onConflictDoUpdate({
      target: noteCache.id,
      set: {
        path: note.path,
        title: note.title,
        emoji: note.emoji,
        localOnly: note.localOnly,
        contentHash: note.contentHash,
        wordCount: note.wordCount,
        characterCount: note.characterCount,
        snippet: note.snippet,
        date: note.date,
        modifiedAt: note.modifiedAt,
        indexedAt: new Date().toISOString()
      }
    })
    .returning()
    .get()
}

/**
 * Update an existing note in the cache.
 */
export function updateNoteCache(
  db: DrizzleDb,
  id: string,
  updates: Partial<Omit<NoteCache, 'id'>>
): NoteCache | undefined {
  return db
    .update(noteCache)
    .set({
      ...updates,
      indexedAt: new Date().toISOString()
    })
    .where(eq(noteCache.id, id))
    .returning()
    .get()
}

/**
 * Delete a note from the cache.
 */
export function deleteNoteCache(db: DrizzleDb, id: string): void {
  db.delete(noteCache).where(eq(noteCache.id, id)).run()
}

/**
 * Get a note from cache by ID.
 */
export function getNoteCacheById(db: DrizzleDb, id: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.id, id)).get()
}

/**
 * Get a note from cache by path.
 */
export function getNoteCacheByPath(db: DrizzleDb, path: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.path, path)).get()
}

/**
 * Check if a note exists in cache by ID.
 */
export function noteCacheExists(db: DrizzleDb, id: string): boolean {
  const result = db.select({ id: noteCache.id }).from(noteCache).where(eq(noteCache.id, id)).get()
  return result !== undefined
}

export function getLocalOnlyCount(db: DrizzleDb): number {
  const result = db
    .select({ count: count() })
    .from(noteCache)
    .where(eq(noteCache.localOnly, true))
    .get()
  return result?.count ?? 0
}

/**
 * Check if a note exists with a given path but different ID (duplicate detection).
 */
export function findDuplicateId(
  db: DrizzleDb,
  id: string,
  excludePath: string
): NoteCache | undefined {
  return db
    .select()
    .from(noteCache)
    .where(and(eq(noteCache.id, id), sql`${noteCache.path} != ${excludePath}`))
    .get()
}

// ============================================================================
// Note Listing
// ============================================================================

export interface ListNotesOptions {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title' | 'position'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/**
 * List notes from cache with filtering and sorting.
 */
export function listNotesFromCache(db: DrizzleDb, options: ListNotesOptions = {}): NoteCache[] {
  const { folder, tags, sortBy = 'modified', sortOrder = 'desc', limit = 100, offset = 0 } = options

  // Build conditions
  const conditions: SQL<unknown>[] = []

  // Exclude journal entries (they have a date field set)
  conditions.push(sql`${noteCache.date} IS NULL`)

  if (folder) {
    // Match notes in folder (path starts with folder/)
    conditions.push(like(noteCache.path, `${folder}/%`))
  }

  // Get note IDs that have all specified tags
  let noteIdsWithTags: string[] | undefined
  if (tags && tags.length > 0) {
    const tagResults = db
      .select({
        noteId: noteTags.noteId,
        tagCount: sql<number>`count(distinct ${noteTags.tag})`
      })
      .from(noteTags)
      .where(inArray(noteTags.tag, tags))
      .groupBy(noteTags.noteId)
      .all()

    // Filter to notes that have ALL requested tags
    noteIdsWithTags = tagResults.filter((r) => r.tagCount === tags.length).map((r) => r.noteId)

    if (noteIdsWithTags.length === 0) {
      return [] // No notes match all tags
    }

    conditions.push(inArray(noteCache.id, noteIdsWithTags))
  }

  // Build sort order (position sorting is handled at application layer)
  const effectiveSortBy = sortBy === 'position' ? 'modified' : sortBy
  const sortColumn =
    effectiveSortBy === 'modified'
      ? noteCache.modifiedAt
      : effectiveSortBy === 'created'
        ? noteCache.createdAt
        : noteCache.title

  const orderFn = sortOrder === 'asc' ? asc : desc

  let query = db.select().from(noteCache)

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  return query.orderBy(orderFn(sortColumn)).limit(limit).offset(offset).all()
}

/**
 * Count total notes in cache (excludes journal entries).
 */
export function countNotes(db: DrizzleDb, folder?: string): number {
  // Build conditions - always exclude journal entries
  const conditions: SQL<unknown>[] = [sql`${noteCache.date} IS NULL`]

  if (folder) {
    conditions.push(like(noteCache.path, `${folder}/%`))
  }

  const result = db
    .select({ count: count() })
    .from(noteCache)
    .where(and(...conditions))
    .get()

  return result?.count ?? 0
}

// ============================================================================
// Tag Operations
// ============================================================================

/**
 * Set tags for a note (replaces existing tags).
 */
export function setNoteTags(db: DrizzleDb, noteId: string, tags: string[]): void {
  // Delete existing tags
  db.delete(noteTags).where(eq(noteTags.noteId, noteId)).run()

  // Insert new tags with position to preserve insertion order
  if (tags.length > 0) {
    const tagRecords: NewNoteTag[] = tags.map((tag, index) => ({
      noteId,
      tag: tag.toLowerCase().trim(),
      position: index
    }))
    db.insert(noteTags).values(tagRecords).run()
  }
}

/**
 * Get tags for a note.
 */
export function getNoteTags(db: DrizzleDb, noteId: string): string[] {
  const results = db
    .select({ tag: noteTags.tag })
    .from(noteTags)
    .where(eq(noteTags.noteId, noteId))
    .orderBy(noteTags.position)
    .all()

  return results.map((r) => r.tag)
}

/**
 * Get tags for multiple notes in a single batch query.
 * Returns a Map of noteId -> tags array.
 * This is O(1) vs O(n) for calling getNoteTags in a loop.
 */
export function getTagsForNotes(db: DrizzleDb, noteIds: string[]): Map<string, string[]> {
  if (noteIds.length === 0) {
    return new Map()
  }

  const results = db
    .select({
      noteId: noteTags.noteId,
      tag: noteTags.tag
    })
    .from(noteTags)
    .where(inArray(noteTags.noteId, noteIds))
    .all()

  // Group by noteId
  const tagMap = new Map<string, string[]>()

  // Initialize all noteIds with empty arrays
  for (const noteId of noteIds) {
    tagMap.set(noteId, [])
  }

  // Populate with actual tags
  for (const row of results) {
    const tags = tagMap.get(row.noteId)
    if (tags) {
      tags.push(row.tag)
    }
  }

  return tagMap
}

/**
 * Get all unique tags with counts.
 */
export function getAllTags(db: DrizzleDb): { tag: string; count: number }[] {
  return db
    .select({
      tag: noteTags.tag,
      count: count()
    })
    .from(noteTags)
    .groupBy(noteTags.tag)
    .orderBy(desc(count()))
    .all()
    .map((row) => ({ tag: row.tag, count: Number(row.count) }))
}

/**
 * Find notes with a specific tag.
 */
export function findNotesByTag(db: DrizzleDb, tag: string): NoteCache[] {
  const noteIds = db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .where(eq(noteTags.tag, tag.toLowerCase()))
    .all()
    .map((r) => r.noteId)

  if (noteIds.length === 0) {
    return []
  }

  return db.select().from(noteCache).where(inArray(noteCache.id, noteIds)).all()
}

/**
 * Note with tag-specific info (pinned status).
 */
export interface NoteWithTagInfo extends NoteCache {
  isPinned: boolean
  pinnedAt: string | null
}

/**
 * Find notes with a specific tag, including pinned status.
 * Returns pinned notes first (sorted by pinnedAt), then unpinned notes.
 */
export function findNotesWithTagInfo(
  db: DrizzleDb,
  tag: string,
  options: {
    sortBy?: 'modified' | 'created' | 'title'
    sortOrder?: 'asc' | 'desc'
  } = {}
): NoteWithTagInfo[] {
  const { sortBy = 'modified', sortOrder = 'desc' } = options
  const normalizedTag = tag.toLowerCase()

  // Get note IDs and pinned status for this tag
  const tagRecords = db
    .select({
      noteId: noteTags.noteId,
      pinnedAt: noteTags.pinnedAt
    })
    .from(noteTags)
    .where(eq(noteTags.tag, normalizedTag))
    .all()

  if (tagRecords.length === 0) {
    return []
  }

  const noteIds = tagRecords.map((r) => r.noteId)
  const pinnedMap = new Map(tagRecords.map((r) => [r.noteId, r.pinnedAt]))

  // Get the notes
  const notes = db.select().from(noteCache).where(inArray(noteCache.id, noteIds)).all()

  // Add pinned info
  const notesWithInfo: NoteWithTagInfo[] = notes.map((note) => ({
    ...note,
    isPinned: pinnedMap.get(note.id) !== null,
    pinnedAt: pinnedMap.get(note.id) ?? null
  }))

  // Sort: pinned first (by pinnedAt), then rest by specified sort
  const pinned = notesWithInfo.filter((n) => n.isPinned)
  const unpinned = notesWithInfo.filter((n) => !n.isPinned)

  // Sort pinned by pinnedAt
  pinned.sort((a, b) => {
    const aTime = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0
    const bTime = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0
    return aTime - bTime // Oldest pinned first
  })

  // Sort unpinned by specified sort
  const sortFn = (a: NoteCache, b: NoteCache) => {
    let aVal: string | number
    let bVal: string | number

    switch (sortBy) {
      case 'title':
        aVal = a.title.toLowerCase()
        bVal = b.title.toLowerCase()
        break
      case 'created':
        aVal = new Date(a.createdAt).getTime()
        bVal = new Date(b.createdAt).getTime()
        break
      default:
        aVal = new Date(a.modifiedAt).getTime()
        bVal = new Date(b.modifiedAt).getTime()
    }

    if (sortOrder === 'asc') {
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0
    }
    return aVal > bVal ? -1 : aVal < bVal ? 1 : 0
  }

  unpinned.sort(sortFn)

  return [...pinned, ...unpinned]
}

/**
 * Pin a note to a tag.
 */
export function pinNoteToTag(db: DrizzleDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase()
  const now = new Date().toISOString()

  db.update(noteTags)
    .set({ pinnedAt: now })
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

/**
 * Unpin a note from a tag.
 */
export function unpinNoteFromTag(db: DrizzleDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase()

  db.update(noteTags)
    .set({ pinnedAt: null })
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

/**
 * Rename a tag across all notes.
 * Updates note_tags table.
 */
export function renameTag(db: DrizzleDb, oldName: string, newName: string): number {
  const normalizedOld = oldName.toLowerCase().trim()
  const normalizedNew = newName.toLowerCase().trim()

  if (normalizedOld === normalizedNew) {
    return 0
  }

  // Update note_tags
  const result = db
    .update(noteTags)
    .set({ tag: normalizedNew })
    .where(eq(noteTags.tag, normalizedOld))
    .run()

  return result.changes
}

/**
 * Delete a tag from all notes.
 * Removes from note_tags table.
 */
export function deleteTag(db: DrizzleDb, tag: string): number {
  const normalizedTag = tag.toLowerCase().trim()

  // Delete from note_tags
  const result = db.delete(noteTags).where(eq(noteTags.tag, normalizedTag)).run()

  return result.changes
}

/**
 * Remove a tag from a specific note.
 */
export function removeTagFromNote(db: DrizzleDb, noteId: string, tag: string): void {
  const normalizedTag = tag.toLowerCase().trim()

  db.delete(noteTags)
    .where(and(eq(noteTags.noteId, noteId), eq(noteTags.tag, normalizedTag)))
    .run()
}

// ============================================================================
// Tag Definition Operations (vault-wide tag registry with colors)
// ============================================================================

/**
 * 24-color palette for auto-assigning tag colors.
 * Colors are soft pastels from tag-colors.ts.
 */
const TAG_COLOR_PALETTE = [
  'rose',
  'pink',
  'fuchsia',
  'purple',
  'violet',
  'indigo',
  'blue',
  'sky',
  'cyan',
  'teal',
  'emerald',
  'green',
  'lime',
  'yellow',
  'amber',
  'orange',
  'stone',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'warm',
  'red',
  'coral'
]

/**
 * Get or create a tag definition with auto-assigned color.
 * If tag exists, returns existing definition.
 * If new, assigns next color from palette using round-robin.
 */
export function getOrCreateTag(db: DrizzleDb, name: string): { name: string; color: string } {
  const normalizedName = name.toLowerCase().trim()

  // Check if tag already exists
  const existing = db
    .select()
    .from(tagDefinitions)
    .where(eq(tagDefinitions.name, normalizedName))
    .get()

  if (existing) {
    return { name: existing.name, color: existing.color }
  }

  // Get count of existing tags for round-robin color assignment
  const tagCount = db.select({ count: count() }).from(tagDefinitions).get()?.count ?? 0

  const color = TAG_COLOR_PALETTE[tagCount % TAG_COLOR_PALETTE.length]

  // Insert new tag definition
  db.insert(tagDefinitions).values({ name: normalizedName, color }).run()

  return { name: normalizedName, color }
}

/**
 * Get all tag definitions (name + color).
 */
export function getAllTagDefinitions(db: DrizzleDb): { name: string; color: string }[] {
  return db
    .select({
      name: tagDefinitions.name,
      color: tagDefinitions.color
    })
    .from(tagDefinitions)
    .all()
}

/**
 * Update a tag's color.
 */
export function updateTagColor(db: DrizzleDb, name: string, color: string): void {
  const normalizedName = name.toLowerCase().trim()
  db.update(tagDefinitions).set({ color }).where(eq(tagDefinitions.name, normalizedName)).run()
}

/**
 * Rename a tag definition.
 */
export function renameTagDefinition(db: DrizzleDb, oldName: string, newName: string): void {
  const normalizedOld = oldName.toLowerCase().trim()
  const normalizedNew = newName.toLowerCase().trim()

  if (normalizedOld === normalizedNew) {
    return
  }

  const existingNew = db
    .select()
    .from(tagDefinitions)
    .where(eq(tagDefinitions.name, normalizedNew))
    .get()

  if (existingNew) {
    db.delete(tagDefinitions).where(eq(tagDefinitions.name, normalizedOld)).run()
  } else {
    db.update(tagDefinitions)
      .set({ name: normalizedNew })
      .where(eq(tagDefinitions.name, normalizedOld))
      .run()
  }
}

/**
 * Delete a tag definition by name.
 */
export function deleteTagDefinition(db: DrizzleDb, name: string): void {
  const normalizedName = name.toLowerCase().trim()
  db.delete(tagDefinitions).where(eq(tagDefinitions.name, normalizedName)).run()
}

/**
 * Ensure all tags in an array have definitions (create if missing).
 * Returns the tags with their colors.
 */
export function ensureTagDefinitions(
  db: DrizzleDb,
  tags: string[]
): { name: string; color: string }[] {
  const normalized = Array.from(
    new Set(tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean))
  )
  return normalized.map((tag) => getOrCreateTag(db, tag))
}

// ============================================================================
// Link Operations
// ============================================================================

/**
 * Set links for a note (replaces existing links).
 */
export function setNoteLinks(
  db: DrizzleDb,
  sourceId: string,
  links: { targetTitle: string; targetId?: string }[]
): void {
  // Delete existing links from this source
  db.delete(noteLinks).where(eq(noteLinks.sourceId, sourceId)).run()

  // Insert new links
  if (links.length > 0) {
    const linkRecords: NewNoteLink[] = links.map((link) => ({
      sourceId,
      targetId: link.targetId ?? null,
      targetTitle: link.targetTitle
    }))
    db.insert(noteLinks).values(linkRecords).run()
  }
}

/**
 * Get outgoing links from a note.
 */
export function getOutgoingLinks(db: DrizzleDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.sourceId, noteId)).all()
}

/**
 * Get incoming links (backlinks) to a note.
 */
export function getIncomingLinks(db: DrizzleDb, noteId: string): NoteLink[] {
  return db.select().from(noteLinks).where(eq(noteLinks.targetId, noteId)).all()
}

/**
 * Delete links where this note is the target (cleanup orphaned links on note deletion).
 */
export function deleteLinksToNote(db: DrizzleDb, targetId: string): void {
  db.delete(noteLinks).where(eq(noteLinks.targetId, targetId)).run()
}

/**
 * Resolve a link target title to a note ID.
 */
export function resolveNoteByTitle(db: DrizzleDb, title: string): NoteCache | undefined {
  // First try exact title match
  let result = db.select().from(noteCache).where(eq(noteCache.title, title)).get()

  if (result) {
    return result
  }

  // Try case-insensitive title match
  result = db
    .select()
    .from(noteCache)
    .where(sql`lower(${noteCache.title}) = lower(${title})`)
    .get()

  return result
}

/**
 * Resolve multiple wiki link titles to note IDs in a batch.
 * More efficient than resolving one at a time (O(1) vs O(n) database calls).
 *
 * @param db - Database instance
 * @param titles - Array of wiki link titles to resolve
 * @returns Map of title -> { id, path } or null if not found
 */
export function resolveNotesByTitles(
  db: DrizzleDb,
  titles: string[]
): Map<string, { id: string; path: string } | null> {
  if (titles.length === 0) {
    return new Map()
  }

  // Query all notes and filter in memory for case-insensitive matching
  // This is more reliable than trying to construct a complex SQL IN clause
  const normalizedTitles = new Set(titles.map((t) => t.toLowerCase()))

  const allNotes = db
    .select({
      id: noteCache.id,
      path: noteCache.path,
      title: noteCache.title
    })
    .from(noteCache)
    .all()

  // Build result map
  const resultMap = new Map<string, { id: string; path: string } | null>()

  // Initialize all titles with null
  for (const title of titles) {
    resultMap.set(title, null)
  }

  // Find matches (case-insensitive)
  for (const note of allNotes) {
    if (normalizedTitles.has(note.title.toLowerCase())) {
      // Find the original title(s) that match
      for (const title of titles) {
        if (note.title.toLowerCase() === title.toLowerCase()) {
          resultMap.set(title, { id: note.id, path: note.path })
        }
      }
    }
  }

  return resultMap
}

/**
 * Get properties for multiple notes in a single batch query.
 * Returns a Map of noteId -> Record<propertyName, propertyValue>.
 * This is O(1) vs O(n) for calling getNoteProperties in a loop.
 */
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

  // Group by noteId
  const propsMap = new Map<string, Record<string, unknown>>()

  // Initialize all noteIds with empty objects
  for (const noteId of noteIds) {
    propsMap.set(noteId, {})
  }

  // Populate with actual properties
  for (const row of results) {
    const props = propsMap.get(row.noteId)
    if (props) {
      props[row.name] = deserializeValue(row.value, row.type as PropertyType)
    }
  }

  return propsMap
}

/**
 * Update link target IDs after resolving titles.
 */
export function updateLinkTargets(db: DrizzleDb, sourceId: string): void {
  const links = getOutgoingLinks(db, sourceId)

  for (const link of links) {
    if (!link.targetId) {
      const target = resolveNoteByTitle(db, link.targetTitle)
      if (target) {
        db.update(noteLinks)
          .set({ targetId: target.id })
          .where(and(eq(noteLinks.sourceId, sourceId), eq(noteLinks.targetTitle, link.targetTitle)))
          .run()
      }
    }
  }
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Insert multiple notes into cache (for initial indexing).
 */
export function bulkInsertNotes(db: DrizzleDb, notes: NewNoteCache[]): void {
  if (notes.length === 0) return

  // Insert in batches of 100
  const batchSize = 100
  for (let i = 0; i < notes.length; i += batchSize) {
    const batch = notes.slice(i, i + batchSize)
    db.insert(noteCache).values(batch).run()
  }
}

/**
 * Clear all notes from cache (for rebuilding).
 */
export function clearNoteCache(db: DrizzleDb): void {
  db.delete(noteLinks).run()
  db.delete(noteTags).run()
  db.delete(noteCache).run()
}

/**
 * Get all note IDs from cache.
 */
export function getAllNoteIds(db: DrizzleDb): string[] {
  return db
    .select({ id: noteCache.id })
    .from(noteCache)
    .all()
    .map((r) => r.id)
}

/**
 * Get notes that were modified after a certain date.
 */
export function getNotesModifiedAfter(db: DrizzleDb, date: string): NoteCache[] {
  return db
    .select()
    .from(noteCache)
    .where(sql`${noteCache.modifiedAt} > ${date}`)
    .all()
}

// ============================================================================
// Property Operations (T009-T011)
// ============================================================================

/**
 * Property value with type information.
 */
export interface PropertyValue {
  name: string
  value: unknown
  type: PropertyType
}

/**
 * T009: Set properties for a note (replaces existing properties).
 * Follows the same pattern as setNoteTags.
 *
 * @param db - Database instance
 * @param noteId - Note ID
 * @param properties - Properties to set (name -> value mapping)
 * @param getType - Function to get/infer property type
 */
export function setNoteProperties(
  db: DrizzleDb,
  noteId: string,
  properties: Record<string, unknown>,
  getType: (name: string, value: unknown) => PropertyType
): void {
  // Delete existing properties for this note
  db.delete(noteProperties).where(eq(noteProperties.noteId, noteId)).run()

  // Insert new properties
  const entries = Object.entries(properties)

  if (entries.length > 0) {
    const propertyRecords: NewNoteProperty[] = entries.map(([name, value]) => {
      const type = getType(name, value)
      // Ensure property definition exists
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

/**
 * Serialize a property value for database storage.
 */
function serializeValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}

/**
 * T010: Get properties for a note.
 */
export function getNoteProperties(db: DrizzleDb, noteId: string): PropertyValue[] {
  const results = db
    .select()
    .from(noteProperties)
    .where(eq(noteProperties.noteId, noteId))
    // Preserve frontmatter insertion order from setNoteProperties
    .orderBy(sql`rowid`)
    .all()

  return results.map((row) => ({
    name: row.name,
    value: deserializeValue(row.value, row.type as PropertyType),
    type: row.type as PropertyType
  }))
}

/**
 * Deserialize a property value from database storage.
 */
function deserializeValue(value: string | null, type: PropertyType): unknown {
  if (value === null) {
    return null
  }

  switch (type) {
    case 'number':
      return Number(value)
    case 'checkbox':
      return value === 'true'
    default:
      return value
  }
}

/**
 * Get properties for a note as a Record.
 */
export function getNotePropertiesAsRecord(db: DrizzleDb, noteId: string): Record<string, unknown> {
  const properties = getNoteProperties(db, noteId)
  const result: Record<string, unknown> = {}
  for (const prop of properties) {
    result[prop.name] = prop.value
  }
  return result
}

// ============================================================================
// Property Definitions (T011)
// ============================================================================

/**
 * Get a property definition by name.
 */
export function getPropertyDefinition(db: DrizzleDb, name: string): PropertyDefinition | undefined {
  return db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, name)).get()
}

/**
 * Insert a new property definition.
 */
export function insertPropertyDefinition(
  db: DrizzleDb,
  definition: NewPropertyDefinition
): PropertyDefinition {
  return db.insert(propertyDefinitions).values(definition).returning().get()
}

/**
 * Update an existing property definition.
 */
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

/**
 * Delete a property definition.
 */
export function deletePropertyDefinition(db: DrizzleDb, name: string): void {
  db.delete(propertyDefinitions).where(eq(propertyDefinitions.name, name)).run()
}

/**
 * Get all property definitions.
 */
export function getAllPropertyDefinitions(db: DrizzleDb): PropertyDefinition[] {
  return db.select().from(propertyDefinitions).all()
}

/**
 * Ensure a property definition exists.
 * If not found, create one with the inferred type.
 */
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

/**
 * Get the type for a property, using existing definition or inferring.
 */
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

/**
 * Delete all properties for a note.
 */
export function deleteNoteProperties(db: DrizzleDb, noteId: string): void {
  db.delete(noteProperties).where(eq(noteProperties.noteId, noteId)).run()
}

/**
 * Filter notes by property value.
 */
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
// Note Snapshot Operations (T110-T114: Version History)
// ============================================================================

/**
 * Insert a new snapshot for a note.
 */
export function insertNoteSnapshot(db: DrizzleDb, snapshot: NewNoteSnapshot): NoteSnapshot {
  return db.insert(noteSnapshots).values(snapshot).returning().get()
}

/**
 * Get all snapshots for a note, ordered by creation date descending.
 */
export function getNoteSnapshots(db: DrizzleDb, noteId: string, limit = 50): NoteSnapshot[] {
  return db
    .select()
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(limit)
    .all()
}

/**
 * Get a single snapshot by ID.
 */
export function getNoteSnapshotById(db: DrizzleDb, snapshotId: string): NoteSnapshot | undefined {
  return db.select().from(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).get()
}

/**
 * Get the most recent snapshot for a note.
 */
export function getLatestSnapshot(db: DrizzleDb, noteId: string): NoteSnapshot | undefined {
  return db
    .select()
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(1)
    .get()
}

/**
 * Check if a snapshot with this content hash already exists for this note.
 * Used for deduplication - no point saving identical versions.
 */
export function snapshotExistsWithHash(
  db: DrizzleDb,
  noteId: string,
  contentHash: string
): boolean {
  const result = db
    .select({ id: noteSnapshots.id })
    .from(noteSnapshots)
    .where(and(eq(noteSnapshots.noteId, noteId), eq(noteSnapshots.contentHash, contentHash)))
    .limit(1)
    .get()
  return result !== undefined
}

/**
 * Delete a snapshot by ID.
 */
export function deleteNoteSnapshot(db: DrizzleDb, snapshotId: string): void {
  db.delete(noteSnapshots).where(eq(noteSnapshots.id, snapshotId)).run()
}

/**
 * Delete all snapshots for a note.
 */
export function deleteNoteSnapshots(db: DrizzleDb, noteId: string): void {
  db.delete(noteSnapshots).where(eq(noteSnapshots.noteId, noteId)).run()
}

/**
 * Count snapshots for a note.
 */
export function countNoteSnapshots(db: DrizzleDb, noteId: string): number {
  const result = db
    .select({ count: count() })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .get()
  return result?.count ?? 0
}

/**
 * Prune old snapshots for a note, keeping only the most recent N.
 * This helps manage storage for frequently edited notes.
 */
export function pruneOldSnapshots(db: DrizzleDb, noteId: string, keepCount: number): number {
  // Get IDs of snapshots to keep
  const snapshotsToKeep = db
    .select({ id: noteSnapshots.id })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.createdAt))
    .limit(keepCount)
    .all()
    .map((s) => s.id)

  if (snapshotsToKeep.length === 0) {
    return 0
  }

  // Delete all other snapshots for this note
  const allSnapshots = db
    .select({ id: noteSnapshots.id })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .all()

  const toDelete = allSnapshots.filter((s) => !snapshotsToKeep.includes(s.id))

  if (toDelete.length > 0) {
    db.delete(noteSnapshots)
      .where(
        inArray(
          noteSnapshots.id,
          toDelete.map((s) => s.id)
        )
      )
      .run()
  }

  return toDelete.length
}

/**
 * Get snapshot statistics for a note.
 */
export function getNoteSnapshotStats(
  db: DrizzleDb,
  noteId: string
): { count: number; oldestDate: string | null; newestDate: string | null } {
  const snapshots = db
    .select({ createdAt: noteSnapshots.createdAt })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(asc(noteSnapshots.createdAt))
    .all()

  if (snapshots.length === 0) {
    return { count: 0, oldestDate: null, newestDate: null }
  }

  return {
    count: snapshots.length,
    oldestDate: snapshots[0].createdAt,
    newestDate: snapshots[snapshots.length - 1].createdAt
  }
}

// Re-export types for external use
export type {
  NoteCache,
  NewNoteCache,
  NoteTag,
  NewNoteTag,
  NoteLink,
  NewNoteLink,
  NoteProperty,
  NewNoteProperty,
  PropertyDefinition,
  NewPropertyDefinition,
  PropertyType,
  NoteSnapshot,
  NewNoteSnapshot,
  SnapshotReason
}

// ============================================================================
// Journal Entry Utilities (Unified Infrastructure)
// ============================================================================
// Journal entries are notes stored in the journal/ folder with date-based naming.
// These utilities provide journal-specific operations on the unified note_cache table.

export const JOURNAL_PATH_PREFIX = 'journal/'
export const JOURNAL_DATE_PATTERN = /^journal\/(\d{4}-\d{2}-\d{2})\.md$/

/**
 * Check if a path represents a journal entry.
 * Journal entries are stored at journal/YYYY-MM-DD.md
 */
export function isJournalEntry(path: string): boolean {
  return JOURNAL_DATE_PATTERN.test(path)
}

/**
 * Extract date from a journal entry path.
 * @returns YYYY-MM-DD or null if not a journal path
 */
export function extractDateFromPath(path: string): string | null {
  const match = path.match(JOURNAL_DATE_PATTERN)
  return match ? match[1] : null
}

/**
 * Generate journal path from date.
 * @param date - YYYY-MM-DD format
 */
export function generateJournalPath(date: string): string {
  return `journal/${date}.md`
}

/**
 * Generate journal entry ID from date.
 * Format: j{YYYY-MM-DD} for backward compatibility with existing data.
 */
export function generateJournalId(date: string): string {
  return `j${date}`
}

/**
 * Activity level type for heatmap display.
 * 0 = empty, 1 = minimal, 2 = light, 3 = moderate, 4 = heavy
 */
export type ActivityLevel = 0 | 1 | 2 | 3 | 4

/**
 * Calculate activity level from character count.
 * Used for heatmap display - computed on-demand, not stored.
 */
export function calculateActivityLevel(characterCount: number): ActivityLevel {
  if (characterCount === 0) return 0
  if (characterCount <= 100) return 1
  if (characterCount <= 500) return 2
  if (characterCount <= 1000) return 3
  return 4
}

// ============================================================================
// Journal Cache Queries (using unified note_cache table)
// ============================================================================

/**
 * Get a journal entry by date.
 * Uses the date column in note_cache.
 */
export function getJournalEntryByDate(db: DrizzleDb, date: string): NoteCache | undefined {
  return db.select().from(noteCache).where(eq(noteCache.date, date)).get()
}

/**
 * Check if a journal entry exists for a date.
 */
export function journalEntryExistsByDate(db: DrizzleDb, date: string): boolean {
  const result = db
    .select({ id: noteCache.id })
    .from(noteCache)
    .where(eq(noteCache.date, date))
    .get()
  return result !== undefined
}

/**
 * Get heatmap data for a year.
 * Returns entries with date, characterCount, and computed activity level.
 *
 * Performance: Optimized for <50ms with 365+ entries using:
 * - Range query instead of LIKE for better index utilization
 * - Only selecting required columns
 * - idx_note_cache_date index
 */
export function getHeatmapData(
  db: DrizzleDb,
  year: number
): { date: string; characterCount: number; level: ActivityLevel }[] {
  // Use range query for better index utilization
  // Range: 'YYYY-01-01' <= date <= 'YYYY-12-31'
  const startDate = `${year}-01-01`
  const endDate = `${year}-12-31`

  return db
    .select({
      date: noteCache.date,
      characterCount: noteCache.characterCount
    })
    .from(noteCache)
    .where(
      and(
        sql`${noteCache.date} IS NOT NULL`,
        sql`${noteCache.date} >= ${startDate}`,
        sql`${noteCache.date} <= ${endDate}`
      )
    )
    .orderBy(noteCache.date)
    .all()
    .map((row) => ({
      date: row.date!,
      characterCount: row.characterCount ?? 0,
      level: calculateActivityLevel(row.characterCount ?? 0)
    }))
}

/**
 * Get journal entries for a specific month.
 * Used for month view display.
 */
export function getJournalMonthEntries(db: DrizzleDb, year: number, month: number): NoteCache[] {
  const monthStr = String(month).padStart(2, '0')
  const monthPrefix = `${year}-${monthStr}-`
  return db
    .select()
    .from(noteCache)
    .where(and(sql`${noteCache.date} IS NOT NULL`, like(noteCache.date, `${monthPrefix}%`)))
    .orderBy(desc(noteCache.date))
    .all()
}

/**
 * Get statistics for each month in a year.
 * Used for year view display.
 */
export function getJournalYearStats(
  db: DrizzleDb,
  year: number
): {
  month: number
  entryCount: number
  totalWordCount: number
  totalCharacterCount: number
  averageLevel: number
}[] {
  const yearPrefix = `${year}-`

  return db
    .select({
      month: sql<number>`CAST(substr(${noteCache.date}, 6, 2) AS INTEGER)`,
      entryCount: sql<number>`COUNT(*)`,
      totalWordCount: sql<number>`COALESCE(SUM(${noteCache.wordCount}), 0)`,
      totalCharacterCount: sql<number>`COALESCE(SUM(${noteCache.characterCount}), 0)`,
      averageLevel: sql<number>`COALESCE(AVG(CASE
        WHEN ${noteCache.characterCount} = 0 THEN 0
        WHEN ${noteCache.characterCount} <= 100 THEN 1
        WHEN ${noteCache.characterCount} <= 500 THEN 2
        WHEN ${noteCache.characterCount} <= 1000 THEN 3
        ELSE 4
      END), 0)`
    })
    .from(noteCache)
    .where(and(sql`${noteCache.date} IS NOT NULL`, like(noteCache.date, `${yearPrefix}%`)))
    .groupBy(sql`substr(${noteCache.date}, 6, 2)`)
    .all()
    .map((e) => ({
      month: e.month,
      entryCount: e.entryCount,
      totalWordCount: e.totalWordCount,
      totalCharacterCount: e.totalCharacterCount,
      averageLevel: Math.round(e.averageLevel * 100) / 100
    }))
}

/**
 * Calculate current and longest journaling streak.
 * A streak is consecutive days with journal entries.
 */
export function getJournalStreak(db: DrizzleDb): {
  currentStreak: number
  longestStreak: number
  lastEntryDate: string | null
} {
  // Get all entry dates in descending order (only journal entries)
  const entries = db
    .select({ date: noteCache.date })
    .from(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .orderBy(desc(noteCache.date))
    .all()

  if (entries.length === 0) {
    return { currentStreak: 0, longestStreak: 0, lastEntryDate: null }
  }

  const lastEntryDate = entries[0].date!
  const dates = new Set(entries.map((e) => e.date!))

  // Calculate current streak (from today or last entry backwards)
  const formatDateUtc = (date: Date) => date.toISOString().slice(0, 10)
  const addDaysUtc = (dateStr: string, delta: number) => {
    const date = new Date(`${dateStr}T00:00:00.000Z`)
    date.setUTCDate(date.getUTCDate() + delta)
    return formatDateUtc(date)
  }

  let currentStreak = 0
  const todayStr = formatDateUtc(new Date())
  let checkDateStr: string | null = todayStr

  if (!dates.has(todayStr)) {
    const yesterdayStr = addDaysUtc(todayStr, -1)
    checkDateStr = dates.has(yesterdayStr) ? yesterdayStr : null
  }

  if (checkDateStr) {
    let cursor = checkDateStr
    while (dates.has(cursor)) {
      currentStreak++
      cursor = addDaysUtc(cursor, -1)
    }
  }

  // Calculate longest streak
  let longestStreak = 0
  let tempStreak = 0
  let prevDate: Date | null = null

  // Sort dates ascending for longest streak calculation
  const sortedDates = Array.from(dates).sort()

  for (const dateStr of sortedDates) {
    const currentDate = new Date(dateStr + 'T00:00:00.000Z')

    if (prevDate === null) {
      tempStreak = 1
    } else {
      const diffDays = Math.round(
        (currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
      )

      if (diffDays === 1) {
        tempStreak++
      } else {
        tempStreak = 1
      }
    }

    longestStreak = Math.max(longestStreak, tempStreak)
    prevDate = currentDate
  }

  return { currentStreak, longestStreak, lastEntryDate }
}

/**
 * List all journal entries (for calendar views).
 * Returns entries with date field populated (journal entries only).
 */
export function listJournalEntries(db: DrizzleDb): NoteCache[] {
  return db
    .select()
    .from(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .orderBy(desc(noteCache.date))
    .all()
}

/**
 * Count total journal entries.
 */
export function countJournalEntries(db: DrizzleDb): number {
  const result = db
    .select({ count: count() })
    .from(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .get()
  return result?.count ?? 0
}

/**
 * Clear journal entries from cache (for rebuild).
 * Only deletes entries with date field set (journal entries).
 */
export function clearJournalCache(db: DrizzleDb): void {
  db.delete(noteCache)
    .where(sql`${noteCache.date} IS NOT NULL`)
    .run()
}

/**
 * Infer property type from value.
 * Used for journal properties.
 */
export function inferPropertyType(value: unknown): PropertyType {
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  // Arrays are no longer supported, fallback to text
  if (Array.isArray(value)) return 'text'
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date'
    if (/^https?:\/\//.test(value)) return 'url'
  }
  return 'text'
}
