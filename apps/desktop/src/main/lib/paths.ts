import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from 'fs'
import type { BigIntStats } from 'fs'
import { lstat, open, realpath } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { OutsideVaultError } from './errors'

const CONTROL_FILENAME_CHARS = `${String.fromCharCode(0)}-${String.fromCharCode(31)}`
const UNSAFE_FILENAME_CHARS = new RegExp(`[<>:"/\\\\|?*${CONTROL_FILENAME_CHARS}]`, 'g')

/**
 * Sanitizes a file path to prevent directory traversal attacks.
 * Removes .. segments and normalizes the path.
 */
export function sanitizePath(inputPath: string): string {
  // Normalize and resolve to remove .. and . segments
  const normalized = path.normalize(inputPath)

  // Remove any remaining .. segments (shouldn't happen after normalize, but be safe)
  const segments = normalized.split(path.sep).filter((segment) => segment !== '..')

  return segments.join(path.sep)
}

/**
 * Normalizes vault-relative paths to forward slashes for cross-platform storage.
 */
export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}

/**
 * Calculates relative path from vault root.
 * Returns null if the path is outside the vault.
 */
export function getRelativePath(vaultPath: string, filePath: string): string | null {
  const resolvedVault = path.resolve(vaultPath)
  const resolvedFile = path.resolve(filePath)

  // Check if file is inside vault
  if (!resolvedFile.startsWith(resolvedVault + path.sep)) {
    return null
  }

  return normalizeRelativePath(path.relative(resolvedVault, resolvedFile))
}

/**
 * A vault-relative target expressed relative to the note that references it.
 *
 * Relative to the *note*, not the vault: that is what the editor resolves at
 * render time (`renderer/lib/resolve-note-relative-url.ts`) and what keeps the
 * vault readable by Obsidian. An absolute `memry-file://` URL renders on the
 * machine that wrote it and nowhere else, since it carries that machine's vault
 * path — see `resolve-embed.ts`, which picks the same shape for the same reason.
 *
 * Both arguments are vault-relative; the result always uses forward slashes,
 * because it goes into markdown rather than onto a Windows command line.
 */
export function noteRelativeRef(notePath: string, targetPath: string): string {
  const noteDir = path.posix.dirname(normalizeRelativePath(notePath))
  const from = noteDir === '.' ? '' : noteDir
  return path.posix.relative(from, normalizeRelativePath(targetPath))
}

/**
 * Checks if a path is safely within the vault directory.
 */
export function isPathInVault(vaultPath: string, filePath: string): boolean {
  const resolvedVault = path.resolve(vaultPath)
  const resolvedFile = path.resolve(filePath)

  return resolvedFile.startsWith(resolvedVault + path.sep)
}

/**
 * Generates a safe filename from a title.
 * Replaces special characters and limits length.
 */
export function safeFileName(title: string, maxLength = 100): string {
  return (
    title
      // Replace special characters with dashes
      .replace(UNSAFE_FILENAME_CHARS, '-')
      // Replace multiple spaces/dashes with single dash
      .replace(/[\s-]+/g, '-')
      // Remove leading/trailing dashes and spaces
      .replace(/^[-\s]+|[-\s]+$/g, '')
      // Limit length
      .slice(0, maxLength) ||
    // Ensure not empty
    'untitled'
  )
}

/**
 * Checks if a file has a markdown extension.
 */
export function isMarkdownFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.md' || ext === '.markdown'
}

/**
 * Gets the note title from a file path (filename without extension).
 */
export function getTitleFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath))
}

/**
 * Joins path segments safely, ensuring result stays within base path.
 */
export function safeJoin(basePath: string, ...segments: string[]): string | null {
  const joined = path.join(basePath, ...segments)
  const resolved = path.resolve(joined)
  const resolvedBase = path.resolve(basePath)

  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    return null
  }

  return resolved
}

export type VaultFileResolution =
  { kind: 'inside'; path: string } | { kind: 'outside' } | { kind: 'missing' }

function placeInVault(
  vaultPath: string,
  realVault: string,
  real: string,
  isTarget: boolean
): VaultFileResolution {
  const relative = path.relative(realVault, real)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { kind: 'outside' }
  }
  return isTarget
    ? { kind: 'inside', path: path.join(path.resolve(vaultPath), relative) }
    : { kind: 'missing' }
}

/**
 * Where a vault-relative path really points once symlinks are followed. A link
 * whose target leaves the real vault root, or whose target is gone, is
 * `outside`: a reader refuses it rather than follow it. A missing path is
 * placed by its nearest existing parent, so a missing file under a folder
 * linked outside is `outside` too and a reader cannot tell whether a file
 * exists out there. `path` is the real target re-rooted at `vaultPath`, so the
 * file checked is the file read and the path still sits under the vault path
 * the memry-file protocol allows.
 */
export async function resolveVaultFile(
  vaultPath: string,
  relativePath: string
): Promise<VaultFileResolution> {
  const joined = safeJoin(vaultPath, relativePath)
  if (joined === null) return { kind: 'outside' }
  const realVault = await realpath(vaultPath)
  for (let probe = joined; ; probe = path.dirname(probe)) {
    const real = await realpath(probe).catch(() => null)
    if (real !== null) return placeInVault(vaultPath, realVault, real, probe === joined)
    const isLink = await lstat(probe).then(
      (stats) => stats.isSymbolicLink(),
      () => false
    )
    if (isLink) return { kind: 'outside' }
  }
}

/** `resolveVaultFile` for readers that cannot await, such as the canvas store. */
export function resolveVaultFileSync(vaultPath: string, relativePath: string): VaultFileResolution {
  const joined = safeJoin(vaultPath, relativePath)
  if (joined === null) return { kind: 'outside' }
  const realVault = realpathSync.native(vaultPath)
  for (let probe = joined; ; probe = path.dirname(probe)) {
    const real = attempt(() => realpathSync.native(probe))
    if (real !== null) return placeInVault(vaultPath, realVault, real, probe === joined)
    if (attempt(() => lstatSync(probe).isSymbolicLink())) return { kind: 'outside' }
  }
}

/**
 * Throws `OutsideVaultError` for a vault file linked outside the vault. A reader
 * reads through `readVaultFile` instead, since the file can be swapped after this check.
 */
export function refuseOutsideVaultSync(vaultPath: string, relativePath: string): void {
  const resolved = resolveVaultFileSync(vaultPath, relativePath)
  if (resolved.kind === 'outside') throw new OutsideVaultError(relativePath)
}

// O_NONBLOCK keeps a FIFO named like a note from hanging the open; it is 0 on Windows.
const openFlags = (): number => constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)
// Never used, since the flags create nothing; CodeQL reads a missing mode as a world-readable create.
const OPEN_MODE = 0o600

const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino

/**
 * Opens a vault file for reading, or null when it is missing. Checking a path
 * and then using it by name leaves a window in which the file can be swapped
 * for a link outside the vault, so the check runs again once the file is open:
 * the opened file must be the file the path still resolves to inside the vault,
 * else `OutsideVaultError`. Read, stat and chmod through the returned handle.
 */
export async function openVaultFile(
  vaultPath: string,
  relativePath: string
): Promise<FileHandle | null> {
  if ((await resolveVaultFile(vaultPath, relativePath)).kind === 'outside') {
    throw new OutsideVaultError(relativePath)
  }
  const joined = path.join(vaultPath, relativePath)
  const handle = await open(joined, openFlags(), OPEN_MODE).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (handle === null) return null
  try {
    const opened = await handle.stat({ bigint: true })
    const now = await resolveVaultFile(vaultPath, relativePath)
    if (now.kind === 'inside' && sameFile(opened, await lstat(now.path, { bigint: true }))) {
      return handle
    }
  } catch (err) {
    await handle.close()
    throw err
  }
  await handle.close()
  throw new OutsideVaultError(relativePath)
}

/** `openVaultFile` for callers that cannot await. Returns a file descriptor. */
export function openVaultFileSync(vaultPath: string, relativePath: string): number | null {
  refuseOutsideVaultSync(vaultPath, relativePath)
  let fd: number
  try {
    fd = openSync(path.join(vaultPath, relativePath), openFlags(), OPEN_MODE)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const opened = fstatSync(fd, { bigint: true })
    const now = resolveVaultFileSync(vaultPath, relativePath)
    if (now.kind === 'inside' && sameFile(opened, lstatSync(now.path, { bigint: true }))) {
      return fd
    }
  } catch (err) {
    closeSync(fd)
    throw err
  }
  closeSync(fd)
  throw new OutsideVaultError(relativePath)
}

/** A vault file's text read through `openVaultFile`'s handle, or null when it is missing. */
export async function readVaultFile(
  vaultPath: string,
  relativePath: string
): Promise<string | null> {
  const handle = await openVaultFile(vaultPath, relativePath)
  if (handle === null) return null
  try {
    return await handle.readFile('utf-8')
  } finally {
    await handle.close()
  }
}

/** `readVaultFile` for callers that cannot await. */
export function readVaultFileSync(vaultPath: string, relativePath: string): string | null {
  const fd = openVaultFileSync(vaultPath, relativePath)
  if (fd === null) return null
  try {
    return readFileSync(fd, 'utf-8')
  } finally {
    closeSync(fd)
  }
}

function attempt<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

/**
 * Ensures a path has the .md extension.
 */
export function ensureMarkdownExtension(filePath: string): string {
  if (isMarkdownFile(filePath)) {
    return filePath
  }
  return filePath + '.md'
}

/**
 * Builds a memry-file:// URL from a local file path.
 * Uses 'local' as explicit host to avoid URL parsing issues where
 * the first path segment gets treated as hostname and lowercased.
 */
export function toMemryFileUrl(filePath: string): string {
  const normalized = path.normalize(filePath)

  if (process.platform === 'win32') {
    // Windows: memry-file://local/C:/path/to/file
    return `memry-file://local/${normalized.replace(/\\/g, '/')}`
  }

  // macOS/Linux: memry-file://local/Users/name/path
  const absolutePath = normalized.startsWith('/') ? normalized.slice(1) : normalized
  return `memry-file://local/${absolutePath}`
}

export function fromMemryFileUrl(url: string): string {
  const prefix = 'memry-file://local/'
  if (!url.startsWith(prefix)) {
    throw new Error(`Invalid memry-file URL: ${url}`)
  }
  const pathPart = url.slice(prefix.length)
  if (process.platform === 'win32') {
    return pathPart.replace(/\//g, '\\')
  }
  return '/' + pathPart
}
