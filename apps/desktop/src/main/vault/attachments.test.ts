/**
 * Tests for attachments.ts
 * Tests attachment operations for note file attachments.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  getFileExtension,
  isAllowedFileType,
  getFileType,
  getMimeType,
  validateFileSize,
  formatFileSize,
  getNoteAttachmentsDir,
  getAttachmentPath,
  getAbsoluteAttachmentUrl,
  getAttachmentRef,
  generateUniqueFilename,
  saveAttachment,
  deleteAttachment,
  deleteNoteAttachments,
  listNoteAttachments,
  attachmentExists,
  MAX_FILE_SIZE,
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_FILE_EXTENSIONS,
  AttachmentError
} from './attachments'

// ============================================================================
// Test Helpers
// ============================================================================

interface TestDir {
  path: string
  cleanup: () => void
}

function createTempVault(prefix = 'attachments-test-'): TestDir {
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  // Create attachments folder
  fs.mkdirSync(path.join(tempPath, 'attachments'), { recursive: true })
  return {
    path: tempPath,
    cleanup: () => {
      try {
        fs.rmSync(tempPath, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ============================================================================
// Mock Setup
// ============================================================================

// Store the mock vault path
let mockVaultPath = '/mock/vault'

// Mock the vault/index module
vi.mock('./index', () => ({
  getStatus: vi.fn(() => ({ path: mockVaultPath, isOpen: true }))
}))

// ============================================================================
// Pure Function Tests - Path Utilities (T391)
// ============================================================================

describe('getNoteAttachmentsDir', () => {
  it('T391: returns attachments/noteId path', () => {
    const result = getNoteAttachmentsDir('/vault', 'note123')

    expect(result).toBe(path.join('/vault', 'attachments', 'note123'))
  })
})

describe('getAttachmentPath', () => {
  it('T391: returns full attachment path', () => {
    const result = getAttachmentPath('/vault', 'note123', 'image.png')

    expect(result).toBe(path.join('/vault', 'attachments', 'note123', 'image.png'))
  })
})

describe('getAbsoluteAttachmentUrl', () => {
  it('T396: returns memry-file:// URL', () => {
    const result = getAbsoluteAttachmentUrl('/vault', 'note123', 'image.png')

    expect(result).toContain('memry-file://')
    expect(result).toContain('note123')
    expect(result).toContain('image.png')
  })
})

// ============================================================================
// Pure Function Tests - File Validation (T395)
// ============================================================================

describe('getFileExtension', () => {
  it('T395: extracts extension without dot', () => {
    expect(getFileExtension('file.png')).toBe('png')
    expect(getFileExtension('file.PNG')).toBe('png')
    expect(getFileExtension('file.tar.gz')).toBe('gz')
  })

  it('T395: returns empty string for no extension', () => {
    expect(getFileExtension('noext')).toBe('')
  })
})

describe('isAllowedFileType', () => {
  it('T395: returns true for allowed image extensions', () => {
    for (const ext of ALLOWED_IMAGE_EXTENSIONS) {
      expect(isAllowedFileType(`file.${ext}`)).toBe(true)
    }
  })

  it('T395: returns true for allowed document extensions', () => {
    for (const ext of ALLOWED_FILE_EXTENSIONS) {
      expect(isAllowedFileType(`file.${ext}`)).toBe(true)
    }
  })

  it('T395: returns false for disallowed extensions', () => {
    expect(isAllowedFileType('file.exe')).toBe(false)
    expect(isAllowedFileType('file.sh')).toBe(false)
    expect(isAllowedFileType('file.js')).toBe(false)
  })
})

describe('getFileType', () => {
  it('T395: returns "image" for image extensions', () => {
    expect(getFileType('photo.png')).toBe('image')
    expect(getFileType('photo.jpg')).toBe('image')
    expect(getFileType('photo.gif')).toBe('image')
    expect(getFileType('photo.webp')).toBe('image')
    expect(getFileType('photo.svg')).toBe('image')
  })

  it('T395: returns "file" for non-image extensions', () => {
    expect(getFileType('doc.pdf')).toBe('file')
    expect(getFileType('doc.docx')).toBe('file')
    expect(getFileType('doc.txt')).toBe('file')
  })
})

describe('getMimeType', () => {
  it('T395: returns correct MIME type for images', () => {
    expect(getMimeType('file.png')).toBe('image/png')
    expect(getMimeType('file.jpg')).toBe('image/jpeg')
    expect(getMimeType('file.gif')).toBe('image/gif')
    expect(getMimeType('file.svg')).toBe('image/svg+xml')
  })

  it('T395: returns correct MIME type for documents', () => {
    expect(getMimeType('file.pdf')).toBe('application/pdf')
    expect(getMimeType('file.txt')).toBe('text/plain')
    expect(getMimeType('file.md')).toBe('text/markdown')
  })

  it('T395: returns octet-stream for unknown types', () => {
    expect(getMimeType('file.unknown')).toBe('application/octet-stream')
  })
})

describe('validateFileSize', () => {
  it('caps vault attachments at 100MB', () => {
    // Pinned, not derived: the number is a product decision (a large PDF may be
    // attached as a local-only file), so a silent drift back toward the sync
    // limits should fail here.
    expect(MAX_FILE_SIZE).toBe(100 * 1024 * 1024)
  })

  it('T395: does not throw for valid size', () => {
    expect(() => validateFileSize(1024)).not.toThrow()
    expect(() => validateFileSize(MAX_FILE_SIZE)).not.toThrow()
  })

  it('T395: throws AttachmentError for oversized file', () => {
    expect(() => validateFileSize(MAX_FILE_SIZE + 1)).toThrow(AttachmentError)
  })
})

describe('formatFileSize', () => {
  it('T395: formats bytes correctly', () => {
    expect(formatFileSize(500)).toBe('500 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(5.5 * 1024 * 1024)).toBe('5.5 MB')
  })
})

// ============================================================================
// generateUniqueFilename Tests (T392)
// ============================================================================

describe('getAttachmentRef', () => {
  it('returns a note-relative ref when the note path is known', () => {
    expect(getAttachmentRef('/vault', 'note123', 'x.png', 'notes/Meeting.md')).toBe(
      '../attachments/note123/x.png'
    )
  })

  it('returns an absolute URL when it is not', () => {
    expect(getAttachmentRef('/vault', 'note123', 'x.png', undefined)).toBe(
      getAbsoluteAttachmentUrl('/vault', 'note123', 'x.png')
    )
  })
})

describe('generateUniqueFilename', () => {
  it('T392: generates unique filename with prefix', () => {
    const result = generateUniqueFilename('my-image.png')

    expect(result).toMatch(/^[a-z0-9]{6}-my-image\.png$/)
  })

  it('T392: preserves file extension', () => {
    const pngResult = generateUniqueFilename('file.png')
    const pdfResult = generateUniqueFilename('file.pdf')

    expect(pngResult).toContain('.png')
    expect(pdfResult).toContain('.pdf')
  })

  it('T392: handles filename with special characters', () => {
    // sanitizeFilename collapses whitespace but doesn't remove all of it
    const result = generateUniqueFilename('file<name>.png')

    // Invalid chars like < and > should be removed
    expect(result).not.toContain('<')
    expect(result).not.toContain('>')
  })

  it('replaces spaces and parens so the attachment URL stays markdown-safe', () => {
    // `![](a b.png)` / `![](a(1).png)` are invalid markdown image links — a space
    // or paren in the URL makes the editor render the raw text instead of the
    // image. Keep the on-disk filename (and thus the URL) free of both.
    const result = generateUniqueFilename('Pasted Graphic (1).png')

    expect(result).toMatch(/^[a-z0-9]{6}-[^\s()]+\.png$/)
    expect(result).not.toContain(' ')
    expect(result).not.toContain('(')
    expect(result).not.toContain(')')
  })

  it('T392: generates different prefixes each time', () => {
    const result1 = generateUniqueFilename('file.png')
    const result2 = generateUniqueFilename('file.png')

    expect(result1).not.toBe(result2)
  })
})

// ============================================================================
// Attachment Operations Tests (T393-T394)
// ============================================================================

describe('attachment operations', () => {
  let tempVault: TestDir
  let mockGetStatus: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    tempVault = createTempVault()
    mockVaultPath = tempVault.path

    // Get the mock functions and update their return values
    const indexModule = await import('./index')
    mockGetStatus = indexModule.getStatus as ReturnType<typeof vi.fn>
    mockGetStatus.mockReturnValue({ path: tempVault.path, isOpen: true })
  })

  afterEach(() => {
    tempVault.cleanup()
  })

  describe('saveAttachment', () => {
    it('T393: saves attachment to note folder', async () => {
      const data = Buffer.from('test image data')

      const result = await saveAttachment('note123', data, 'test.png')

      expect(result.success).toBe(true)
      expect(result.name).toBe('test.png')
      expect(result.size).toBe(data.length)
      expect(result.mimeType).toBe('image/png')
      expect(result.type).toBe('image')
    })

    it('T393: creates note attachments folder', async () => {
      const data = Buffer.from('data')

      await saveAttachment('newnote', data, 'file.txt')

      const folderPath = path.join(tempVault.path, 'attachments', 'newnote')
      expect(fs.existsSync(folderPath)).toBe(true)
    })

    it('T393: returns error for disallowed file type', async () => {
      const data = Buffer.from('data')

      const result = await saveAttachment('note123', data, 'script.exe')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not allowed')
    })

    it('T393: returns error for oversized file', async () => {
      const data = Buffer.alloc(MAX_FILE_SIZE + 1)

      const result = await saveAttachment('note123', data, 'large.png')

      expect(result.success).toBe(false)
      expect(result.error).toContain('too large')
    })

    it('references the attachment relative to the note that owns it', async () => {
      // The whole point of #1488: an absolute URL carries this machine's vault
      // path, so the same note on a second device resolves it to nothing.
      const result = await saveAttachment('note123', Buffer.from('data'), 'plan.pdf', {
        notePath: 'notes/Meeting.md'
      })

      expect(result.success).toBe(true)
      expect(result.path).toMatch(/^\.\.\/attachments\/note123\/[a-z0-9]{6}-plan\.pdf$/)
      expect(result.path).not.toContain('memry-file://')
      expect(result.path).not.toContain(tempVault.path)
    })

    it('also reports where the bytes landed, so sync can upload them', async () => {
      // The note-relative ref is not reversible into a disk path, and sync
      // needs one to read the file. Deriving it from `path` is what broke:
      // every attachment written from the editor threw on the way to the
      // upload queue and stayed on the single device that made it.
      const result = await saveAttachment('note123', Buffer.from('data'), 'plan.pdf', {
        notePath: 'notes/Meeting.md'
      })

      expect(result.diskPath).toBeDefined()
      expect(path.isAbsolute(result.diskPath as string)).toBe(true)
      expect(fs.existsSync(result.diskPath as string)).toBe(true)
      expect(path.dirname(result.diskPath as string)).toBe(
        path.join(tempVault.path, 'attachments', 'note123')
      )
    })

    it('climbs once per folder between the note and the attachments tree', async () => {
      const result = await saveAttachment('note123', Buffer.from('data'), 'plan.pdf', {
        notePath: 'notes/work/q3/Review.md'
      })

      expect(result.path?.startsWith('../../../attachments/note123/')).toBe(true)
    })

    it('falls back to an absolute URL when the note path is unknown', async () => {
      // Not a failure: this is what every attachment carried before the ref
      // became note-relative, so an unindexed note is left no worse off.
      const result = await saveAttachment('note123', Buffer.from('data'), 'plan.pdf')

      expect(result.success).toBe(true)
      expect(result.path?.startsWith('memry-file://')).toBe(true)
    })

    it('writes the bytes under the note folder whichever ref shape it returns', async () => {
      const result = await saveAttachment('note123', Buffer.from('data'), 'plan.pdf', {
        notePath: 'notes/Meeting.md'
      })

      const filename = path.basename(result.path!)
      expect(fs.existsSync(path.join(tempVault.path, 'attachments', 'note123', filename))).toBe(
        true
      )
    })

    it('saves a 60MB PDF that no sync plan would accept', async () => {
      // The whole point of the 100MB cap: this file is far past every plan's
      // per-file sync limit, and it still lands in the vault. Sync refuses it
      // separately (file_too_large, no retry) and it stays on this device.
      const data = Buffer.alloc(60 * 1024 * 1024)

      const result = await saveAttachment('note123', data, 'thesis.pdf')

      expect(result.success).toBe(true)
      expect(result.size).toBe(data.length)
      expect(result.mimeType).toBe('application/pdf')
      expect(result.type).toBe('file')
    })
  })

  describe('deleteAttachment', () => {
    it('T393: deletes specific attachment', async () => {
      // Create attachment first
      const data = Buffer.from('data')
      const saveResult = await saveAttachment('note123', data, 'test.png')
      expect(saveResult.success).toBe(true)

      // Get the filename from the path
      const filename = path.basename(saveResult.path!)

      await deleteAttachment('note123', filename)

      const filePath = path.join(tempVault.path, 'attachments', 'note123', filename)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('T393: does not throw for non-existent attachment', async () => {
      await expect(deleteAttachment('note123', 'nonexistent.png')).resolves.not.toThrow()
    })
  })

  describe('deleteNoteAttachments', () => {
    it('T393: deletes entire note attachments folder', async () => {
      // Create attachments
      await saveAttachment('note123', Buffer.from('data1'), 'file1.png')
      await saveAttachment('note123', Buffer.from('data2'), 'file2.png')

      await deleteNoteAttachments('note123')

      const folderPath = path.join(tempVault.path, 'attachments', 'note123')
      expect(fs.existsSync(folderPath)).toBe(false)
    })

    it('T393: succeeds if folder does not exist', async () => {
      await expect(deleteNoteAttachments('nonexistent')).resolves.not.toThrow()
    })
  })

  describe('listNoteAttachments', () => {
    it('T394: lists all attachments for note', async () => {
      // Create attachments
      await saveAttachment('note123', Buffer.from('data1'), 'image.png')
      await saveAttachment('note123', Buffer.from('data2'), 'doc.pdf')

      const attachments = await listNoteAttachments('note123')

      expect(attachments.length).toBe(2)
      expect(attachments.some((a) => a.type === 'image')).toBe(true)
      expect(attachments.some((a) => a.type === 'file')).toBe(true)
    })

    it('keeps absolute URLs, unlike the ref a note carries', async () => {
      // This listing answers "where is this file on this machine" for IPC/MCP
      // callers; nothing writes it into a note, so it must stay openable as-is.
      await saveAttachment('note123', Buffer.from('data'), 'image.png', {
        notePath: 'notes/Meeting.md'
      })

      const [attachment] = await listNoteAttachments('note123')

      expect(attachment.path.startsWith('memry-file://')).toBe(true)
    })

    it('T394: returns empty array for note without attachments', async () => {
      const attachments = await listNoteAttachments('nonexistent')

      expect(attachments).toEqual([])
    })

    it('T394: includes size and mimeType', async () => {
      const data = Buffer.from('test data')
      await saveAttachment('note123', data, 'test.png')

      const attachments = await listNoteAttachments('note123')

      expect(attachments[0].size).toBe(data.length)
      expect(attachments[0].mimeType).toBe('image/png')
    })
  })

  describe('saveAttachment with extraAllowedExtensions', () => {
    it('accepts a listed extra extension for this call only', async () => {
      const result = await saveAttachment('note123', Buffer.from('deck'), 'slides.ppt', {
        extraAllowedExtensions: ['ppt']
      })
      expect(result.success).toBe(true)
      expect(result.type).toBe('file')
      expect(result.name).toBe('slides.ppt')

      // Without the override the same file is still rejected.
      const rejected = await saveAttachment('note123', Buffer.from('deck'), 'slides2.ppt')
      expect(rejected.success).toBe(false)
      expect(rejected.error).toContain('not allowed')
    })

    it('does not accept extensions outside the override list', async () => {
      const result = await saveAttachment('note123', Buffer.from('bin'), 'tool.exe', {
        extraAllowedExtensions: ['ppt']
      })
      expect(result.success).toBe(false)
    })

    it('still enforces the size cap for extra extensions', async () => {
      const big = Buffer.alloc(MAX_FILE_SIZE + 1)
      const result = await saveAttachment('note123', big, 'movie.mp4', {
        extraAllowedExtensions: ['mp4']
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('too large')
    })
  })

  describe('attachmentExists', () => {
    it('T394: returns true for existing attachment', async () => {
      const saveResult = await saveAttachment('note123', Buffer.from('data'), 'test.png')
      const filename = path.basename(saveResult.path!)

      const exists = await attachmentExists('note123', filename)

      expect(exists).toBe(true)
    })

    it('T394: returns false for non-existent attachment', async () => {
      const exists = await attachmentExists('note123', 'nonexistent.png')

      expect(exists).toBe(false)
    })
  })
})
