import path from 'path'

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
