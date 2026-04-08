import { count, eq, like } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import type { DrizzleDb } from '../types'

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

export function getOrCreateTag(db: DrizzleDb, name: string): { name: string; color: string } {
  const normalizedName = name.toLowerCase().trim()

  const existing = db
    .select()
    .from(tagDefinitions)
    .where(eq(tagDefinitions.name, normalizedName))
    .get()

  if (existing) {
    return { name: existing.name, color: existing.color }
  }

  const tagCount = db.select({ count: count() }).from(tagDefinitions).get()?.count ?? 0
  const color = TAG_COLOR_PALETTE[tagCount % TAG_COLOR_PALETTE.length]

  db.insert(tagDefinitions).values({ name: normalizedName, color }).run()

  return { name: normalizedName, color }
}

export function getAllTagDefinitions(db: DrizzleDb): { name: string; color: string }[] {
  return db
    .select({
      name: tagDefinitions.name,
      color: tagDefinitions.color
    })
    .from(tagDefinitions)
    .all()
}

export function updateTagColor(db: DrizzleDb, name: string, color: string): void {
  const normalizedName = name.toLowerCase().trim()
  db.update(tagDefinitions).set({ color }).where(eq(tagDefinitions.name, normalizedName)).run()
}

export function renameTagDefinition(db: DrizzleDb, oldName: string, newName: string): void {
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
    db.update(tagDefinitions).set({ name: normalizedNew }).where(eq(tagDefinitions.name, normalizedOld)).run()
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
      db.update(tagDefinitions).set({ name: newChildName }).where(eq(tagDefinitions.name, child.name)).run()
    }
  }
}

export function deleteTagDefinition(
  db: DrizzleDb,
  name: string,
  options: { cascade?: boolean } = {}
): void {
  const normalizedName = name.toLowerCase().trim()
  db.delete(tagDefinitions).where(eq(tagDefinitions.name, normalizedName)).run()

  if (options.cascade) {
    db.delete(tagDefinitions).where(like(tagDefinitions.name, `${normalizedName}/%`)).run()
  }
}

export function ensureTagDefinitions(
  db: DrizzleDb,
  tags: string[]
): { name: string; color: string }[] {
  const normalized = Array.from(
    new Set(tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean))
  )

  return normalized.map((tag) => getOrCreateTag(db, tag))
}
