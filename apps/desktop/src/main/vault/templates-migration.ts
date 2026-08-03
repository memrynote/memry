/**
 * One-time backfill of pre-sync template files into the data DB.
 *
 * @module vault/templates-migration
 */

import fs, { existsSync } from 'fs'
import path from 'path'
import matter from 'gray-matter'
import { templates } from '@memry/db-schema/schema/templates'
import type { Template, TemplateProperty } from '@memry/contracts/templates-api'
import { getSetting, setSetting } from '../database/queries/settings'
import type { DataDb } from '../database/types'
import { createLogger } from '../lib/logger'
import { getMemryDir } from './init'
import { BUILT_IN_TEMPLATES } from './built-in-templates'

const log = createLogger('TemplatesMigration')

const MIGRATION_KEY = 'templates.importedFromFiles'
const TEMPLATES_DIR = 'templates'

const BUILT_IN_IDS = new Set(BUILT_IN_TEMPLATES.map((t) => t.id))

interface TemplateFrontmatter {
  id?: string
  name?: string
  description?: string
  icon?: string | null
  isBuiltIn?: boolean
  tags?: string[]
  properties?: TemplateProperty[]
  createdAt?: string
  modifiedAt?: string
}

/** Parses a legacy template file. Only the migration still needs this. */
export function parseTemplate(content: string, filePath: string): Template {
  const { data, content: body } = matter(content)
  const frontmatter = data as TemplateFrontmatter
  const id = frontmatter.id ?? path.basename(filePath, '.md')

  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description,
    icon: frontmatter.icon ?? null,
    isBuiltIn: frontmatter.isBuiltIn === true,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    properties: Array.isArray(frontmatter.properties) ? frontmatter.properties : [],
    content: body.trim(),
    createdAt: frontmatter.createdAt ?? new Date().toISOString(),
    modifiedAt: frontmatter.modifiedAt ?? new Date().toISOString()
  }
}

/**
 * One-time backfill of pre-sync template files into the data DB.
 *
 * Guarded by a settings key rather than an emptiness check: a user who deletes
 * every template must not have them resurrected on the next launch.
 *
 * Rows are inserted with clock = NULL so seedUnclocked stamps a clock and
 * pushes them. Ids come from frontmatter and are never regenerated, so a vault
 * copied between devices converges by LWW instead of duplicating.
 *
 * Legacy files are deliberately left on disk: zero-risk, and an older build
 * downgraded onto this vault still reads them.
 */
export function migrateTemplateFilesToDb(db: DataDb, vaultPath: string): number {
  if (getSetting(db, MIGRATION_KEY) === '1') return 0

  const dir = path.join(getMemryDir(vaultPath), TEMPLATES_DIR)
  if (!existsSync(dir)) {
    setSetting(db, MIGRATION_KEY, '1')
    return 0
  }

  let imported = 0

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue

    const filePath = path.join(dir, file)
    try {
      const template = parseTemplate(fs.readFileSync(filePath, 'utf-8'), filePath)

      if (template.isBuiltIn || BUILT_IN_IDS.has(template.id)) continue

      db.insert(templates)
        .values({
          id: template.id,
          name: template.name,
          description: template.description ?? null,
          icon: template.icon ?? null,
          tags: template.tags,
          properties: template.properties,
          content: template.content,
          clock: null,
          createdAt: template.createdAt,
          modifiedAt: template.modifiedAt
        })
        .onConflictDoNothing()
        .run()

      imported++
    } catch (err) {
      log.warn('Skipping unparseable template file during migration', { file, error: err })
    }
  }

  setSetting(db, MIGRATION_KEY, '1')
  log.info('Imported legacy template files', { imported })

  return imported
}
