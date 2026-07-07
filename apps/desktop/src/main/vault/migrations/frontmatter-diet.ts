/**
 * One-time frontmatter-diet vault migration.
 *
 * The frontmatter-diet change stopped writing Memry-managed keys
 * (`id`/`title`/`created`/`modified`/`emoji`/`localOnly`) into vault files —
 * the sidecar `note_metadata` data DB owns that state now. Pre-diet vaults
 * still carry those keys in file frontmatter, where they surface as
 * user-editable properties in the Properties UI. This migration runs once per
 * vault: it adopts any meaningful legacy value into `note_metadata`, then
 * strips the legacy keys from the markdown so they stop showing up as
 * properties. Legacy keys that are empty carry nothing to adopt and are simply
 * removed.
 *
 * Ordering matters. It must run AFTER the data DB is initialized and the vault
 * path/config are set, but BEFORE indexing and the watcher/sync runtime start:
 * running before `indexVault` lets the index cache record post-migration
 * content hashes, and running before the watcher/sync avoids file-change churn.
 *
 * Idempotent: after it runs, files carry no legacy keys (per-file no-ops on a
 * second pass) and a `settings` flag prevents re-running. It never throws out
 * of {@link migrateFrontmatterDietIfNeeded}; a fatal error leaves the flag
 * unset so the next vault open retries.
 *
 * @module vault/migrations/frontmatter-diet
 */

import path from 'path'
import { NoteSyncPolicies } from '@memry/db-schema/data-schema'
import {
  getNoteMetadataByPath,
  updateNoteMetadata
} from '@memry/storage-data/note-metadata-repository'
import { saveCanonicalNote } from '@memry/domain-notes'
import { utcNow } from '@memry/shared/utc'
import { extractDateFromPath } from '@main/database/queries/notes'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { getDatabase, type DataDb } from '../../database'
import { generateNoteId, isValidNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import { getConfig } from '../index'
import { atomicWrite, listMarkdownFiles, safeRead } from '../file-ops'
import { parseNote, serializeNote, type NoteFrontmatter } from '../frontmatter'
import { serializeJournalEntry, type JournalFrontmatter } from '../journal'
import { stat } from 'fs/promises'

const logger = createLogger('FrontmatterDietMigration')

/** Settings key + version marking the migration complete for this vault. */
const MIGRATION_KEY = 'vault.migration.frontmatterDiet'
const MIGRATION_VERSION = 1

/**
 * Legacy Memry-managed keys, now sidecar-owned. Regular notes shed all of
 * them; journals keep `date` (Memry rewrites it every save) and never carried
 * `title`/`localOnly`, so only `id`/`created`/`modified`/`emoji` are stripped.
 */
const LEGACY_NOTE_KEYS = ['id', 'title', 'created', 'modified', 'emoji', 'localOnly'] as const
const LEGACY_JOURNAL_KEYS = ['id', 'created', 'modified', 'emoji'] as const

export interface FrontmatterDietMigrationResult {
  /** Files that had legacy keys stripped and were rewritten. */
  filesRewritten: number
  /** Whether the migration was skipped (already completed for this vault). */
  skipped: boolean
}

/**
 * Run the migration once per vault, gated on a persisted settings flag.
 * Never throws — a fatal failure is logged and leaves the flag unset so the
 * next open retries.
 */
export async function migrateFrontmatterDietIfNeeded(
  vaultPath: string
): Promise<FrontmatterDietMigrationResult> {
  const dataDb = getDatabase()

  if (getSetting(dataDb, MIGRATION_KEY) !== null) {
    return { filesRewritten: 0, skipped: true }
  }

  try {
    const filesRewritten = await runMigration(vaultPath, dataDb)
    setSetting(
      dataDb,
      MIGRATION_KEY,
      JSON.stringify({ v: MIGRATION_VERSION, completedAt: utcNow(), filesRewritten })
    )
    if (filesRewritten > 0) {
      logger.info(`Frontmatter-diet migration: stripped legacy keys from ${filesRewritten} file(s)`)
    }
    return { filesRewritten, skipped: false }
  } catch (err) {
    // Leave the flag unset so the next open retries. Already-migrated files are
    // no-ops on the retry, so a partial pass is safe to resume.
    logger.error('Frontmatter-diet migration failed; will retry on next open', err)
    return { filesRewritten: 0, skipped: false }
  }
}

async function runMigration(vaultPath: string, dataDb: DataDb): Promise<number> {
  const config = getConfig()
  const excludedRoots = new Set(
    [...(config.excludePatterns ?? []), config.attachmentsFolder]
      .filter((p): p is string => Boolean(p))
      .map((p) => p.replace(/\/+$/, '').split('/')[0])
  )

  const relPaths = (await listMarkdownFiles(vaultPath, vaultPath)).filter(
    (rel) => !excludedRoots.has(rel.split('/')[0])
  )

  let filesRewritten = 0
  for (const rel of relPaths) {
    try {
      if (await migrateFile(vaultPath, rel, dataDb)) filesRewritten++
    } catch (err) {
      logger.warn('Frontmatter-diet migration: skipped file after error', { path: rel, err })
    }
  }
  return filesRewritten
}

async function migrateFile(vaultPath: string, rel: string, dataDb: DataDb): Promise<boolean> {
  const absolutePath = path.join(vaultPath, rel)
  const content = await safeRead(absolutePath)
  if (content == null) return false

  const parsed = parseNote(content, rel)
  const frontmatter = parsed.frontmatter
  const journalDate = extractDateFromPath(rel)
  const isJournal = journalDate !== null
  const legacyKeys = isJournal ? LEGACY_JOURNAL_KEYS : LEGACY_NOTE_KEYS

  const present = legacyKeys.filter((key) => key in frontmatter)
  if (present.length === 0) return false

  await adoptLegacyStateIntoSidecar(absolutePath, rel, frontmatter, journalDate, dataDb)

  const stripped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(frontmatter)) {
    if ((legacyKeys as readonly string[]).includes(key)) continue
    stripped[key] = value
  }

  const nextContent = isJournal
    ? serializeJournalEntry(stripped as JournalFrontmatter, parsed.content)
    : serializeNote(stripped as NoteFrontmatter, parsed.content)

  if (nextContent === content) return false

  await atomicWrite(absolutePath, nextContent)
  return true
}

/**
 * Fold meaningful legacy values into `note_metadata` before they are stripped.
 * An existing row wins for fields it already holds; only empty/missing sidecar
 * fields are backfilled. `created` is backfilled when the file carries an
 * earlier authored date than the row (recovers pre-diet authored dates that a
 * prior fs-birthtime index may have clobbered). `title` is never adopted (it is
 * always the filename basename).
 */
async function adoptLegacyStateIntoSidecar(
  absolutePath: string,
  rel: string,
  frontmatter: NoteFrontmatter,
  journalDate: string | null,
  dataDb: DataDb
): Promise<void> {
  const emoji = toEmoji(frontmatter.emoji)
  const localOnly = toBool(frontmatter.localOnly)
  const created = toIsoDate(frontmatter.created)
  const modified = toIsoDate(frontmatter.modified)
  const fileId =
    typeof frontmatter.id === 'string' && isValidNoteId(frontmatter.id) ? frontmatter.id : null

  const row = getNoteMetadataByPath(dataDb, rel)

  if (row) {
    const updates: Parameters<typeof updateNoteMetadata>[2] = {}
    if (emoji !== null && !row.emoji) updates.emoji = emoji
    if (localOnly === true && !row.localOnly) {
      updates.localOnly = true
      updates.syncPolicy = NoteSyncPolicies.LOCAL_ONLY
    }
    if (created !== null && isEarlier(created, row.createdAt)) updates.createdAt = created
    if (Object.keys(updates).length > 0) updateNoteMetadata(dataDb, row.id, updates)
    return
  }

  // No sidecar row yet — mint one adopting the legacy identity/state so the
  // upcoming index run projects it instead of a fresh, lossy default.
  const birthtime = await fileBirthtime(absolutePath)
  saveCanonicalNote(dataDb, {
    id: fileId ?? generateNoteId(),
    path: rel,
    title: path.basename(rel, '.md'),
    emoji,
    localOnly: localOnly ?? false,
    journalDate,
    createdAt: created ?? birthtime ?? utcNow(),
    modifiedAt: modified ?? created ?? birthtime ?? utcNow()
  })
}

function toEmoji(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function toBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString()
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const date = new Date(value)
    return isNaN(date.getTime()) ? null : date.toISOString()
  }
  return null
}

function isEarlier(candidate: string, current: string | null | undefined): boolean {
  if (!current) return true
  const a = new Date(candidate).getTime()
  const b = new Date(current).getTime()
  if (isNaN(a) || isNaN(b)) return false
  return a < b
}

async function fileBirthtime(absolutePath: string): Promise<string | null> {
  try {
    const stats = await stat(absolutePath)
    return stats.birthtime.toISOString()
  } catch {
    return null
  }
}
