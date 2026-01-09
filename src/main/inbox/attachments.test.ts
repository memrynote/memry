/**
 * Inbox Attachment Management Tests
 *
 * Tests for storing, retrieving, and managing attachments for inbox items.
 *
 * @module main/inbox/attachments.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  storeInboxAttachment,
  storeThumbnail,
  deleteInboxAttachments,
  listInboxAttachments,
  moveAttachmentsToNote,
  resolveAttachmentUrl,
  hasAttachments,
  getInboxAttachmentsDir,
  getItemAttachmentsDir,
  MAX_INBOX_FILE_SIZE,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_AUDIO_TYPES,
  ALLOWED_DOCUMENT_TYPES
} from './attachments'

// Mock the vault module
vi.mock('../vault', () => ({
  getStatus: vi.fn()
}))

// Mock paths module
vi.mock('../lib/paths', () => ({
  toMemryFileUrl: vi.fn((path: string) => `memry-file://${encodeURIComponent(path)}`)
}))

import { getStatus } from '../vault'
import { toMemryFileUrl } from '../lib/paths'

describe('Inbox Attachment Management', () => {
  let testVaultPath: string

  beforeEach(() => {
    // Create temp vault directory
    testVaultPath = path.join(os.tmpdir(), `memry-test-${Date.now()}`)
    mkdirSync(testVaultPath, { recursive: true })

    vi.mocked(getStatus).mockReturnValue({
      isOpen: true,
      path: testVaultPath,
      name: 'Test Vault',
      isIndexing: false,
      indexProgress: 100,
      error: null
    } as ReturnType<typeof getStatus>)
  })

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(testVaultPath, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T416: getInboxAttachmentsDir and getItemAttachmentsDir
  // ==========================================================================
  describe('Directory Helpers', () => {
    it('should return inbox attachments base directory', () => {
      const dir = getInboxAttachmentsDir()
      expect(dir).toBe(path.join(testVaultPath, 'attachments', 'inbox'))
    })

    it('should return item-specific attachments directory', () => {
      const dir = getItemAttachmentsDir('item-123')
      expect(dir).toBe(path.join(testVaultPath, 'attachments', 'inbox', 'item-123'))
    })

    it('should throw when no vault is open', () => {
      vi.mocked(getStatus).mockReturnValue({
        isOpen: false,
        path: null
      } as ReturnType<typeof getStatus>)

      expect(() => getInboxAttachmentsDir()).toThrow('No vault is open')
    })
  })

  // ==========================================================================
  // T417: storeInboxAttachment and storeThumbnail
  // ==========================================================================
  describe('storeInboxAttachment', () => {
    it('should store image attachment and return relative path', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake image data')
      const filename = 'test-image.png'
      const mimeType = 'image/png'

      const result = await storeInboxAttachment(itemId, data, filename, mimeType)

      expect(result.success).toBe(true)
      expect(result.path).toBeDefined()
      expect(result.path).toContain('attachments/inbox/item-123')
      expect(result.path).toContain('.png')

      // Verify file was created
      const fullPath = path.join(testVaultPath, result.path!)
      expect(existsSync(fullPath)).toBe(true)
    })

    it('should store audio attachment', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake audio data')
      const filename = 'recording.webm'
      const mimeType = 'audio/webm'

      const result = await storeInboxAttachment(itemId, data, filename, mimeType)

      expect(result.success).toBe(true)
      expect(result.path).toContain('.webm')
    })

    it('should store PDF attachment', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake pdf data')
      const filename = 'document.pdf'
      const mimeType = 'application/pdf'

      const result = await storeInboxAttachment(itemId, data, filename, mimeType)

      expect(result.success).toBe(true)
      expect(result.path).toContain('.pdf')
    })

    it('should reject unsupported MIME types', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake data')
      const filename = 'malware.exe'
      const mimeType = 'application/x-msdownload'

      const result = await storeInboxAttachment(itemId, data, filename, mimeType)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Unsupported file type')
    })

    it('should reject files exceeding size limit', async () => {
      const itemId = 'item-123'
      // Create buffer larger than MAX_INBOX_FILE_SIZE
      const data = Buffer.alloc(MAX_INBOX_FILE_SIZE + 1)
      const filename = 'large-file.png'
      const mimeType = 'image/png'

      const result = await storeInboxAttachment(itemId, data, filename, mimeType)

      expect(result.success).toBe(false)
      expect(result.error).toContain('too large')
    })

    it('should sanitize filenames', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake data')
      const filename = 'test file with spaces & special!chars.png'
      const mimeType = 'image/png'

      const result = await storeInboxAttachment(itemId, data, filename, mimeType)

      expect(result.success).toBe(true)
      // Filename should be sanitized (no spaces, special chars replaced)
      expect(result.path).not.toContain(' ')
      expect(result.path).not.toContain('&')
      expect(result.path).not.toContain('!')
    })

    it('should generate unique filenames with prefix', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake data')
      const filename = 'test.png'
      const mimeType = 'image/png'

      const result1 = await storeInboxAttachment(itemId, data, filename, mimeType)
      const result2 = await storeInboxAttachment(itemId, data, filename, mimeType)

      expect(result1.path).not.toBe(result2.path)
    })
  })

  describe('storeThumbnail', () => {
    it('should store thumbnail with default jpg format', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake thumbnail data')

      const result = await storeThumbnail(itemId, data)

      expect(result.success).toBe(true)
      expect(result.thumbnailPath).toBeDefined()
      expect(result.thumbnailPath).toContain('thumbnail.jpg')
    })

    it('should store thumbnail with png format', async () => {
      const itemId = 'item-123'
      const data = Buffer.from('fake thumbnail data')

      const result = await storeThumbnail(itemId, data, 'png')

      expect(result.success).toBe(true)
      expect(result.thumbnailPath).toContain('thumbnail.png')
    })
  })

  // ==========================================================================
  // T418: deleteInboxAttachments and listInboxAttachments
  // ==========================================================================
  describe('deleteInboxAttachments', () => {
    it('should delete all attachments for an item', async () => {
      const itemId = 'item-123'

      // Create some attachments first
      await storeInboxAttachment(itemId, Buffer.from('data1'), 'file1.png', 'image/png')
      await storeInboxAttachment(itemId, Buffer.from('data2'), 'file2.jpg', 'image/jpeg')
      await storeThumbnail(itemId, Buffer.from('thumb'))

      const itemDir = getItemAttachmentsDir(itemId)
      expect(existsSync(itemDir)).toBe(true)

      await deleteInboxAttachments(itemId)

      expect(existsSync(itemDir)).toBe(false)
    })

    it('should not throw when directory does not exist', async () => {
      await expect(deleteInboxAttachments('nonexistent')).resolves.not.toThrow()
    })
  })

  describe('listInboxAttachments', () => {
    it('should return empty array when no attachments', async () => {
      const attachments = await listInboxAttachments('nonexistent')
      expect(attachments).toEqual([])
    })

    it('should list all attachments for an item', async () => {
      const itemId = 'item-123'

      await storeInboxAttachment(itemId, Buffer.from('data1'), 'image.png', 'image/png')
      await storeInboxAttachment(itemId, Buffer.from('data2'), 'audio.webm', 'audio/webm')

      const attachments = await listInboxAttachments(itemId)

      expect(attachments).toHaveLength(2)
      expect(attachments.some((a) => a.type === 'image')).toBe(true)
      expect(attachments.some((a) => a.type === 'audio')).toBe(true)
    })

    it('should exclude thumbnails from listing', async () => {
      const itemId = 'item-123'

      await storeInboxAttachment(itemId, Buffer.from('data'), 'file.png', 'image/png')
      await storeThumbnail(itemId, Buffer.from('thumb'))

      const attachments = await listInboxAttachments(itemId)

      expect(attachments).toHaveLength(1)
      expect(attachments[0].filename).not.toContain('thumbnail')
    })

    it('should include correct metadata for each attachment', async () => {
      const itemId = 'item-123'

      await storeInboxAttachment(itemId, Buffer.from('image data'), 'photo.jpg', 'image/jpeg')

      const attachments = await listInboxAttachments(itemId)

      expect(attachments[0]).toMatchObject({
        type: 'image',
        mimeType: 'image/jpeg'
      })
      expect(attachments[0].path).toContain('attachments/inbox/item-123')
    })
  })

  // ==========================================================================
  // T419: moveAttachmentsToNote
  // ==========================================================================
  describe('moveAttachmentsToNote', () => {
    it('should move attachments to note folder', async () => {
      const itemId = 'item-123'
      const noteId = 'note-456'

      await storeInboxAttachment(itemId, Buffer.from('data1'), 'file1.png', 'image/png')
      await storeInboxAttachment(itemId, Buffer.from('data2'), 'file2.jpg', 'image/jpeg')

      const movedPaths = await moveAttachmentsToNote(itemId, noteId)

      expect(movedPaths).toHaveLength(2)
      movedPaths.forEach((p) => {
        expect(p).toContain('attachments/notes/note-456')
      })

      // Original directory should be deleted
      expect(existsSync(getItemAttachmentsDir(itemId))).toBe(false)

      // Files should exist in new location
      const noteDir = path.join(testVaultPath, 'attachments', 'notes', noteId)
      expect(existsSync(noteDir)).toBe(true)
    })

    it('should skip thumbnails when moving', async () => {
      const itemId = 'item-123'
      const noteId = 'note-456'

      await storeInboxAttachment(itemId, Buffer.from('data'), 'file.png', 'image/png')
      await storeThumbnail(itemId, Buffer.from('thumb'))

      const movedPaths = await moveAttachmentsToNote(itemId, noteId)

      expect(movedPaths).toHaveLength(1)
      expect(movedPaths[0]).not.toContain('thumbnail')
    })

    it('should return empty array when no attachments exist', async () => {
      const movedPaths = await moveAttachmentsToNote('nonexistent', 'note-456')
      expect(movedPaths).toEqual([])
    })
  })

  // ==========================================================================
  // T420: resolveAttachmentUrl and hasAttachments
  // ==========================================================================
  describe('resolveAttachmentUrl', () => {
    it('should return null for null path', () => {
      expect(resolveAttachmentUrl(null)).toBeNull()
    })

    it('should return memry-file:// URL for valid path', () => {
      const relativePath = 'attachments/inbox/item-123/file.png'
      const url = resolveAttachmentUrl(relativePath)

      expect(url).toBeDefined()
      expect(toMemryFileUrl).toHaveBeenCalled()
    })

    it('should return null when no vault is open', () => {
      vi.mocked(getStatus).mockReturnValue({
        isOpen: false,
        path: null
      } as ReturnType<typeof getStatus>)

      expect(resolveAttachmentUrl('some/path')).toBeNull()
    })
  })

  describe('hasAttachments', () => {
    it('should return false when no attachments directory exists', () => {
      expect(hasAttachments('nonexistent')).toBe(false)
    })

    it('should return true when attachments directory exists', async () => {
      const itemId = 'item-123'
      await storeInboxAttachment(itemId, Buffer.from('data'), 'file.png', 'image/png')

      expect(hasAttachments(itemId)).toBe(true)
    })
  })

  // ==========================================================================
  // Constants validation
  // ==========================================================================
  describe('Constants', () => {
    it('should have reasonable MAX_INBOX_FILE_SIZE', () => {
      // 50MB
      expect(MAX_INBOX_FILE_SIZE).toBe(50 * 1024 * 1024)
    })

    it('should include common image types', () => {
      expect(ALLOWED_IMAGE_TYPES).toContain('image/png')
      expect(ALLOWED_IMAGE_TYPES).toContain('image/jpeg')
      expect(ALLOWED_IMAGE_TYPES).toContain('image/gif')
      expect(ALLOWED_IMAGE_TYPES).toContain('image/webp')
    })

    it('should include common audio types', () => {
      expect(ALLOWED_AUDIO_TYPES).toContain('audio/webm')
      expect(ALLOWED_AUDIO_TYPES).toContain('audio/mp3')
      expect(ALLOWED_AUDIO_TYPES).toContain('audio/wav')
    })

    it('should include PDF document type', () => {
      expect(ALLOWED_DOCUMENT_TYPES).toContain('application/pdf')
    })
  })
})
