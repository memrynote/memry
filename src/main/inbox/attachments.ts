/**
 * Inbox Attachment Management
 *
 * Handles storing, retrieving, and managing attachments for inbox items.
 * Attachments are stored in vault/attachments/inbox/{itemId}/
 *
 * @module main/inbox/attachments
 */

import { writeFile, readdir, rm, mkdir, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { customAlphabet } from 'nanoid'
import { getStatus } from '../vault'
import { toMemryFileUrl } from '../lib/paths'

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum file size for inbox attachments: 50MB
 */
export const MAX_INBOX_FILE_SIZE = 50 * 1024 * 1024

/**
 * Allowed image MIME types
 */
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml'
]

/**
 * Allowed audio MIME types
 */
export const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/mp3', 'audio/mpeg', 'audio/wav']

/**
 * Allowed document MIME types
 */
export const ALLOWED_DOCUMENT_TYPES = ['application/pdf']

/**
 * All allowed MIME types
 */
export const ALLOWED_MIME_TYPES = [
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_AUDIO_TYPES,
  ...ALLOWED_DOCUMENT_TYPES
]

/**
 * 6-character prefix generator for unique filenames
 */
const generatePrefix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6)

// ============================================================================
// Types
// ============================================================================

export interface InboxAttachmentResult {
  success: boolean
  /** Relative path from vault root to attachment */
  path?: string
  /** Relative path to thumbnail (if generated) */
  thumbnailPath?: string
  /** Error message if failed */
  error?: string
}

export interface InboxAttachmentInfo {
  filename: string
  path: string
  size: number
  mimeType: string
  type: 'image' | 'audio' | 'document'
}

// ============================================================================
// Error Handling
// ============================================================================

export const InboxAttachmentErrorCode = {
  NO_VAULT: 'INBOX_ATTACHMENT_NO_VAULT',
  INVALID_TYPE: 'INBOX_ATTACHMENT_INVALID_TYPE',
  FILE_TOO_LARGE: 'INBOX_ATTACHMENT_FILE_TOO_LARGE',
  WRITE_FAILED: 'INBOX_ATTACHMENT_WRITE_FAILED',
  NOT_FOUND: 'INBOX_ATTACHMENT_NOT_FOUND',
  DELETE_FAILED: 'INBOX_ATTACHMENT_DELETE_FAILED'
} as const

export type InboxAttachmentErrorCode =
  (typeof InboxAttachmentErrorCode)[keyof typeof InboxAttachmentErrorCode]

export class InboxAttachmentError extends Error {
  constructor(
    message: string,
    public code: InboxAttachmentErrorCode
  ) {
    super(message)
    this.name = 'InboxAttachmentError'
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the vault path, throwing if no vault is open
 */
function requireVaultPath(): string {
  const status = getStatus()
  if (!status.isOpen || !status.path) {
    throw new InboxAttachmentError('No vault is open', InboxAttachmentErrorCode.NO_VAULT)
  }
  return status.path
}

/**
 * Get the inbox attachments base directory
 */
export function getInboxAttachmentsDir(): string {
  const vaultPath = requireVaultPath()
  return path.join(vaultPath, 'attachments', 'inbox')
}

/**
 * Get the attachments directory for a specific inbox item
 */
export function getItemAttachmentsDir(itemId: string): string {
  return path.join(getInboxAttachmentsDir(), itemId)
}

/**
 * Determine attachment type from MIME type
 */
function getAttachmentType(mimeType: string): 'image' | 'audio' | 'document' | null {
  if (ALLOWED_IMAGE_TYPES.includes(mimeType)) return 'image'
  if (ALLOWED_AUDIO_TYPES.includes(mimeType)) return 'audio'
  if (ALLOWED_DOCUMENT_TYPES.includes(mimeType)) return 'document'
  return null
}

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'audio/webm': 'webm',
    'audio/mp3': 'mp3',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'application/pdf': 'pdf'
  }
  return mimeToExt[mimeType] || 'bin'
}

/**
 * Sanitize filename for safe storage
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9.-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 100)
}

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true })
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Store an attachment for an inbox item
 *
 * @param itemId - Inbox item ID
 * @param data - File data as Buffer
 * @param filename - Original filename
 * @param mimeType - MIME type of the file
 * @returns Result with relative path to stored file
 */
export async function storeInboxAttachment(
  itemId: string,
  data: Buffer,
  filename: string,
  mimeType: string
): Promise<InboxAttachmentResult> {
  try {
    // Validate MIME type
    const attachmentType = getAttachmentType(mimeType)
    if (!attachmentType) {
      return {
        success: false,
        error: `Unsupported file type: ${mimeType}`
      }
    }

    // Validate file size
    if (data.length > MAX_INBOX_FILE_SIZE) {
      return {
        success: false,
        error: `File too large: ${Math.round(data.length / 1024 / 1024)}MB exceeds limit of ${MAX_INBOX_FILE_SIZE / 1024 / 1024}MB`
      }
    }

    // Create item attachments directory
    const itemDir = getItemAttachmentsDir(itemId)
    await ensureDir(itemDir)

    // Generate unique filename
    // Remove existing extension from filename to avoid double extensions
    const ext = getExtensionFromMimeType(mimeType)
    const filenameWithoutExt = filename.replace(/\.[^.]+$/, '')
    const safeFilename = sanitizeFilename(filenameWithoutExt)
    const prefix = generatePrefix()
    const storedFilename = `${prefix}-${safeFilename}.${ext}`

    // Write file
    const filePath = path.join(itemDir, storedFilename)
    await writeFile(filePath, data)

    // Return relative path from vault root
    const vaultPath = requireVaultPath()
    const relativePath = path.relative(vaultPath, filePath)

    return {
      success: true,
      path: relativePath
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error storing attachment'
    return {
      success: false,
      error: message
    }
  }
}

/**
 * Store a thumbnail for an inbox item
 *
 * @param itemId - Inbox item ID
 * @param data - Thumbnail data as Buffer
 * @param format - Image format (default: 'jpg')
 * @returns Result with relative path to thumbnail
 */
export async function storeThumbnail(
  itemId: string,
  data: Buffer,
  format: 'jpg' | 'png' = 'jpg'
): Promise<InboxAttachmentResult> {
  try {
    const itemDir = getItemAttachmentsDir(itemId)
    await ensureDir(itemDir)

    const thumbnailFilename = `thumbnail.${format}`
    const filePath = path.join(itemDir, thumbnailFilename)
    await writeFile(filePath, data)

    const vaultPath = requireVaultPath()
    const relativePath = path.relative(vaultPath, filePath)

    return {
      success: true,
      thumbnailPath: relativePath
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error storing thumbnail'
    return {
      success: false,
      error: message
    }
  }
}

/**
 * Delete all attachments for an inbox item
 *
 * @param itemId - Inbox item ID
 */
export async function deleteInboxAttachments(itemId: string): Promise<void> {
  const itemDir = getItemAttachmentsDir(itemId)

  if (existsSync(itemDir)) {
    await rm(itemDir, { recursive: true, force: true })
  }
}

/**
 * List attachments for an inbox item
 *
 * @param itemId - Inbox item ID
 * @returns Array of attachment info
 */
export async function listInboxAttachments(itemId: string): Promise<InboxAttachmentInfo[]> {
  const itemDir = getItemAttachmentsDir(itemId)

  if (!existsSync(itemDir)) {
    return []
  }

  const files = await readdir(itemDir, { withFileTypes: true })
  const vaultPath = requireVaultPath()

  const attachments: InboxAttachmentInfo[] = []

  for (const file of files) {
    if (!file.isFile()) continue

    // Skip thumbnails in the listing
    if (file.name.startsWith('thumbnail.')) continue

    const filePath = path.join(itemDir, file.name)
    const relativePath = path.relative(vaultPath, filePath)

    // Determine type from extension
    const ext = path.extname(file.name).toLowerCase().slice(1)
    let type: 'image' | 'audio' | 'document' = 'document'
    let mimeType = 'application/octet-stream'

    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
      type = 'image'
      mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
    } else if (['webm', 'mp3', 'wav'].includes(ext)) {
      type = 'audio'
      mimeType = `audio/${ext}`
    } else if (ext === 'pdf') {
      type = 'document'
      mimeType = 'application/pdf'
    }

    attachments.push({
      filename: file.name,
      path: relativePath,
      size: 0, // Would need stat call for actual size
      mimeType,
      type
    })
  }

  return attachments
}

/**
 * Move attachments from inbox item to a note's attachment folder
 *
 * @param itemId - Inbox item ID
 * @param noteId - Target note ID
 * @returns Array of new relative paths
 */
export async function moveAttachmentsToNote(itemId: string, noteId: string): Promise<string[]> {
  const vaultPath = requireVaultPath()
  const sourceDir = getItemAttachmentsDir(itemId)

  if (!existsSync(sourceDir)) {
    return []
  }

  // Target: vault/attachments/notes/{noteId}/
  const targetDir = path.join(vaultPath, 'attachments', 'notes', noteId)
  await ensureDir(targetDir)

  const files = await readdir(sourceDir, { withFileTypes: true })
  const movedPaths: string[] = []

  for (const file of files) {
    if (!file.isFile()) continue

    // Skip thumbnails (not needed for notes)
    if (file.name.startsWith('thumbnail.')) continue

    const sourcePath = path.join(sourceDir, file.name)
    const targetPath = path.join(targetDir, file.name)

    // Copy instead of rename to avoid cross-device issues
    await copyFile(sourcePath, targetPath)

    const relativePath = path.relative(vaultPath, targetPath)
    movedPaths.push(relativePath)
  }

  // Clean up source directory
  await rm(sourceDir, { recursive: true, force: true })

  return movedPaths
}

/**
 * Resolve a relative attachment path to a full file:// URL for the renderer
 *
 * @param relativePath - Path relative to vault root
 * @returns Full file URL or memry-file:// protocol URL
 */
export function resolveAttachmentUrl(relativePath: string | null): string | null {
  if (!relativePath) return null

  try {
    const vaultPath = requireVaultPath()
    const fullPath = path.join(vaultPath, relativePath)

    // Use custom protocol for security
    const url = toMemryFileUrl(fullPath)

    return url
  } catch {
    return null
  }
}

/**
 * Check if an inbox item has attachments
 *
 * @param itemId - Inbox item ID
 * @returns true if attachments exist
 */
export function hasAttachments(itemId: string): boolean {
  const itemDir = getItemAttachmentsDir(itemId)
  return existsSync(itemDir)
}
