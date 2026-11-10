import fs from 'node:fs/promises'
import path from 'node:path'
import { normalizeJournalFolder } from '@memry/storage-vault'
import { errorCode } from './errno.ts'

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

/**
 * Why each config's `excludePatterns` cannot be trusted. The desktop keeps the user's
 * patterns while config.json gives no list (#4119); the CLI has no copy of them, so
 * anything that would show excluded folders fails instead (#4121).
 */
const unknownExcludePatterns = new WeakMap<VaultConfig, string>()

/** The config's exclude patterns; throws while config.json does not tell what they are. */
export function knownExcludePatterns(config: VaultConfig): string[] {
  const reason = unknownExcludePatterns.get(config)
  if (reason)
    throw new Error(`${reason}; the folders it excludes are unknown. Fix the file and retry.`)
  return config.excludePatterns
}

/**
 * Applies `updates` and writes config.json. `excludePatterns` is written only when
 * `updates` sets it or the file already has it: the desktop reads that key as the
 * user's list. Refuses an unreadable file, which would lose the user's settings.
 */
export async function updateVaultConfig(
  vaultPath: string,
  config: VaultConfig,
  updates: Partial<VaultConfig>
): Promise<void> {
  const configPath = getConfigPath(vaultPath)
  const stored = await readVaultConfig(configPath)
  if (stored.kind === 'unreadable') {
    throw new Error(`${stored.reason}; the file is left unchanged. Fix it and retry.`)
  }
  const { excludePatterns: _inMemory, ...current } = config
  const file: Record<string, unknown> = { ...stored.value, ...current, ...updates }
  await fs.writeFile(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
  await ensureVaultFolders(vaultPath, { ...config, ...updates })

  const exclude = resolveExcludePatterns(file, configPath)
  Object.assign(config, updates, { excludePatterns: exclude.patterns })
  if (exclude.unknown) unknownExcludePatterns.set(config, exclude.unknown)
  else unknownExcludePatterns.delete(config)
}

async function ensureVaultFolders(vaultPath: string, config: VaultConfig): Promise<void> {
  await fs.mkdir(path.join(vaultPath, config.defaultNoteFolder), { recursive: true })
  await fs.mkdir(path.join(vaultPath, config.journalFolder), { recursive: true })
  await fs.mkdir(path.join(vaultPath, ATTACHMENTS_DIR), { recursive: true })
  await fs.mkdir(path.join(vaultPath, ATTACHMENTS_DIR, 'images'), { recursive: true })
  await fs.mkdir(path.join(vaultPath, ATTACHMENTS_DIR, 'files'), { recursive: true })
}

type StoredConfig =
  | { kind: 'parsed'; value: Record<string, unknown> }
  | { kind: 'unreadable'; reason: string }

/** A missing config.json reads as `{}`. */
async function readVaultConfig(configPath: string): Promise<StoredConfig> {
  let value: unknown
  try {
    value = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'parsed', value: {} }
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'unreadable', reason: `${configPath} cannot be read (${reason})` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'unreadable', reason: `${configPath} cannot be read (not a JSON object)` }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked to be a plain JSON object above
  return { kind: 'parsed', value: value as Record<string, unknown> }
}

/**
 * Only an `excludePatterns` array is the user's list (non-strings dropped, as on
 * desktop). A missing key reads as the defaults; any other value is unknown.
 */
function resolveExcludePatterns(
  file: Record<string, unknown>,
  configPath: string
): { patterns: string[]; unknown?: string } {
  const value = file.excludePatterns
  if (value === undefined) return { patterns: [...defaultVaultConfig.excludePatterns] }
  if (Array.isArray(value)) {
    return { patterns: value.filter((item): item is string => typeof item === 'string') }
  }
  return {
    patterns: [...defaultVaultConfig.excludePatterns],
    unknown: `${configPath} has an excludePatterns that is not a list`
  }
}

export async function ensureVaultLayout(vaultPath: string): Promise<VaultConfig> {
  await fs.mkdir(getMemryDir(vaultPath), { recursive: true })

  const configPath = getConfigPath(vaultPath)
  const stored = await readVaultConfig(configPath)
  const file = stored.kind === 'parsed' ? stored.value : {}
  const { excludePatterns: _defaults, ...defaults } = defaultVaultConfig
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON; shape fixed by the producer, a runtime parser would change accepted input
  const merged = { ...defaults, ...file } as Omit<VaultConfig, 'excludePatterns'>
  if (stored.kind === 'parsed') {
    // Never write the default excludePatterns: the desktop would take them as the user's.
    await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8')
  } else {
    // Leave the file alone: overwriting it would lose the user's settings.
    process.stderr.write(
      `Warning: ${stored.reason}; using default settings and leaving the file unchanged.\n`
    )
  }

  const exclude = resolveExcludePatterns(file, configPath)
  // Same normalization as desktop's getConfig (main/vault/index.ts).
  const config: VaultConfig = {
    ...merged,
    excludePatterns: exclude.patterns,
    journalFolder: normalizeJournalFolder(merged.journalFolder),
    journalShowInSidebar: merged.journalShowInSidebar === true
  }
  const unknown = stored.kind === 'unreadable' ? stored.reason : exclude.unknown
  if (unknown) unknownExcludePatterns.set(config, unknown)
  await ensureVaultFolders(vaultPath, config)
  return config
}
