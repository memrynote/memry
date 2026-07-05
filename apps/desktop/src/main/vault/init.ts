import fs from 'fs'
import path from 'path'
import { parseJournalDate, formatJournalFilename } from '@memry/storage-vault'
import { createLogger } from '../lib/logger'
import { readDailyNotesConfig } from './obsidian-config'

const logger = createLogger('VaultInit')

/**
 * Default vault folder structure (journal folder is added from config)
 */
const VAULT_FOLDERS = ['attachments', 'attachments/images', 'attachments/files']

/**
 * Hidden Memry folder name
 */
const MEMRY_DIR = '.memry'

/**
 * Default vault configuration
 */
const DEFAULT_CONFIG = {
  excludePatterns: ['.git', 'node_modules', '.trash', '.obsidian', '.memry'],
  defaultNoteFolder: '',
  journalFolder: 'journal',
  journalDateFormat: 'YYYY-MM-DD',
  attachmentsFolder: 'attachments'
}

/**
 * Get the .memry directory path for a vault
 */
export function getMemryDir(vaultPath: string): string {
  return path.join(vaultPath, MEMRY_DIR)
}

/**
 * Get the data.db path for a vault
 */
export function getDataDbPath(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'data.db')
}

/**
 * Get the index.db path for a vault
 */
export function getIndexDbPath(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'index.db')
}

/**
 * Get the config.json path for a vault
 */
export function getConfigPath(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'config.json')
}

/**
 * Check if a vault is initialized (has .memry folder)
 */
export function isVaultInitialized(vaultPath: string): boolean {
  const memryDir = getMemryDir(vaultPath)
  return fs.existsSync(memryDir)
}

/**
 * Check if a path exists and is a directory
 */
export function isValidDirectory(dirPath: string): boolean {
  try {
    const stats = fs.statSync(dirPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Check if we have write permissions to a directory
 */
export function hasWritePermission(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * True when an Obsidian daily-note format can serve as Memry's
 * journalDateFormat: it must round-trip a date and stay a single filename
 * (no '/' subfolders, which Memry's direct-child journal detection can't see).
 */
function isSeedableJournalFormat(format: string): boolean {
  const stem = formatJournalFilename('2026-01-31', format)
  return !stem.includes('/') && parseJournalDate(stem, format) === '2026-01-31'
}

/**
 * Seed-once journal settings from `.obsidian/daily-notes.json`.
 * Only consulted when `.memry/config.json` does not exist yet; afterwards
 * Memry's own config is authoritative (no live re-sync by design).
 */
function obsidianJournalSeed(vaultPath: string): Partial<typeof DEFAULT_CONFIG> {
  const dailyNotes = readDailyNotesConfig(vaultPath)
  if (!dailyNotes) return {}

  const seed: Partial<typeof DEFAULT_CONFIG> = {}
  const folder = dailyNotes.folder?.replace(/\/+$/, '')
  if (folder && !path.isAbsolute(folder) && !folder.split('/').includes('..')) {
    seed.journalFolder = folder
  }
  if (dailyNotes.format) {
    if (isSeedableJournalFormat(dailyNotes.format)) {
      seed.journalDateFormat = dailyNotes.format
    } else {
      logger.warn(
        `Ignoring Obsidian daily-note format "${dailyNotes.format}": not usable as a journal filename`
      )
    }
  }
  return seed
}

/**
 * Initialize a vault at the given path.
 * Creates .memry folder and default config if they don't exist.
 * Also creates default vault folders (journal, attachments).
 * On first init of a vault with an .obsidian folder, journal settings are
 * seeded from Obsidian's daily-notes config.
 */
export function initVault(vaultPath: string): void {
  // Create .memry directory
  const memryDir = getMemryDir(vaultPath)
  fs.mkdirSync(memryDir, { recursive: true })

  // Create default config if it doesn't exist
  const configPath = getConfigPath(vaultPath)
  const config = fs.existsSync(configPath)
    ? readVaultConfig(vaultPath)
    : { ...DEFAULT_CONFIG, ...obsidianJournalSeed(vaultPath) }
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx'
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }

  // Create default vault folders
  for (const folder of [...VAULT_FOLDERS, config.journalFolder]) {
    if (!folder) continue
    const folderPath = path.join(vaultPath, folder)
    fs.mkdirSync(folderPath, { recursive: true })
  }
}

/**
 * Read the vault configuration
 */
export function readVaultConfig(vaultPath: string): typeof DEFAULT_CONFIG {
  const configPath = getConfigPath(vaultPath)

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<typeof DEFAULT_CONFIG>
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return DEFAULT_CONFIG
  }
}

/**
 * Write the vault configuration
 */
export function writeVaultConfig(
  vaultPath: string,
  config: Partial<typeof DEFAULT_CONFIG>
): typeof DEFAULT_CONFIG {
  const currentConfig = readVaultConfig(vaultPath)
  const newConfig = { ...currentConfig, ...config }

  const configPath = getConfigPath(vaultPath)
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8')

  return newConfig
}

/**
 * Get the name of a vault from its path (last directory segment)
 */
export function getVaultName(vaultPath: string): string {
  return path.basename(vaultPath)
}

/**
 * Count markdown files in a directory recursively
 */
export function countMarkdownFiles(dirPath: string, excludePatterns: string[] = []): number {
  let count = 0

  const shouldExclude = (name: string): boolean => {
    return excludePatterns.some((pattern) => name === pattern || name.startsWith(pattern))
  }

  const countRecursive = (currentPath: string): void => {
    try {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        if (shouldExclude(entry.name)) continue

        const fullPath = path.join(currentPath, entry.name)

        if (entry.isDirectory()) {
          countRecursive(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          count++
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  countRecursive(dirPath)
  return count
}
