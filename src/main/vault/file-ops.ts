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

// ============================================================================
// Atomic Write
// ============================================================================

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
  const tempPath = path.join(dir, `.${randomBytes(6).toString('hex')}.tmp`)

  try {
    // Ensure directory exists
    await ensureDirectory(dir)

    // Write to temporary file
    await writeFile(tempPath, content, 'utf-8')

    // Atomic rename (overwrites existing file)
    await rename(tempPath, filePath)
  } catch {
    // Clean up temp file on error
    try {
      if (existsSync(tempPath)) {
        await unlink(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }

    throw new NoteError(`Failed to write file: ${filePath}`, NoteErrorCode.WRITE_FAILED)
  }
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

    throw new NoteError(`Failed to read file: ${filePath}`, NoteErrorCode.READ_FAILED)
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
          const filePath = relativeTo ? path.relative(relativeTo, fullPath) : fullPath
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
          const dirPath = relativeTo ? path.relative(relativeTo, fullPath) : fullPath
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

    throw new NoteError(`Failed to delete file: ${filePath}`, NoteErrorCode.DELETE_FAILED)
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
 * Removes or replaces invalid characters.
 *
 * @param filename - Raw filename
 * @returns Sanitized filename
 */
export function sanitizeFilename(filename: string): string {
  // Remove or replace invalid characters
  let sanitized = filename
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
    .replace(/\s+/g, ' ') // Collapse whitespace
    .trim()

  // Ensure it doesn't start with a dot (hidden file)
  if (sanitized.startsWith('.')) {
    sanitized = sanitized.slice(1)
  }

  // Ensure it's not empty
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Type guard for Node.js errors with error codes.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
