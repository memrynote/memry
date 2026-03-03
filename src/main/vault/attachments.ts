/**
 * Attachment operations for note file attachments.
 * Handles saving, deleting, and managing attachments in per-note folders.
 *
 * @module vault/attachments
 */

import { writeFile, unlink, readdir, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { customAlphabet } from 'nanoid'
import { ensureDirectory, sanitizeFilename } from './file-ops'
import { toMemryFileUrl } from '../lib/paths'
import { getStatus } from './index'
import { VaultError, VaultErrorCode } from '../lib/errors'

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Error codes for attachment operations
 */
export const AttachmentErrorCode = {
  INVALID_FILE_TYPE: 'ATTACHMENT_INVALID_FILE_TYPE',
  FILE_TOO_LARGE: 'ATTACHMENT_FILE_TOO_LARGE',
  WRITE_FAILED: 'ATTACHMENT_WRITE_FAILED',
  DELETE_FAILED: 'ATTACHMENT_DELETE_FAILED',
  NOT_FOUND: 'ATTACHMENT_NOT_FOUND',
  NO_VAULT: 'ATTACHMENT_NO_VAULT'
} as const

export type AttachmentErrorCode = (typeof AttachmentErrorCode)[keyof typeof AttachmentErrorCode]

/**
 * Error for attachment-related operations.
 */
export class AttachmentError extends Error {
  constructor(
    message: string,
    public code: AttachmentErrorCode
  ) {
    super(message)
    this.name = 'AttachmentError'
  }
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum file size: 10MB
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024

/**
 * Allowed image file extensions
 */
export const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']

/**
 * Allowed document/file extensions
 */
export const ALLOWED_FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md']

/**
 * All allowed extensions combined
 */
export const ALLOWED_EXTENSIONS = [...ALLOWED_IMAGE_EXTENSIONS, ...ALLOWED_FILE_EXTENSIONS]

/**
 * 6-character prefix generator for unique filenames
 */
const generatePrefix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6)

// ============================================================================
// Types
// ============================================================================

export interface AttachmentResult {
  success: boolean
  /** Relative path from note to attachment (e.g., ../attachments/{noteId}/abc123-image.png) */
  path?: string
  /** Original filename */
  name?: string
  /** File size in bytes */
  size?: number
  /** MIME type */
  mimeType?: string
  /** Category: image or file */
  type?: 'image' | 'file'
  /** Error message if failed */
  error?: string
}

export interface AttachmentInfo {
  filename: string
  path: string
  size: number
  mimeType: string
  type: 'image' | 'file'
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Get file extension (lowercase, without dot)
 */
export function getFileExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return ext.startsWith('.') ? ext.slice(1) : ext
}

/**
 * Check if a file type is allowed
 */
export function isAllowedFileType(filename: string): boolean {
  const ext = getFileExtension(filename)
  return ALLOWED_EXTENSIONS.includes(ext)
}

/**
 * Get the category of a file: 'image' or 'file'
 */
export function getFileType(filename: string): 'image' | 'file' {
  const ext = getFileExtension(filename)
  return ALLOWED_IMAGE_EXTENSIONS.includes(ext) ? 'image' : 'file'
}

/**
 * Get MIME type from filename
 */
export function getMimeType(filename: string): string {
  const ext = getFileExtension(filename)
  const mimeTypes: Record<string, string> = {
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    // Documents
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    txt: 'text/plain',
    md: 'text/markdown'
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

/**
 * Validate file size (throws if too large)
 */
export function validateFileSize(size: number): void {
  if (size > MAX_FILE_SIZE) {
    throw new AttachmentError(
      `File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}, got ${formatFileSize(size)}`,
      AttachmentErrorCode.FILE_TOO_LARGE
    )
  }
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get the attachments directory for a specific note
 */
export function getNoteAttachmentsDir(vaultPath: string, noteId: string): string {
  return path.join(vaultPath, 'attachments', noteId)
}

/**
 * Get the full path for an attachment
 */
export function getAttachmentPath(vaultPath: string, noteId: string, filename: string): string {
  return path.join(getNoteAttachmentsDir(vaultPath, noteId), filename)
}

/**
 * Get the memry-file:// URL for an attachment (for Electron rendering)
 * Uses custom protocol handler to serve local files securely
 * @param vaultPath - The vault root path
 * @param noteId - The note ID
 * @param filename - The attachment filename
 */
export function getAbsoluteAttachmentUrl(
  vaultPath: string,
  noteId: string,
  filename: string
): string {
  const absolutePath = path.join(vaultPath, 'attachments', noteId, filename)
  // Use custom memry-file:// protocol for secure file access
  return toMemryFileUrl(absolutePath)
}

/**
 * Generate a unique filename with prefix
 * Format: {6-char-prefix}-{sanitized-original-name}
 */
export function generateUniqueFilename(originalFilename: string): string {
  const prefix = generatePrefix()
  const ext = path.extname(originalFilename)
  const baseName = path.basename(originalFilename, ext)
  const sanitizedName = sanitizeFilename(baseName)
  return `${prefix}-${sanitizedName}${ext}`
}

// ============================================================================
// Vault Access
// ============================================================================

/**
 * Get the vault path, throwing if no vault is open.
 */
function getVaultPath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }
  return status.path
}

// ============================================================================
// Core Operations
// ============================================================================

/**
 * Ensure the attachments folder for a note exists
 */
export async function ensureNoteAttachmentsFolder(noteId: string): Promise<string> {
  const vaultPath = getVaultPath()
  const attachmentsDir = getNoteAttachmentsDir(vaultPath, noteId)
  await ensureDirectory(attachmentsDir)
  return attachmentsDir
}

/**
 * Save an attachment to the vault
 *
 * @param noteId - The note ID to associate the attachment with
 * @param data - File contents as Buffer
 * @param originalFilename - Original filename (for extension and display name)
 * @returns AttachmentResult with path and metadata
 */
export async function saveAttachment(
  noteId: string,
  data: Buffer,
  originalFilename: string
): Promise<AttachmentResult> {
  // Validate file type
  if (!isAllowedFileType(originalFilename)) {
    const ext = getFileExtension(originalFilename)
    return {
      success: false,
      error: `File type ".${ext}" is not allowed. Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}`
    }
  }

  // Validate file size
  try {
    validateFileSize(data.length)
  } catch (error) {
    if (error instanceof AttachmentError) {
      return { success: false, error: error.message }
    }
    throw error
  }

  try {
    const vaultPath = getVaultPath()

    // Ensure note attachments folder exists
    const attachmentsDir = await ensureNoteAttachmentsFolder(noteId)

    // Generate unique filename
    const uniqueFilename = generateUniqueFilename(originalFilename)
    const filePath = path.join(attachmentsDir, uniqueFilename)

    // Write file
    await writeFile(filePath, data)

    // Return success with metadata (using absolute file:// URL for Electron)
    return {
      success: true,
      path: getAbsoluteAttachmentUrl(vaultPath, noteId, uniqueFilename),
      name: originalFilename,
      size: data.length,
      mimeType: getMimeType(originalFilename),
      type: getFileType(originalFilename)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: `Failed to save attachment: ${message}` }
  }
}

/**
 * Delete a specific attachment
 *
 * @param noteId - The note ID
 * @param filename - The filename to delete
 */
export async function deleteAttachment(noteId: string, filename: string): Promise<void> {
  const vaultPath = getVaultPath()
  const filePath = getAttachmentPath(vaultPath, noteId, filename)

  try {
    await unlink(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      // File already doesn't exist, that's fine
      return
    }
    throw new AttachmentError(
      `Failed to delete attachment: ${filename}`,
      AttachmentErrorCode.DELETE_FAILED
    )
  }
}

/**
 * Delete all attachments for a note (when note is deleted)
 *
 * @param noteId - The note ID
 */
export async function deleteNoteAttachments(noteId: string): Promise<void> {
  const vaultPath = getVaultPath()
  const attachmentsDir = getNoteAttachmentsDir(vaultPath, noteId)

  if (!existsSync(attachmentsDir)) {
    return // No attachments folder, nothing to delete
  }

  try {
    await rm(attachmentsDir, { recursive: true, force: true })
  } catch {
    throw new AttachmentError(
      `Failed to delete attachments folder for note: ${noteId}`,
      AttachmentErrorCode.DELETE_FAILED
    )
  }
}

/**
 * List all attachments for a note
 *
 * @param noteId - The note ID
 * @returns Array of attachment info
 */
export async function listNoteAttachments(noteId: string): Promise<AttachmentInfo[]> {
  const vaultPath = getVaultPath()
  const attachmentsDir = getNoteAttachmentsDir(vaultPath, noteId)

  if (!existsSync(attachmentsDir)) {
    return []
  }

  try {
    const entries = await readdir(attachmentsDir, { withFileTypes: true })
    const attachments: AttachmentInfo[] = []

    for (const entry of entries) {
      if (!entry.isFile()) continue

      const filePath = path.join(attachmentsDir, entry.name)
      const stats = await stat(filePath)

      attachments.push({
        filename: entry.name,
        path: getAbsoluteAttachmentUrl(vaultPath, noteId, entry.name),
        size: stats.size,
        mimeType: getMimeType(entry.name),
        type: getFileType(entry.name)
      })
    }

    return attachments
  } catch {
    return []
  }
}

/**
 * Check if an attachment exists
 */
export function attachmentExists(noteId: string, filename: string): boolean {
  try {
    const vaultPath = getVaultPath()
    const filePath = getAttachmentPath(vaultPath, noteId, filename)
    return existsSync(filePath)
  } catch {
    return false
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Type guard for Node.js errors with error codes
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
