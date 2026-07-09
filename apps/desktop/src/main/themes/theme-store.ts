/**
 * Custom theme local CRUD: DB row (sync source of truth for clocks) +
 * vault file write-through (`.memry/themes/<slug>.json`) + sync enqueue.
 *
 * @module themes/theme-store
 */

import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { customThemes } from '@memry/db-schema/schema/custom-themes'
import { utcNow } from '@memry/shared/utc'
import type {
  CreateThemeInput,
  CustomTheme,
  ThemeBase,
  UpdateThemeInput
} from '@memry/contracts/themes-api'
import { getStatus } from '../vault/index'
import {
  deleteThemeFile,
  listThemeFiles,
  renameThemeFile,
  uniqueThemeSlug,
  writeThemeFile
} from '../vault/themes'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import type { DataDb } from '../database'
import { createLogger } from '../lib/logger'

const log = createLogger('ThemeStore')

type ThemeRow = typeof customThemes.$inferSelect

function rowToTheme(row: ThemeRow): CustomTheme {
  return {
    id: row.id,
    name: row.name,
    base: row.base as ThemeBase,
    variables: (row.variables as Record<string, string>) ?? {},
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

function vaultPathOrNull(): string | null {
  return getStatus().path ?? null
}

function takenSlugs(db: DataDb, excludeId?: string): Set<string> {
  const rows = db.select({ id: customThemes.id, slug: customThemes.slug }).from(customThemes).all()
  return new Set(rows.filter((row) => row.id !== excludeId).map((row) => row.slug))
}

function writeFileSafe(slug: string, theme: CustomTheme, previousSlug?: string): void {
  const vaultPath = vaultPathOrNull()
  if (!vaultPath) return
  try {
    if (previousSlug && previousSlug !== slug) {
      renameThemeFile(vaultPath, previousSlug, slug)
    }
    writeThemeFile(vaultPath, slug, theme)
  } catch (error) {
    log.warn('Failed to write theme file', { slug, error: String(error) })
  }
}

export function listThemes(db: DataDb): CustomTheme[] {
  return db.select().from(customThemes).all().map(rowToTheme)
}

export function getTheme(db: DataDb, id: string): CustomTheme | null {
  const row = db.select().from(customThemes).where(eq(customThemes.id, id)).get()
  return row ? rowToTheme(row) : null
}

export function createTheme(db: DataDb, input: CreateThemeInput): CustomTheme {
  const id = randomUUID()
  const slug = uniqueThemeSlug(input.name, takenSlugs(db))
  const now = utcNow()
  const theme: CustomTheme = {
    id,
    name: input.name,
    base: input.base,
    variables: input.variables ?? {},
    createdAt: now,
    modifiedAt: now
  }

  db.insert(customThemes)
    .values({
      id,
      name: theme.name,
      slug,
      base: theme.base,
      variables: theme.variables,
      createdAt: now,
      modifiedAt: now
    })
    .run()

  writeFileSafe(slug, theme)
  enqueueLocalSyncCreate('theme', id)
  return theme
}

export function updateTheme(db: DataDb, id: string, input: UpdateThemeInput): CustomTheme | null {
  const existing = db.select().from(customThemes).where(eq(customThemes.id, id)).get()
  if (!existing) return null

  const name = input.name ?? existing.name
  const slug =
    input.name !== undefined && input.name !== existing.name
      ? uniqueThemeSlug(input.name, takenSlugs(db, id))
      : existing.slug
  const now = utcNow()
  const theme: CustomTheme = {
    id,
    name,
    base: input.base ?? (existing.base as ThemeBase),
    variables: input.variables ?? (existing.variables as Record<string, string>) ?? {},
    createdAt: existing.createdAt,
    modifiedAt: now
  }

  db.update(customThemes)
    .set({ name, slug, base: theme.base, variables: theme.variables, modifiedAt: now })
    .where(eq(customThemes.id, id))
    .run()

  writeFileSafe(slug, theme, existing.slug)
  enqueueLocalSyncUpdate('theme', id)
  return theme
}

export function deleteTheme(db: DataDb, id: string): boolean {
  const existing = db.select().from(customThemes).where(eq(customThemes.id, id)).get()
  if (!existing) return false

  const snapshot = JSON.stringify({
    name: existing.name,
    slug: existing.slug,
    base: existing.base,
    variables: existing.variables,
    clock: existing.clock,
    createdAt: existing.createdAt,
    modifiedAt: existing.modifiedAt
  })

  db.delete(customThemes).where(eq(customThemes.id, id)).run()

  const vaultPath = vaultPathOrNull()
  if (vaultPath) {
    try {
      deleteThemeFile(vaultPath, existing.slug)
    } catch (error) {
      log.warn('Failed to delete theme file', { slug: existing.slug, error: String(error) })
    }
  }

  enqueueLocalSyncDelete('theme', id, snapshot)
  return true
}

/**
 * Adopt vault theme files with no matching DB row (fresh install over an
 * existing vault, or hand-created files). Inserted unclocked so the next
 * seedUnclocked pass pushes them to other devices.
 */
export function adoptThemeFiles(db: DataDb): number {
  const vaultPath = vaultPathOrNull()
  if (!vaultPath) return 0

  const known = new Set(
    db
      .select({ id: customThemes.id })
      .from(customThemes)
      .all()
      .map((row) => row.id)
  )
  const slugs = takenSlugs(db)

  let adopted = 0
  for (const { slug, theme } of listThemeFiles(vaultPath)) {
    if (known.has(theme.id)) continue
    const finalSlug = slugs.has(slug) ? uniqueThemeSlug(theme.name, slugs) : slug
    slugs.add(finalSlug)

    db.insert(customThemes)
      .values({
        id: theme.id,
        name: theme.name,
        slug: finalSlug,
        base: theme.base,
        variables: theme.variables,
        createdAt: theme.createdAt,
        modifiedAt: theme.modifiedAt
      })
      .run()
    adopted++
  }

  if (adopted > 0) log.info('Adopted theme files from vault', { count: adopted })
  return adopted
}
