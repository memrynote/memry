/**
 * Atomic file operations for safe reading and writing.
 * Uses write-to-temp-then-rename pattern to prevent data corruption.
 *
 * @module vault/file-ops
 */

import { writeFile, readFile, rename, unlink, mkdir, stat, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import path from 'path'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { normalizeRelativePath } from '../lib/paths'
import { createLogger } from '../lib/logger'

const logger = createLogger('FileOps')

// ============================================================================
// Atomic Write
// ============================================================================

const TRANSIENT_FS_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const TRANSIENT_FS_RETRY_DELAYS_MS = [50, 150, 450]

/**
 * Retry an fs operation that fails with a transient sharing violation
 * (EBUSY/EPERM/EACCES) — on Windows, cloud-sync clients and antivirus
 * scanners briefly lock vault files. Non-retryable errors propagate
 * immediately; retryable ones are retried with backoff before the final
 * attempt's error propagates.
 */
export async function withTransientFsRetry<T>(
  operation: () => Promise<T>,
  operationName = 'fs'
): Promise<T> {
  for (const [index, delayMs] of TRANSIENT_FS_RETRY_DELAYS_MS.entries()) {
    try {
      return await operation()
    } catch (error) {
      if (!isNodeError(error) || !TRANSIENT_FS_ERROR_CODES.has(error.code ?? '')) {
        throw error
      }
      // Only the errno and attempt number — never the path, which is note-derived.
      // This is the local-log counterpart to NoteError.telemetryCode: it explains
      // a slow or failed save even when telemetry is off.
      logger.warn(
        `${operationName}: transient ${error.code} on attempt ${index + 1} of ` +
          `${TRANSIENT_FS_RETRY_DELAYS_MS.length + 1}, retrying in ${delayMs}ms`
      )
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  return operation()
}

/**
 * Write content to a file atomically using temp-file-then-rename pattern.
 * Ensures file integrity even if the app crashes during write.
 *
 * @param filePath - Absolute path to the target file
 * @param content - Content to write
 * @throws NoteError if write fails
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)

  try {
    // Ensure directory exists
    await ensureDirectory(dir)

    // Each attempt uses a fresh temp file so a failed attempt can't collide
    // with its own leftovers on retry.
    await withTransientFsRetry(async () => {
      const tempPath = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`)

      try {
        // Write to the uniquely-named temp file exclusively (wx) with owner-only
        // permissions, so a pre-existing symlink in a shared directory can't be
        // followed and the temp contents can't be read by other users.
        await writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })

        // Atomic rename (overwrites existing file)
        await rename(tempPath, filePath)
      } catch (error) {
        // Clean up temp file on error
        try {
          if (existsSync(tempPath)) {
            await unlink(tempPath)
          }
        } catch {
          // Ignore cleanup errors
        }

        throw error
      }
    }, 'atomicWrite')
  } catch (error) {
    // Preserve the originating error: its errno is the only thing that tells a
    // cloud-sync/antivirus lock (EBUSY) apart from a full disk (ENOSPC) or a
    // read-only vault (EROFS) once the report reaches us.
    throw new NoteError(
      `Failed to write file: ${filePath}`,
      NoteErrorCode.WRITE_FAILED,
      undefined,
      {
        cause: error
      }
    )
  }
}

/**
 * Write only when the content differs from what is on disk. Skipping the
 * write entirely means no mtime churn, no watcher echo and no sync item for
 * no-op saves.
 *
 * @returns true when a write happened, false when the file already matched
 */
export async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  const existing = await safeRead(filePath)
  if (existing === content) return false
  await atomicWrite(filePath, content)
  return true
}

// ============================================================================
// Safe Read
// ============================================================================

/**
 * Read a file safely with proper error handling.
 *
 * @param filePath - Absolute path to the file
 * @returns File content as string, or null if file doesn't exist
 * @throws NoteError if read fails for reasons other than file not existing
 */
export async function safeRead(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return content
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null
    }

    throw new NoteError(`Failed to read file: ${filePath}`, NoteErrorCode.READ_FAILED, undefined, {
      cause: error
    })
  }
}

/**
 * Read a file, throwing an error if it doesn't exist.
 *
 * @param filePath - Absolute path to the file
 * @returns File content as string
 * @throws NoteError if file doesn't exist or read fails
 */
export async function readRequired(filePath: string): Promise<string> {
  const content = await safeRead(filePath)

  if (content === null) {
    throw new NoteError(`File not found: ${filePath}`, NoteErrorCode.NOT_FOUND)
  }

  return content
}

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * Ensure a directory exists, creating it recursively if needed.
 *
 * @param dirPath - Absolute path to the directory
 */
export async function ensureDirectory(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return // Directory already exists
    }
    throw error
  }
}

/**
 * List all markdown files in a directory recursively.
 *
 * @param dirPath - Absolute path to the directory
 * @param relativeTo - Base path for relative paths (optional)
 * @returns Array of file paths
 */
export async function listMarkdownFiles(dirPath: string, relativeTo?: string): Promise<string[]> {
  const files: string[] = []

  async function scanDir(currentPath: string): Promise<void> {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        // Skip hidden files and directories
        if (entry.name.startsWith('.')) {
          continue
        }

        const fullPath = path.join(currentPath, entry.name)

        if (entry.isDirectory()) {
          await scanDir(fullPath)
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = relativeTo
            ? normalizeRelativePath(path.relative(relativeTo, fullPath))
            : fullPath
          files.push(filePath)
        }
      }
    } catch (error) {
      // Skip directories we can't read
      if (isNodeError(error) && error.code === 'EACCES') {
        return
      }
      throw error
    }
  }

  if (existsSync(dirPath)) {
    await scanDir(dirPath)
  }

  return files
}

/**
 * List all subdirectories in a directory.
 *
 * @param dirPath - Absolute path to the directory
 * @param relativeTo - Base path for relative paths (optional)
 * @returns Array of directory paths
 */
export async function listDirectories(dirPath: string, relativeTo?: string): Promise<string[]> {
  const dirs: string[] = []

  async function scanDir(currentPath: string): Promise<void> {
    try {
      const entries = await readdir(currentPath, { withFileTypes: true })

      for (const entry of entries) {
        // Skip hidden directories
        if (entry.name.startsWith('.')) {
          continue
        }

        if (entry.isDirectory()) {
          const fullPath = path.join(currentPath, entry.name)
          const dirPath = relativeTo
            ? normalizeRelativePath(path.relative(relativeTo, fullPath))
            : fullPath
          dirs.push(dirPath)
          await scanDir(fullPath)
        }
      }
    } catch (error) {
      // Skip directories we can't read
      if (isNodeError(error) && error.code === 'EACCES') {
        return
      }
      throw error
    }
  }

  if (existsSync(dirPath)) {
    await scanDir(dirPath)
  }

  return dirs
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Delete a file safely.
 *
 * @param filePath - Absolute path to the file
 * @throws NoteError if delete fails
 */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return // File already doesn't exist
    }

    throw new NoteError(
      `Failed to delete file: ${filePath}`,
      NoteErrorCode.DELETE_FAILED,
      undefined,
      { cause: error }
    )
  }
}

// ============================================================================
// File Metadata
// ============================================================================

/**
 * Check if a file exists.
 *
 * @param filePath - Absolute path to the file
 * @returns True if file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

/**
 * Check if a directory exists.
 *
 * @param dirPath - Absolute path to the directory
 * @returns True if directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stats = await stat(dirPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Get file stats safely.
 *
 * @param filePath - Absolute path to the file
 * @returns File stats or null if file doesn't exist
 */
export async function getFileStats(filePath: string): Promise<{
  size: number
  createdAt: Date
  modifiedAt: Date
} | null> {
  try {
    const stats = await stat(filePath)
    return {
      size: stats.size,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime
    }
  } catch {
    return null
  }
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Sanitize a filename to be safe for the file system.
 * Strips platform-invalid characters plus `[ ] # ^`, which Obsidian ≥1.8
 * forbids in filenames (they break wikilink syntax).
 *
 * @param filename - Raw filename
 * @returns Sanitized filename
 */
export function sanitizeFilename(filename: string): string {
  // Remove or replace invalid characters
  let sanitized = filename
    .replace(/[<>:"/\\|?*[\]#^]/g, '') // Remove platform + Obsidian-forbidden chars
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim()

  // Strip every leading dot (hidden files) and re-trim any whitespace it
  // exposes. Loop because stripping the widened char set can leave `..` or
  // `. Report`; a single slice would keep a `..` traversal or a leading space.
  while (sanitized.startsWith('.')) {
    sanitized = sanitized.slice(1).trim()
  }

  // Ensure it's not empty (also catches bare `.` / `..`, which reduce to '')
  if (sanitized.length === 0) {
    sanitized = 'untitled'
  }

  // Truncate if too long (max 200 chars for filename)
  if (sanitized.length > 200) {
    sanitized = sanitized.slice(0, 200)
  }

  return sanitized
}

/**
 * Generate a safe file path for a note.
 *
 * @param notesDir - Base notes directory
 * @param title - Note title
 * @param folder - Optional subfolder
 * @returns Absolute file path
 */
export function generateNotePath(notesDir: string, title: string, folder?: string): string {
  const filename = sanitizeFilename(title) + '.md'

  if (folder) {
    return path.join(notesDir, folder, filename)
  }

  return path.join(notesDir, filename)
}

export function generateFilePath(
  notesDir: string,
  title: string,
  extension: string,
  folder?: string
): string {
  const filename = sanitizeFilename(title) + '.' + extension

  if (folder) {
    return path.join(notesDir, folder, filename)
  }

  return path.join(notesDir, filename)
}

/**
 * Generate a unique file path, adding a number suffix if file exists.
 *
 * @param basePath - Desired file path
 * @returns Unique file path
 */
export async function generateUniquePath(basePath: string): Promise<string> {
  if (!(await fileExists(basePath))) {
    return basePath
  }

  const dir = path.dirname(basePath)
  const ext = path.extname(basePath)
  const name = path.basename(basePath, ext)

  let counter = 1
  let newPath: string

  do {
    newPath = path.join(dir, `${name} ${counter}${ext}`)
    counter++
  } while (await fileExists(newPath))

  return newPath
}

export function generateUniquePathSync(
  basePath: string,
  isPathTaken?: (p: string) => boolean
): string {
  const taken = (p: string) => existsSync(p) || (isPathTaken?.(p) ?? false)
  if (!taken(basePath)) return basePath

  const dir = path.dirname(basePath)
  const ext = path.extname(basePath)
  const name = path.basename(basePath, ext)
  let counter = 1
  let candidate: string
  do {
    candidate = path.join(dir, `${name} ${counter}${ext}`)
    counter++
  } while (taken(candidate))
  return candidate
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Type guard for Node.js errors with error codes.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
