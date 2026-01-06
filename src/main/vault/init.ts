import fs from 'fs'
import path from 'path'

/**
 * Default vault folder structure
 */
const VAULT_FOLDERS = ['notes', 'journal', 'attachments', 'attachments/images', 'attachments/files']

/**
 * Hidden memry folder name
 */
const MEMRY_DIR = '.memry'

/**
 * Default vault configuration
 */
const DEFAULT_CONFIG = {
  excludePatterns: ['.git', 'node_modules', '.trash'],
  defaultNoteFolder: 'notes',
  journalFolder: 'journal',
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
  if (!fs.existsSync(memryDir)) {
    fs.mkdirSync(memryDir, { recursive: true })
  }

  // Create default config if it doesn't exist
  const configPath = getConfigPath(vaultPath)
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
  }

  // Create default vault folders
  for (const folder of VAULT_FOLDERS) {
    const folderPath = path.join(vaultPath, folder)
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true })
    }
  }
}

/**
 * Read the vault configuration
 */
export function readVaultConfig(vaultPath: string): typeof DEFAULT_CONFIG {
  const configPath = getConfigPath(vaultPath)

  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) }
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
