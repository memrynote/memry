import fs from 'node:fs/promises'
import path from 'node:path'

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

export function safeFilename(value: string): string {
  const cleaned = value
    .replace(/[/:\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : 'Untitled'
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
