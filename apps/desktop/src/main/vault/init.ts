import fs from 'fs'
import path from 'path'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'

const logger = createLogger('VaultInit')

/**
 * Default vault folder structure
 */
const VAULT_FOLDERS = ['journal', 'attachments', 'attachments/images', 'attachments/files']

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
 * Initialize a vault at the given path.
 * Creates .memry folder and default config if they don't exist.
 * Also creates default vault folders (notes, journal, attachments).
 */
export function initVault(vaultPath: string): void {
  // Create .memry directory
  const memryDir = getMemryDir(vaultPath)
  fs.mkdirSync(memryDir, { recursive: true })

  // Create default config if it doesn't exist
  const configPath = getConfigPath(vaultPath)
  try {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), {
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
  for (const folder of VAULT_FOLDERS) {
    const folderPath = path.join(vaultPath, folder)
    fs.mkdirSync(folderPath, { recursive: true })
  }
}

// readVaultConfig sits on hot paths (getConfig runs on most vault operations),
// so a corrupt config.json would otherwise warn on every call — report once
// per config path per process.
const warnedConfigPaths = new Set<string>()

// Callers get their own object and their own excludePatterns array, so nothing
// they do to the result can reach back into the cached entry.
function copyConfig(config: typeof DEFAULT_CONFIG): typeof DEFAULT_CONFIG {
  return { ...config, excludePatterns: [...config.excludePatterns] }
}

interface ConfigCacheEntry {
  config: typeof DEFAULT_CONFIG
  mtimeNs: bigint
  size: bigint
  ino: bigint
}

// Keyed by config path, so a cached vault A config can never be served while
// vault B is open — the key changes with the vault.
const configCache = new Map<string, ConfigCacheEntry>()

/**
 * Drop every vault's cached config.
 *
 * Called on the app's own lifecycle edges (vault open and close); in-app writes
 * go through `writeVaultConfig` below, and outside writers are caught by the
 * stat check in `readVaultConfig`.
 */
export function invalidateVaultConfigCache(): void {
  configCache.clear()
}

/**
 * Read the vault configuration
 *
 * The parsed config is cached per vault and revalidated against the file's
 * inode/size/mtime on every call, so a read+parse only happens when config.json
 * actually changed. A stat is ~13x cheaper than the read + JSON.parse it
 * replaces, and validating against the file rather than trusting an explicit
 * invalidation is what keeps the cache honest: config.json is written by
 * `writeVaultConfig`, by `writePreferences` (atomic create+rename, hence the
 * inode check), by sync, and by hand.
 */
export function readVaultConfig(vaultPath: string): typeof DEFAULT_CONFIG {
  const configPath = getConfigPath(vaultPath)

  let stat: fs.BigIntStats | null = null
  try {
    stat = fs.statSync(configPath, { bigint: true })
  } catch {
    // Missing or unreadable — fall through to the read below, which owns the
    // ENOENT-vs-corrupt reporting and the defaults fallback.
    configCache.delete(configPath)
  }

  if (stat) {
    const cached = configCache.get(configPath)
    if (
      cached &&
      cached.ino === stat.ino &&
      cached.size === stat.size &&
      cached.mtimeNs === stat.mtimeNs
    ) {
      return copyConfig(cached.config)
    }
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(content) as Partial<typeof DEFAULT_CONFIG>
    const config = { ...DEFAULT_CONFIG, ...parsed }
    if (stat) {
      configCache.set(configPath, {
        config,
        mtimeNs: stat.mtimeNs,
        size: stat.size,
        ino: stat.ino
      })
    }
    return copyConfig(config)
  } catch (error) {
    // A missing config is a normal fresh-vault state; a corrupt/unreadable one
    // silently reverts journal/exclude settings to defaults, so surface it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !warnedConfigPaths.has(configPath)) {
      warnedConfigPaths.add(configPath)
      logger.warn('Vault config unreadable, falling back to defaults:', error)
      trackMainLog('warn', { scope: 'vault', action: 'config_corrupt_fallback' })
    }
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
  // In-place write: same inode, and same size whenever only a value's contents
  // change. Drop the entry rather than lean on mtime granularity.
  configCache.delete(configPath)

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
