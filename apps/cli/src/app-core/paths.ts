import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeJournalFolder } from '@memry/storage-vault'

export interface VaultConfig {
  excludePatterns: string[]
  defaultNoteFolder: string
  journalFolder: string
  journalDateFormat: string
  attachmentsFolder: string
  /** Desktop's setting: list the journal folder in the notes tree. Absent means off. */
  journalShowInSidebar?: boolean
}

/**
 * Where every note's attachments live, as on desktop (`getAttachmentsRoot`).
 * Fixed: a config's `attachmentsFolder` is kept for older builds and ignored.
 */
export const ATTACHMENTS_DIR = 'attachments'

/** Canvas scenes live here, as on desktop (`CANVAS_DIR`); the notes tree hides it. */
export const CANVAS_DIR = 'canvases'

export const defaultVaultConfig: VaultConfig = {
  excludePatterns: ['.git', 'node_modules', '.trash', '.obsidian', '.memry'],
  defaultNoteFolder: '',
  journalFolder: 'journal',
  journalDateFormat: 'YYYY-MM-DD',
  attachmentsFolder: 'attachments'
}

export function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  let start = 0
  let end = normalized.length

  while (start < end && normalized[start] === '/') start += 1
  while (end > start && normalized[end - 1] === '/') end -= 1

  return normalized.slice(start, end)
}

// Mirrors desktop's `sanitizeFilename` (file-ops.ts): platform-invalid chars
// plus `[ ] # ^`, which Obsidian ≥1.8 forbids in filenames (they break
// wikilink syntax).
export function safeFilename(value: string): string {
  let sanitized = value
    .replace(/[<>:"/\\|?*[\]#^]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // Strip every leading dot (hidden files) and re-trim any whitespace it
  // exposes. Loop because stripping the widened char set can leave `..` or
  // `. Report`; a single slice would keep a `..` traversal or a leading space.
  while (sanitized.startsWith('.')) {
    sanitized = sanitized.slice(1).trim()
  }

  if (sanitized.length === 0) return 'untitled'
  return sanitized.length > 200 ? sanitized.slice(0, 200) : sanitized
}

export function getMemryDir(vaultPath: string): string {
  return path.join(vaultPath, '.memry')
}

export function getDataDbPath(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'data.db')
}

export function getIndexDbPath(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'index.db')
}

export function getConfigPath(vaultPath: string): string {
  return path.join(getMemryDir(vaultPath), 'config.json')
}

export async function writeVaultConfig(vaultPath: string, config: VaultConfig): Promise<void> {
  await fs.mkdir(getMemryDir(vaultPath), { recursive: true })
  await fs.writeFile(getConfigPath(vaultPath), `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
  await ensureVaultFolders(vaultPath, config)
}

async function ensureVaultFolders(vaultPath: string, config: VaultConfig): Promise<void> {
  await fs.mkdir(path.join(vaultPath, config.defaultNoteFolder), { recursive: true })
  await fs.mkdir(path.join(vaultPath, config.journalFolder), { recursive: true })
  await fs.mkdir(path.join(vaultPath, ATTACHMENTS_DIR), { recursive: true })
  await fs.mkdir(path.join(vaultPath, ATTACHMENTS_DIR, 'images'), { recursive: true })
  await fs.mkdir(path.join(vaultPath, ATTACHMENTS_DIR, 'files'), { recursive: true })
}

/** Reads config.json as desktop's getConfig does. A missing file is created with defaults. */
async function readVaultConfig(configPath: string): Promise<Partial<VaultConfig> | null> {
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf-8')) as Partial<VaultConfig>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    // Leave the file alone: overwriting it would lose the user's settings.
    console.error(`Could not read ${configPath}, using default settings:`, error)
    return null
  }
}

export async function ensureVaultLayout(vaultPath: string): Promise<VaultConfig> {
  await fs.mkdir(getMemryDir(vaultPath), { recursive: true })

  const stored = await readVaultConfig(getConfigPath(vaultPath))
  const merged = { ...structuredClone(defaultVaultConfig), ...stored }
  if (stored) await writeVaultConfig(vaultPath, merged)

  // Same normalization as desktop's getConfig (main/vault/index.ts).
  const config: VaultConfig = {
    ...merged,
    journalFolder: normalizeJournalFolder(merged.journalFolder),
    journalShowInSidebar: merged.journalShowInSidebar === true
  }
  await ensureVaultFolders(vaultPath, config)
  return config
}
