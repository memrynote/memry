import { count } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { tagKey } from '@memry/shared/tag-fold'
import type { ViewConfig } from '@memry/contracts/folder-view-api'
import { createLogger } from '../../lib/logger'
import { trackMainEvent } from '../../telemetry/track'
import type { DataDb } from '../types'
import { tagIs, tagUnder } from './tag-match'
import type { DrizzleDb } from '@memry/db-schema/drizzle-db'

const logger = createLogger('TagDefinitions')

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

export function getOrCreateTag(
  db: DataDb,
  name: string
): {
  name: string
  color: string
  icon: string | null
  categoryId: string | null
  sortOrder: number
} {
  const existing = db
    .select()
    .from(tagDefinitions)
    .where(tagIs(tagDefinitions.name, name.trim()))
    .get()

  if (existing) {
    return {
      name: existing.name,
      color: existing.color,
      icon: existing.icon,
      categoryId: existing.categoryId,
      sortOrder: existing.sortOrder
    }
  }

  // Indexing by local tag count means the same tag name gets a different colour
  // on every device (green as the 12th tag, red as the 23rd). That is fine as a
  // local starting point but it is nobody's choice, so it is minted unauthored:
  // it may never repaint the same tag on another device. See
  // tag-definition-handler.ts.
  const tagCount = db.select({ count: count() }).from(tagDefinitions).get()?.count ?? 0
  const color = TAG_COLOR_PALETTE[tagCount % TAG_COLOR_PALETTE.length]

  // Stored with the caller's casing, matched without it: every lookup compares
  // `tag_fold(name)` (tag-match.ts), so `Ünal` and `ünal` are one row; the row
  // just remembers how the tag was first written. For a tag that no
  // note uses yet — one created from the tag hub — this row is the only place
  // the display name exists, since `getAllTagsWithCounts` otherwise takes it
  // from usage. Only inserts are affected: an existing row's casing is never
  // rewritten, so nothing re-emits to sync.
  const displayName = name.trim()
  db.insert(tagDefinitions).values({ name: displayName, color, colorAuthored: false }).run()

  // Insert branch only — the get branch above returns without emitting.
  trackMainEvent('tag_created', {
    surface: 'tags',
    action: 'created',
    objectType: 'tag',
    result: 'success'
  })

  return { name: displayName, color, icon: null, categoryId: null, sortOrder: 0 }
}

/** The definition row for `tag`, in any spelling. */
export function findTagDefinition(db: DrizzleDb, tag: string) {
  return db.select().from(tagDefinitions).where(tagIs(tagDefinitions.name, tag.trim())).get()
}

export function getAllTagDefinitions(db: DataDb): {
  name: string
  color: string
  colorAuthored: boolean
  icon: string | null
  categoryId: string | null
  sortOrder: number
  schema: string | null
}[] {
  return db
    .select({
      name: tagDefinitions.name,
      color: tagDefinitions.color,
      colorAuthored: tagDefinitions.colorAuthored,
      icon: tagDefinitions.icon,
      categoryId: tagDefinitions.categoryId,
      sortOrder: tagDefinitions.sortOrder,
      schema: tagDefinitions.schema
    })
    .from(tagDefinitions)
    .all()
}

export function setTagCategory(db: DataDb, name: string, categoryId: string | null): void {
  db.update(tagDefinitions).set({ categoryId }).where(tagIs(tagDefinitions.name, name.trim())).run()
}

/**
 * The only path by which a human picks a tag colour (tags:update-color, which the
 * colour picker and the create-tag dialog both use), so this is where the colour
 * becomes authored and starts outranking auto-minted colours on other devices.
 */
export function updateTagColor(db: DataDb, name: string, color: string): void {
  db.update(tagDefinitions)
    .set({ color, colorAuthored: true })
    .where(tagIs(tagDefinitions.name, name.trim()))
    .run()
}

export function updateTagIcon(db: DataDb, name: string, icon: string | null): void {
  db.update(tagDefinitions).set({ icon }).where(tagIs(tagDefinitions.name, name.trim())).run()
}

/**
 * Moves one definition row to `newName`, or drops it when `newName` already has
 * one (a merge: the target keeps its own). Children are separate rows; the
 * caller moves each (`tags/rename-tag.ts`).
 */
export function renameTagDefinition(db: DataDb, oldName: string, newName: string): void {
  const normalizedNew = tagKey(newName)

  if (tagKey(oldName) === normalizedNew) return

  const existingNew = db
    .select()
    .from(tagDefinitions)
    .where(tagIs(tagDefinitions.name, normalizedNew))
    .get()

  if (existingNew) {
    db.delete(tagDefinitions).where(tagIs(tagDefinitions.name, oldName.trim())).run()
  } else {
    db.update(tagDefinitions)
      .set({ name: normalizedNew })
      .where(tagIs(tagDefinitions.name, oldName.trim()))
      .run()
  }
}

export function deleteTagDefinition(
  db: DataDb,
  name: string,
  options: { cascade?: boolean } = {}
): void {
  db.delete(tagDefinitions).where(tagIs(tagDefinitions.name, name.trim())).run()

  if (options.cascade) {
    db.delete(tagDefinitions).where(tagUnder(tagDefinitions.name, name.trim())).run()
  }
}

/**
 * Saved folder-view configurations for a tag.
 *
 * Folders keep theirs in `.folder.md`; a tag has no directory, so they live
 * on the tag_definitions row and sync with the tag definition itself.
 * Corrupt JSON reads as "no saved views" rather than throwing — a bad blob
 * must not make the tag unopenable.
 */
export function readTagViews(db: DrizzleDb, tag: string): ViewConfig[] | null {
  const row = db
    .select({ views: tagDefinitions.views })
    .from(tagDefinitions)
    .where(tagIs(tagDefinitions.name, tag))
    .get()

  if (!row?.views) return null
  try {
    const parsed = JSON.parse(row.views)
    return Array.isArray(parsed) ? (parsed as ViewConfig[]) : null
  } catch {
    logger.warn('Discarding corrupt saved views for tag', { tag })
    return null
  }
}

/** `null` empties the column, which a push leaves out; `[]` is pushed, so peers clear theirs too. */
export function writeTagViews(db: DrizzleDb, tag: string, views: ViewConfig[] | null): void {
  db.update(tagDefinitions)
    .set({ views: views === null ? null : JSON.stringify(views) })
    .where(tagIs(tagDefinitions.name, tag))
    .run()
}

export function ensureTagDefinitions(
  db: DataDb,
  tags: string[]
): { name: string; color: string }[] {
  const normalized = Array.from(new Set(tags.map(tagKey).filter(Boolean)))

  return normalized.map((tag) => getOrCreateTag(db, tag))
}

/** Every definition row with its raw `schema` column, for schema resolution. */
export function listTagDefinitionRows(
  db: DataDb
): { name: string; color: string; icon: string | null; schema: string | null }[] {
  return db
    .select({
      name: tagDefinitions.name,
      color: tagDefinitions.color,
      icon: tagDefinitions.icon,
      schema: tagDefinitions.schema
    })
    .from(tagDefinitions)
    .all()
}

export function readTagSchemaColumn(db: DrizzleDb, tag: string): string | null {
  return (
    db
      .select({ schema: tagDefinitions.schema })
      .from(tagDefinitions)
      .where(tagIs(tagDefinitions.name, tag))
      .get()?.schema ?? null
  )
}

export function writeTagSchemaColumn(db: DrizzleDb, tag: string, schema: string): void {
  db.update(tagDefinitions).set({ schema }).where(tagIs(tagDefinitions.name, tag)).run()
}
