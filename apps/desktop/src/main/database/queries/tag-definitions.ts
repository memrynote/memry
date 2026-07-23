import { count, eq, like } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import type { DataDb } from '../types'

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
  const normalizedName = name.toLowerCase().trim()

  const existing = db
    .select()
    .from(tagDefinitions)
    .where(eq(tagDefinitions.name, normalizedName))
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

  const tagCount = db.select({ count: count() }).from(tagDefinitions).get()?.count ?? 0
  const color = TAG_COLOR_PALETTE[tagCount % TAG_COLOR_PALETTE.length]

  db.insert(tagDefinitions).values({ name: normalizedName, color }).run()

  return { name: normalizedName, color, icon: null, categoryId: null, sortOrder: 0 }
}

export function getAllTagDefinitions(db: DataDb): {
  name: string
  color: string
  icon: string | null
  categoryId: string | null
  sortOrder: number
}[] {
  return db
    .select({
      name: tagDefinitions.name,
      color: tagDefinitions.color,
      icon: tagDefinitions.icon,
      categoryId: tagDefinitions.categoryId,
      sortOrder: tagDefinitions.sortOrder
    })
    .from(tagDefinitions)
    .all()
}

export function setTagCategory(db: DataDb, name: string, categoryId: string | null): void {
  db.update(tagDefinitions)
    .set({ categoryId })
    .where(eq(tagDefinitions.name, name.toLowerCase().trim()))
    .run()
}

export function updateTagColor(db: DataDb, name: string, color: string): void {
  const normalizedName = name.toLowerCase().trim()
  db.update(tagDefinitions).set({ color }).where(eq(tagDefinitions.name, normalizedName)).run()
}

export function updateTagIcon(db: DataDb, name: string, icon: string | null): void {
  const normalizedName = name.toLowerCase().trim()
  db.update(tagDefinitions).set({ icon }).where(eq(tagDefinitions.name, normalizedName)).run()
}

export function renameTagDefinition(db: DataDb, oldName: string, newName: string): void {
  const normalizedOld = oldName.toLowerCase().trim()
  const normalizedNew = newName.toLowerCase().trim()

  if (normalizedOld === normalizedNew) return

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

  const children = db
    .select({ name: tagDefinitions.name })
    .from(tagDefinitions)
    .where(like(tagDefinitions.name, `${normalizedOld}/%`))
    .all()

  for (const child of children) {
    const newChildName = normalizedNew + child.name.slice(normalizedOld.length)
    const existingChild = db
      .select()
      .from(tagDefinitions)
      .where(eq(tagDefinitions.name, newChildName))
      .get()

    if (existingChild) {
      db.delete(tagDefinitions).where(eq(tagDefinitions.name, child.name)).run()
    } else {
      db.update(tagDefinitions)
        .set({ name: newChildName })
        .where(eq(tagDefinitions.name, child.name))
        .run()
    }
  }
}

export function deleteTagDefinition(
  db: DataDb,
  name: string,
  options: { cascade?: boolean } = {}
): void {
  const normalizedName = name.toLowerCase().trim()
  db.delete(tagDefinitions).where(eq(tagDefinitions.name, normalizedName)).run()

  if (options.cascade) {
    db.delete(tagDefinitions)
      .where(like(tagDefinitions.name, `${normalizedName}/%`))
      .run()
  }
}

export function ensureTagDefinitions(
  db: DataDb,
  tags: string[]
): { name: string; color: string }[] {
  const normalized = Array.from(
    new Set(tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean))
  )

  return normalized.map((tag) => getOrCreateTag(db, tag))
}
