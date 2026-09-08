import { readdir, readFile, stat, utimes } from 'fs/promises'
import path from 'path'

import { createLogger } from '../lib/logger'
import { atomicWrite } from './file-ops'
import { normalizePropertiesToRoot, parseNote, serializeParsedNote } from './frontmatter'

const logger = createLogger('RootPropertiesMigration')

export const ROOT_PROPERTIES_MIGRATION_KEY = 'frontmatterPropertiesRootV1'
export const ROOT_PROPERTIES_MIGRATION_DONE = 'done'

export interface RootPropertiesMigrationResult {
  scanned: number
  migrated: number
  migratedPaths: string[]
  skipped: number
  deferred: number
  failed: number
  conflicts: string[]
}

interface MigrationOptions {
  excludePatterns?: string[]
}

const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.trash', '.obsidian', '.memry']

/**
 * Migrate legacy `frontmatter.properties` maps into top-level user keys.
 *
 * This function deliberately has no completion marker. The vault lifecycle
 * owns that marker and writes it only after this pass completes. A process
 * crash after any individual file write therefore makes the next pass resume
 * safely: already-migrated files are skipped and the remaining files converge.
 */
export async function migrateNestedPropertiesToRoot(
  vaultPath: string,
  options: MigrationOptions = {}
): Promise<RootPropertiesMigrationResult> {
  const result: RootPropertiesMigrationResult = {
    scanned: 0,
    migrated: 0,
    migratedPaths: [],
    skipped: 0,
    deferred: 0,
    failed: 0,
    conflicts: []
  }

  let files: string[]
  try {
    files = await findMarkdownFiles(vaultPath, options.excludePatterns ?? DEFAULT_EXCLUDES)
  } catch (error) {
    logger.error('Could not scan vault for root property migration', { vaultPath, error })
    result.failed++
    return result
  }

  for (const filePath of files) {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      result.failed++
      logger.warn('Could not read note during root property migration', { filePath, error })
      continue
    }

    result.scanned++
    const originalStats = await stat(filePath).catch(() => null)
    const parsed = parseNote(raw, filePath)
    if (parsed.frontmatterError) {
      result.deferred++
      logger.warn('Deferring root property migration for unparseable note', {
        filePath,
        error: parsed.frontmatterError
      })
      continue
    }

    const normalized = normalizePropertiesToRoot(parsed.frontmatter)
    if (!normalized.changed) {
      result.skipped++
      continue
    }

    const updated = serializeParsedNote(
      { ...parsed, frontmatter: normalized.frontmatter },
      parsed.content,
      { frontmatterEdited: true }
    )

    try {
      await atomicWrite(filePath, updated)
      if (originalStats) {
        await utimes(filePath, originalStats.atime, originalStats.mtime)
      }
      result.migrated++
      result.migratedPaths.push(toVaultRelativePath(vaultPath, filePath))
      result.conflicts.push(...normalized.conflicts)
    } catch (error) {
      result.failed++
      logger.warn('Could not write note during root property migration', { filePath, error })
    }
  }

  logger.info('Root property migration complete', {
    vaultPath,
    scanned: result.scanned,
    migrated: result.migrated,
    skipped: result.skipped,
    deferred: result.deferred,
    failed: result.failed,
    conflicts: result.conflicts.length
  })

  return result
}

function toVaultRelativePath(vaultPath: string, filePath: string): string {
  return path.relative(vaultPath, filePath).split(path.sep).join('/')
}

async function findMarkdownFiles(dirPath: string, excludePatterns: string[]): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (excludePatterns.some((pattern) => entry.name === pattern)) continue

    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await findMarkdownFiles(entryPath, excludePatterns)))
      continue
    }

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
      files.push(entryPath)
    }
  }

  return files.sort()
}
