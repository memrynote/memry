import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface VaultConfig {
  excludePatterns: string[]
  defaultNoteFolder: string
  journalFolder: string
  journalDateFormat: string
  attachmentsFolder: string
}

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
  await fs.mkdir(path.join(vaultPath, config.defaultNoteFolder), { recursive: true })
  await fs.mkdir(path.join(vaultPath, config.journalFolder), { recursive: true })
  await fs.mkdir(path.join(vaultPath, config.attachmentsFolder), { recursive: true })
  await fs.mkdir(path.join(vaultPath, config.attachmentsFolder, 'images'), { recursive: true })
  await fs.mkdir(path.join(vaultPath, config.attachmentsFolder, 'files'), { recursive: true })
}

export async function ensureVaultLayout(vaultPath: string): Promise<VaultConfig> {
  await fs.mkdir(getMemryDir(vaultPath), { recursive: true })

  const configPath = getConfigPath(vaultPath)
  let config = defaultVaultConfig
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    config = { ...defaultVaultConfig, ...(JSON.parse(raw) as Partial<VaultConfig>) }
  } catch {
    await fs.writeFile(configPath, `${JSON.stringify(defaultVaultConfig, null, 2)}\n`, 'utf-8')
  }

  await writeVaultConfig(vaultPath, config)

  return config
}

export function findWorkspaceRoot(start = fileURLToPath(new URL('.', import.meta.url))): string {
  let current = start
  while (current !== path.dirname(current)) {
    if (current.endsWith(`${path.sep}memry`)) return current
    current = path.dirname(current)
  }
  return process.cwd()
}
