/**
 * IPC Attachments Contract Tests
 *
 * Zod schema validation tests for the R2 attachment IPC boundary:
 * upload (init), upload progress, download, and download progress.
 */

import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_CHANNELS,
  DownloadAttachmentSchema,
  GetDownloadProgressSchema,
  GetUploadProgressSchema,
  UploadAttachmentSchema
} from './ipc-attachments'

describe('ATTACHMENT_CHANNELS', () => {
  it('exposes every expected attachment channel literal', () => {
    expect(ATTACHMENT_CHANNELS.UPLOAD_ATTACHMENT).toBe('sync:upload-attachment')
    expect(ATTACHMENT_CHANNELS.GET_UPLOAD_PROGRESS).toBe('sync:get-upload-progress')
    expect(ATTACHMENT_CHANNELS.DOWNLOAD_ATTACHMENT).toBe('sync:download-attachment')
    expect(ATTACHMENT_CHANNELS.GET_DOWNLOAD_PROGRESS).toBe('sync:get-download-progress')
  })
})

describe('UploadAttachmentSchema', () => {
  it('accepts valid noteId + filePath', () => {
    const result = UploadAttachmentSchema.safeParse({
      noteId: 'note-1',
      filePath: '/tmp/file.pdf'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty noteId', () => {
    const result = UploadAttachmentSchema.safeParse({
      noteId: '',
      filePath: '/tmp/file.pdf'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('noteId')
    }
  })

  it('rejects empty filePath', () => {
    const result = UploadAttachmentSchema.safeParse({
      noteId: 'note-1',
      filePath: ''
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('filePath')
    }
  })

  it('rejects missing required fields', () => {
    expect(UploadAttachmentSchema.safeParse({ noteId: 'note-1' }).success).toBe(false)
    expect(UploadAttachmentSchema.safeParse({ filePath: '/tmp/file.pdf' }).success).toBe(false)
  })
})

describe('GetUploadProgressSchema', () => {
  it('accepts a valid sessionId', () => {
    const result = GetUploadProgressSchema.safeParse({ sessionId: 'sess-1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty sessionId', () => {
    const result = GetUploadProgressSchema.safeParse({ sessionId: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing sessionId', () => {
    const result = GetUploadProgressSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe('DownloadAttachmentSchema', () => {
  it('accepts attachmentId only', () => {
    const result = DownloadAttachmentSchema.safeParse({ attachmentId: 'att-1' })
    expect(result.success).toBe(true)
  })

  it('accepts attachmentId + targetPath', () => {
    const result = DownloadAttachmentSchema.safeParse({
      attachmentId: 'att-1',
      targetPath: '/tmp/out.pdf'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty attachmentId', () => {
    const result = DownloadAttachmentSchema.safeParse({ attachmentId: '' })
    expect(result.success).toBe(false)
  })

  it('rejects empty targetPath when the field is supplied', () => {
    const result = DownloadAttachmentSchema.safeParse({
      attachmentId: 'att-1',
      targetPath: ''
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('targetPath')
    }
  })
})

describe('GetDownloadProgressSchema', () => {
  it('accepts a valid attachmentId', () => {
    const result = GetDownloadProgressSchema.safeParse({ attachmentId: 'att-1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty attachmentId', () => {
    const result = GetDownloadProgressSchema.safeParse({ attachmentId: '' })
    expect(result.success).toBe(false)
  })

  it('rejects missing attachmentId', () => {
    const result = GetDownloadProgressSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})
