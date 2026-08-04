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
import { BUILT_IN_IDS } from './built-in-templates'

const log = createLogger('TemplatesMigration')

const MIGRATION_KEY = 'templates.importedFromFiles'
const TEMPLATES_DIR = 'templates'

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
function parseTemplate(content: string, filePath: string): Template {
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
  try {
    if (getSetting(db, MIGRATION_KEY) === '1') return 0

    const dir = path.join(getMemryDir(vaultPath), TEMPLATES_DIR)
    // Deliberately do NOT flag when the directory is absent. A cloud-sync
    // client that has not hydrated .memry/templates yet — or a rollback to the
    // old build, which still writes files — would otherwise have its templates
    // permanently skipped. With nothing on disk there is also nothing to
    // resurrect, so the flag buys no safety here; the cost is one existsSync
    // per vault open.
    if (!existsSync(dir)) return 0

    let imported = 0
    let failed = 0

    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue

      // Built-ins were written to disk by every pre-upgrade build, so skipping
      // them by filename avoids 8 synchronous reads + YAML parses per install
      // whose results are thrown away below anyway.
      if (BUILT_IN_IDS.has(path.basename(file, '.md'))) continue

      const filePath = path.join(dir, file)

      // Reading is the part that fails transiently (antivirus lock, cloud-sync
      // client mid-hydration), so it alone decides whether the one-shot flag
      // gets held back for a retry.
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf-8')
      } catch (err) {
        failed++
        log.warn('Could not read template file; will retry on next vault open', {
          file,
          error: err
        })
        continue
      }

      try {
        const template = parseTemplate(raw, filePath)

        if (template.isBuiltIn || BUILT_IN_IDS.has(template.id)) continue

        const result = db
          .insert(templates)
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

        if (result.changes > 0) imported++
      } catch (err) {
        // Malformed frontmatter will never parse, so retrying forever buys
        // nothing — skip it and let the flag proceed.
        log.warn('Skipping unparseable template file during migration', { file, error: err })
      }
    }

    // Only burn the one-shot flag once every file has actually landed. A
    // transient EBUSY/EPERM (antivirus, a cloud-sync client still hydrating the
    // folder) would otherwise lose that template forever: listTemplates no
    // longer reads disk, so nothing would ever retry.
    if (failed === 0) {
      setSetting(db, MIGRATION_KEY, '1')
    } else {
      log.warn('Leaving template import unflagged for retry on next open', { imported, failed })
    }

    log.info('Imported legacy template files', { imported, failed })

    return imported
  } catch (err) {
    // Never abort openVault. A readdir that throws (ENOTDIR, EACCES, a Windows
    // lock) used to surface as "vault will not open", permanently, because the
    // flag was never set and every launch retried the same failing path.
    log.error('Template file import failed; continuing vault open', err)
    return 0
  }
}
