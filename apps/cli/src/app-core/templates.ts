import type {
  TemplateProperty,
  TemplateRecord,
  TemplatesService
} from '@memry/app-core/service-types'
export type {
  TemplateProperty,
  TemplateRecord,
  CreateTemplateInput,
  UpdateTemplateInput,
  TemplatesService
} from '@memry/app-core/service-types'
import fs from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { settings, templates } from '@memry/db-schema/data-schema'
import { createId } from '@memry/app-core/ids'
import { parseMarkdownNote } from '@memry/app-core/markdown'
import type { DataDb } from './database.ts'
import { getMemryDir, safeFilename } from './paths.ts'

// Custom templates live in the `templates` table of data.db and sync as
// whole-row LWW; `.memry/templates/<id>.md` is the retired pre-sync location,
// read once by the migration below and otherwise only kept as a downgrade
// path. Desktop's built-in templates are code constants over there and never
// appear in the table — or in CLI listings.

const MIGRATION_KEY = 'templates.importedFromFiles'

function templatesDir(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'templates')
}

function legacyTemplatePath(vaultPath: string, id: string): string {
  return path.join(templatesDir(vaultPath), `${safeFilename(id)}.md`)
}

function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((tag) => String(tag).trim()).filter(Boolean)
}

function toProperties(value: unknown): TemplateProperty[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((property): property is Record<string, unknown> => {
      return typeof property === 'object' && property !== null
    })
    .map((property) => ({
      name: String(property.name ?? ''),
      type: String(property.type ?? 'text'),
      value: property.value,
      options: Array.isArray(property.options)
        ? property.options.map((option) => String(option))
        : undefined
    }))
    .filter((property) => property.name.trim())
}

function toRecord(row: typeof templates.$inferSelect): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    icon: row.icon ?? null,
    isBuiltIn: false,
    tags: toTags(row.tags),
    properties: toProperties(row.properties),
    content: row.content,
    path: '',
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

/**
 * One-time backfill of pre-sync template files into the data DB, mirroring
 * desktop's `migrateTemplateFilesToDb`. Guarded by a settings key rather than
 * an emptiness check: a user who deletes every template must not have them
 * resurrected on the next run. Rows land with clock = NULL so the desktop sync
 * engine stamps and pushes them. Legacy files stay on disk as a downgrade
 * path. A file that fails to READ holds the flag back for a retry; one that
 * fails to parse never will, so it is skipped for good.
 */
function migrateLegacyTemplateFiles(dataDb: DataDb, vaultPath: string): void {
  const migrated =
    dataDb
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, MIGRATION_KEY))
      .get()?.value === '1'
  if (migrated) return

  const dir = templatesDir(vaultPath)
  // No directory = nothing to resurrect; leave the flag unset so a later
  // hydration (cloud-sync client, downgrade round-trip) still imports.
  if (!existsSync(dir)) return

  let failed = 0
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue

    let raw: string
    try {
      raw = readFileSync(path.join(dir, file), 'utf-8')
    } catch {
      failed += 1
      continue
    }

    try {
      const parsed = parseMarkdownNote(raw)
      if (parsed.frontmatter.isBuiltIn === true) continue
      const id = String(parsed.frontmatter.id ?? path.basename(file, '.md'))
      dataDb
        .insert(templates)
        .values({
          id,
          name: String(parsed.frontmatter.name ?? id),
          description:
            parsed.frontmatter.description === undefined
              ? null
              : String(parsed.frontmatter.description),
          icon: parsed.frontmatter.icon === undefined ? null : String(parsed.frontmatter.icon),
          tags: toTags(parsed.frontmatter.tags),
          properties: toProperties(parsed.frontmatter.properties),
          content: parsed.content,
          clock: null,
          createdAt: String(parsed.frontmatter.createdAt ?? new Date().toISOString()),
          modifiedAt: String(parsed.frontmatter.modifiedAt ?? new Date().toISOString())
        })
        .onConflictDoNothing()
        .run()
    } catch {
      // Malformed frontmatter never parses; retrying forever buys nothing.
    }
  }

  if (failed === 0) {
    const modifiedAt = new Date().toISOString()
    dataDb
      .insert(settings)
      .values({ key: MIGRATION_KEY, value: '1', modifiedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value: '1', modifiedAt } })
      .run()
  }
}

export function createTemplatesService({
  vaultPath,
  dataDb
}: {
  vaultPath: string
  dataDb: DataDb
}): TemplatesService {
  migrateLegacyTemplateFiles(dataDb, vaultPath)

  return {
    async list() {
      return dataDb.select().from(templates).orderBy(asc(templates.name)).all().map(toRecord)
    },

    async get(id) {
      const row = dataDb.select().from(templates).where(eq(templates.id, id)).get()
      return row ? toRecord(row) : null
    },

    async create(input) {
      const name = input.name.trim()
      if (!name) throw new Error('Template name is required')

      const now = new Date().toISOString()
      const row: typeof templates.$inferInsert = {
        id: createId('template'),
        name,
        description: input.description ?? null,
        icon: input.icon ?? null,
        tags: input.tags ?? [],
        properties: input.properties ?? [],
        content: input.content ?? '',
        clock: null,
        createdAt: now,
        modifiedAt: now
      }
      dataDb.insert(templates).values(row).run()
      const created = await this.get(row.id)
      if (!created) throw new Error(`Template not found after create: ${row.id}`)
      return created
    },

    async update(id, input) {
      const existing = await this.get(id)
      if (!existing) throw new Error(`Template not found: ${id}`)

      dataDb
        .update(templates)
        .set({
          name: input.name ?? existing.name,
          description:
            input.description !== undefined ? input.description : (existing.description ?? null),
          icon: input.icon !== undefined ? input.icon : existing.icon,
          tags: input.tags ?? existing.tags,
          properties: input.properties ?? existing.properties,
          content: input.content ?? existing.content,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(templates.id, id))
        .run()
      const updated = await this.get(id)
      if (!updated) throw new Error(`Template not found after update: ${id}`)
      return updated
    },

    async duplicate(id, newName) {
      const existing = await this.get(id)
      if (!existing) throw new Error(`Template not found: ${id}`)
      return this.create({
        name: newName,
        description: existing.description,
        icon: existing.icon,
        tags: [...existing.tags],
        properties: existing.properties.map((property) => ({ ...property })),
        content: existing.content
      })
    },

    async delete(id) {
      const existing = await this.get(id)
      if (!existing) return false
      dataDb.delete(templates).where(eq(templates.id, id)).run()
      // The legacy file would resurrect this row through a future migration
      // retry on another device — remove it the way desktop's delete does.
      await fs.rm(legacyTemplatePath(vaultPath, id), { force: true })
      return true
    }
  }
}
