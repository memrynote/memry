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

/** One path segment, such as a note id or a file name: not empty, no separator, not `.` or `..`. */
export function isPlainSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  )
}

/**
 * The vault folder a command that writes there names, `/`-separated with no `.` or
 * `..` segments. Throws `Refusing to <action>` for the vault itself, for a path that
 * leaves it, and for a path through a link, which can lead anywhere outside it (#5658).
 * The lexical rule is desktop's `vaultFolderPath` (#5647). The links are found by an
 * `lstat` of each existing segment, as Tauri's `plain_folders` refuses them: a realpath
 * comparison would also trip on another case spelling, which macOS resolves.
 */
export async function vaultFolder(
  vaultPath: string,
  requested: string,
  action: string
): Promise<string> {
  const folder = path.posix.normalize(normalizePath(requested))
  if (
    folder === '.' ||
    folder === '..' ||
    folder.startsWith('../') ||
    path.win32.isAbsolute(folder)
  ) {
    throw new Error(`Refusing to ${action}: "${requested}" is the vault itself or outside it.`)
  }
  const segments = folder.split('/')
  for (let index = 1; index <= segments.length; index += 1) {
    const walked = segments.slice(0, index).join('/')
    try {
      if (!(await fs.lstat(path.join(vaultPath, walked))).isSymbolicLink()) continue
    } catch (error) {
      const code = errorCode(error)
      // The rest does not exist yet, so the write creates plain folders there.
      if (code === 'ENOENT' || code === 'ENOTDIR') break
      throw error
    }
    throw new Error(
      `Refusing to ${action}: "${walked}" is a link, and a path through a link can lead outside the vault.`
    )
  }
  return folder
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

/** `{}` for a missing config.json, `null` for one that cannot be read or parsed. */
async function readVaultConfig(configPath: string): Promise<Partial<VaultConfig> | null> {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON or driver result; shape fixed by the producer, a runtime parser would change accepted input
    return JSON.parse(await fs.readFile(configPath, 'utf-8')) as Partial<VaultConfig>
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {}
    // Leave the file alone: overwriting it would lose the user's settings.
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `Warning: ${configPath} cannot be read (${reason}); using default settings and leaving the file unchanged.\n`
    )
    return null
  }
}

export async function ensureVaultLayout(vaultPath: string): Promise<VaultConfig> {
  await fs.mkdir(getMemryDir(vaultPath), { recursive: true })

  const configPath = getConfigPath(vaultPath)
  const stored = await readVaultConfig(configPath)
  const merged = { ...structuredClone(defaultVaultConfig), ...stored }
  if (stored) await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8')

  // Same normalization as desktop's getConfig (main/vault/index.ts).
  const config: VaultConfig = {
    ...merged,
    journalFolder: normalizeJournalFolder(merged.journalFolder),
    journalShowInSidebar: merged.journalShowInSidebar === true
  }
  await ensureVaultFolders(vaultPath, config)
  return config
}
