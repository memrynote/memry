import path from 'path'

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

  return path.relative(resolvedVault, resolvedFile)
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
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      // Replace multiple spaces/dashes with single dash
      .replace(/[\s-]+/g, '-')
      // Remove leading/trailing dashes and spaces
      .replace(/^[-\s]+|[-\s]+$/g, '')
      // Limit length
      .slice(0, maxLength)
      // Ensure not empty
      || 'untitled'
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
 */
export function toMemryFileUrl(filePath: string): string {
  const normalized = path.normalize(filePath)

  if (process.platform === 'win32') {
    return `memry-file:///${normalized.replace(/\\/g, '/')}`
  }

  const absolutePath = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `memry-file://${absolutePath}`
}
