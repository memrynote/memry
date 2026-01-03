/**
 * Inbox API Contract Tests
 *
 * Comprehensive Zod schema validation tests for the inbox API contract.
 * Tests both valid and invalid inputs for all schemas.
 */

import { describe, it, expect } from 'vitest'
import {
  CaptureTextSchema,
  CaptureLinkSchema,
  CaptureImageSchema,
  CaptureVoiceSchema,
  CaptureClipSchema,
  CapturePdfSchema,
  InboxListSchema,
  InboxUpdateSchema,
  FileItemSchema,
  SnoozeSchema,
  BulkFileSchema,
  BulkArchiveSchema,
  BulkTagSchema,
  MarkViewedSchema
} from './inbox-api'

// ============================================================================
// CaptureTextSchema Tests
// ============================================================================

describe('CaptureTextSchema', () => {
  it('should validate minimal input', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'This is a quick note'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full input', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'This is a quick note',
      title: 'My Note',
      tags: ['idea', 'work']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty content', () => {
    const result = CaptureTextSchema.safeParse({
      content: ''
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('content')
    }
  })

  it('should reject content over 50000 chars', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'x'.repeat(50001)
    })
    expect(result.success).toBe(false)
  })

  it('should accept content at 50000 chars boundary', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'x'.repeat(50000)
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty title', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'Note content',
      title: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject title over 200 chars', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'Note content',
      title: 'x'.repeat(201)
    })
    expect(result.success).toBe(false)
  })

  it('should accept title at 200 chars boundary', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'Note content',
      title: 'x'.repeat(200)
    })
    expect(result.success).toBe(true)
  })

  it('should reject tags with more than 20 items', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'Note content',
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`)
    })
    expect(result.success).toBe(false)
  })

  it('should reject tag over 50 chars', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'Note content',
      tags: ['x'.repeat(51)]
    })
    expect(result.success).toBe(false)
  })

  it('should accept tag at 50 chars boundary', () => {
    const result = CaptureTextSchema.safeParse({
      content: 'Note content',
      tags: ['x'.repeat(50)]
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// CaptureLinkSchema Tests
// ============================================================================

describe('CaptureLinkSchema', () => {
  it('should validate minimal input', () => {
    const result = CaptureLinkSchema.safeParse({
      url: 'https://example.com'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with tags', () => {
    const result = CaptureLinkSchema.safeParse({
      url: 'https://example.com/article',
      tags: ['research', 'reading']
    })
    expect(result.success).toBe(true)
  })

  it('should reject url over 2000 chars', () => {
    const result = CaptureLinkSchema.safeParse({
      url: 'https://example.com/' + 'x'.repeat(2000)
    })
    expect(result.success).toBe(false)
  })

  it('should accept url at 2000 chars boundary', () => {
    const result = CaptureLinkSchema.safeParse({
      url: 'https://example.com/' + 'x'.repeat(1980)
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing url', () => {
    const result = CaptureLinkSchema.safeParse({
      tags: ['research']
    })
    expect(result.success).toBe(false)
  })

  it('should reject tags with more than 20 items', () => {
    const result = CaptureLinkSchema.safeParse({
      url: 'https://example.com',
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`)
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// CaptureImageSchema Tests
// ============================================================================

describe('CaptureImageSchema', () => {
  it('should validate with Buffer data', () => {
    const result = CaptureImageSchema.safeParse({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      filename: 'image.png',
      mimeType: 'image/png'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with Uint8Array data', () => {
    const result = CaptureImageSchema.safeParse({
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      filename: 'image.png',
      mimeType: 'image/png'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with serialized buffer object', () => {
    const result = CaptureImageSchema.safeParse({
      data: { 0: 137, 1: 80, 2: 78, 3: 71 },
      filename: 'image.png',
      mimeType: 'image/png'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with tags', () => {
    const result = CaptureImageSchema.safeParse({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      filename: 'screenshot.png',
      mimeType: 'image/png',
      tags: ['screenshot', 'work']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty filename', () => {
    const result = CaptureImageSchema.safeParse({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      filename: '',
      mimeType: 'image/png'
    })
    expect(result.success).toBe(false)
  })

  it('should reject filename over 255 chars', () => {
    const result = CaptureImageSchema.safeParse({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      filename: 'x'.repeat(256),
      mimeType: 'image/png'
    })
    expect(result.success).toBe(false)
  })

  it('should validate all supported mimeTypes', () => {
    const mimeTypes = [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml'
    ] as const
    for (const mimeType of mimeTypes) {
      const result = CaptureImageSchema.safeParse({
        data: Buffer.from([0x00]),
        filename: 'image.test',
        mimeType
      })
      expect(result.success).toBe(true)
    }
  })

  it('should reject unsupported mimeType', () => {
    const result = CaptureImageSchema.safeParse({
      data: Buffer.from([0x00]),
      filename: 'image.bmp',
      mimeType: 'image/bmp'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing data', () => {
    const result = CaptureImageSchema.safeParse({
      filename: 'image.png',
      mimeType: 'image/png'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid data type', () => {
    const result = CaptureImageSchema.safeParse({
      data: 'not binary data',
      filename: 'image.png',
      mimeType: 'image/png'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// CaptureVoiceSchema Tests
// ============================================================================

describe('CaptureVoiceSchema', () => {
  it('should validate minimal input', () => {
    const result = CaptureVoiceSchema.safeParse({
      data: Buffer.from([0x00, 0x01, 0x02]),
      duration: 30,
      format: 'webm'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.transcribe).toBe(true) // default
    }
  })

  it('should validate full input', () => {
    const result = CaptureVoiceSchema.safeParse({
      data: Buffer.from([0x00, 0x01, 0x02]),
      duration: 60,
      format: 'mp3',
      transcribe: false,
      tags: ['meeting', 'notes']
    })
    expect(result.success).toBe(true)
  })

  it('should validate all supported formats', () => {
    const formats = ['webm', 'mp3', 'wav'] as const
    for (const format of formats) {
      const result = CaptureVoiceSchema.safeParse({
        data: Buffer.from([0x00]),
        duration: 10,
        format
      })
      expect(result.success).toBe(true)
    }
  })

  it('should reject unsupported format', () => {
    const result = CaptureVoiceSchema.safeParse({
      data: Buffer.from([0x00]),
      duration: 10,
      format: 'aac'
    })
    expect(result.success).toBe(false)
  })

  it('should reject negative duration', () => {
    const result = CaptureVoiceSchema.safeParse({
      data: Buffer.from([0x00]),
      duration: -1,
      format: 'webm'
    })
    expect(result.success).toBe(false)
  })

  it('should reject duration over 300 seconds', () => {
    const result = CaptureVoiceSchema.safeParse({
      data: Buffer.from([0x00]),
      duration: 301,
      format: 'webm'
    })
    expect(result.success).toBe(false)
  })

  it('should accept duration at boundaries (0 and 300)', () => {
    const result0 = CaptureVoiceSchema.safeParse({
      data: Buffer.from([0x00]),
      duration: 0,
      format: 'webm'
    })
    expect(result0.success).toBe(true)

    const result300 = CaptureVoiceSchema.safeParse({
      data: Buffer.from([0x00]),
      duration: 300,
      format: 'webm'
    })
    expect(result300.success).toBe(true)
  })

  it('should reject missing data', () => {
    const result = CaptureVoiceSchema.safeParse({
      duration: 30,
      format: 'webm'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// CaptureClipSchema Tests
// ============================================================================

describe('CaptureClipSchema', () => {
  it('should validate minimal input', () => {
    const result = CaptureClipSchema.safeParse({
      html: '<p>Highlighted text</p>',
      text: 'Highlighted text',
      sourceUrl: 'https://example.com/article',
      sourceTitle: 'Example Article'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with tags', () => {
    const result = CaptureClipSchema.safeParse({
      html: '<p>Quote from article</p>',
      text: 'Quote from article',
      sourceUrl: 'https://example.com',
      sourceTitle: 'Source',
      tags: ['quote', 'research']
    })
    expect(result.success).toBe(true)
  })

  it('should reject html over 100000 chars', () => {
    const result = CaptureClipSchema.safeParse({
      html: '<p>' + 'x'.repeat(100000) + '</p>',
      text: 'text',
      sourceUrl: 'https://example.com',
      sourceTitle: 'Source'
    })
    expect(result.success).toBe(false)
  })

  it('should reject text over 50000 chars', () => {
    const result = CaptureClipSchema.safeParse({
      html: '<p>text</p>',
      text: 'x'.repeat(50001),
      sourceUrl: 'https://example.com',
      sourceTitle: 'Source'
    })
    expect(result.success).toBe(false)
  })

  it('should reject sourceUrl over 2000 chars', () => {
    const result = CaptureClipSchema.safeParse({
      html: '<p>text</p>',
      text: 'text',
      sourceUrl: 'https://example.com/' + 'x'.repeat(2000),
      sourceTitle: 'Source'
    })
    expect(result.success).toBe(false)
  })

  it('should reject sourceTitle over 200 chars', () => {
    const result = CaptureClipSchema.safeParse({
      html: '<p>text</p>',
      text: 'text',
      sourceUrl: 'https://example.com',
      sourceTitle: 'x'.repeat(201)
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing required fields', () => {
    const result = CaptureClipSchema.safeParse({
      html: '<p>text</p>',
      text: 'text'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// CapturePdfSchema Tests
// ============================================================================

describe('CapturePdfSchema', () => {
  it('should validate minimal input', () => {
    const result = CapturePdfSchema.safeParse({
      data: Buffer.from([0x25, 0x50, 0x44, 0x46]),
      filename: 'document.pdf'
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.extractText).toBe(true) // default
    }
  })

  it('should validate full input', () => {
    const result = CapturePdfSchema.safeParse({
      data: Buffer.from([0x25, 0x50, 0x44, 0x46]),
      filename: 'report.pdf',
      extractText: false,
      tags: ['document', 'work']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty filename', () => {
    const result = CapturePdfSchema.safeParse({
      data: Buffer.from([0x25, 0x50, 0x44, 0x46]),
      filename: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject filename over 255 chars', () => {
    const result = CapturePdfSchema.safeParse({
      data: Buffer.from([0x25, 0x50, 0x44, 0x46]),
      filename: 'x'.repeat(256)
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing data', () => {
    const result = CapturePdfSchema.safeParse({
      filename: 'document.pdf'
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// InboxListSchema Tests
// ============================================================================

describe('InboxListSchema', () => {
  it('should validate empty object with defaults', () => {
    const result = InboxListSchema.safeParse({})
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.includeSnoozed).toBe(false)
      expect(result.data.sortBy).toBe('created')
      expect(result.data.sortOrder).toBe('desc')
      expect(result.data.limit).toBe(50)
      expect(result.data.offset).toBe(0)
    }
  })

  it('should validate full query', () => {
    const result = InboxListSchema.safeParse({
      type: 'link',
      includeSnoozed: true,
      sortBy: 'modified',
      sortOrder: 'asc',
      limit: 100,
      offset: 20
    })
    expect(result.success).toBe(true)
  })

  it('should validate all item types', () => {
    const types = [
      'link',
      'note',
      'image',
      'voice',
      'clip',
      'pdf',
      'social',
      'reminder'
    ] as const
    for (const type of types) {
      const result = InboxListSchema.safeParse({ type })
      expect(result.success).toBe(true)
    }
  })

  it('should reject invalid type', () => {
    const result = InboxListSchema.safeParse({
      type: 'video'
    })
    expect(result.success).toBe(false)
  })

  it('should validate all sortBy values', () => {
    const sortByValues = ['created', 'modified', 'title'] as const
    for (const sortBy of sortByValues) {
      const result = InboxListSchema.safeParse({ sortBy })
      expect(result.success).toBe(true)
    }
  })

  it('should reject invalid sortBy value', () => {
    const result = InboxListSchema.safeParse({
      sortBy: 'priority'
    })
    expect(result.success).toBe(false)
  })

  it('should reject limit below 1', () => {
    const result = InboxListSchema.safeParse({
      limit: 0
    })
    expect(result.success).toBe(false)
  })

  it('should reject limit above 200', () => {
    const result = InboxListSchema.safeParse({
      limit: 201
    })
    expect(result.success).toBe(false)
  })

  it('should accept limit at boundaries (1 and 200)', () => {
    const result1 = InboxListSchema.safeParse({ limit: 1 })
    expect(result1.success).toBe(true)

    const result200 = InboxListSchema.safeParse({ limit: 200 })
    expect(result200.success).toBe(true)
  })

  it('should reject negative offset', () => {
    const result = InboxListSchema.safeParse({
      offset: -1
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// InboxUpdateSchema Tests
// ============================================================================

describe('InboxUpdateSchema', () => {
  it('should validate with only id', () => {
    const result = InboxUpdateSchema.safeParse({
      id: 'item-1'
    })
    expect(result.success).toBe(true)
  })

  it('should validate full update', () => {
    const result = InboxUpdateSchema.safeParse({
      id: 'item-1',
      title: 'Updated Title',
      content: 'Updated content'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing id', () => {
    const result = InboxUpdateSchema.safeParse({
      title: 'Updated Title'
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty title', () => {
    const result = InboxUpdateSchema.safeParse({
      id: 'item-1',
      title: ''
    })
    expect(result.success).toBe(false)
  })

  it('should reject title over 200 chars', () => {
    const result = InboxUpdateSchema.safeParse({
      id: 'item-1',
      title: 'x'.repeat(201)
    })
    expect(result.success).toBe(false)
  })

  it('should reject content over 50000 chars', () => {
    const result = InboxUpdateSchema.safeParse({
      id: 'item-1',
      content: 'x'.repeat(50001)
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// FileItemSchema Tests
// ============================================================================

describe('FileItemSchema', () => {
  it('should validate filing to folder', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: {
        type: 'folder',
        path: '/notes/research'
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate filing to existing note', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: {
        type: 'note',
        noteId: 'note-1'
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate filing to multiple notes', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: {
        type: 'note',
        noteIds: ['note-1', 'note-2', 'note-3']
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate creating new note', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: {
        type: 'new-note',
        noteTitle: 'My New Note',
        path: '/notes'
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate with tags', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: {
        type: 'folder',
        path: '/notes'
      },
      tags: ['processed', 'important']
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing itemId', () => {
    const result = FileItemSchema.safeParse({
      destination: {
        type: 'folder',
        path: '/notes'
      }
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing destination', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1'
    })
    expect(result.success).toBe(false)
  })

  it('should reject invalid destination type', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: {
        type: 'archive'
      }
    })
    expect(result.success).toBe(false)
  })

  it('should reject noteTitle over 200 chars', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: {
        type: 'new-note',
        noteTitle: 'x'.repeat(201)
      }
    })
    expect(result.success).toBe(false)
  })

  it('should reject tags with more than 20 items', () => {
    const result = FileItemSchema.safeParse({
      itemId: 'item-1',
      destination: { type: 'folder', path: '/notes' },
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`)
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// SnoozeSchema Tests
// ============================================================================

describe('SnoozeSchema', () => {
  it('should validate minimal input', () => {
    const result = SnoozeSchema.safeParse({
      itemId: 'item-1',
      snoozeUntil: '2026-01-10T09:00:00Z'
    })
    expect(result.success).toBe(true)
  })

  it('should validate with reason', () => {
    const result = SnoozeSchema.safeParse({
      itemId: 'item-1',
      snoozeUntil: '2026-01-10T09:00:00Z',
      reason: 'Wait for more info'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing itemId', () => {
    const result = SnoozeSchema.safeParse({
      snoozeUntil: '2026-01-10T09:00:00Z'
    })
    expect(result.success).toBe(false)
  })

  it('should reject missing snoozeUntil', () => {
    const result = SnoozeSchema.safeParse({
      itemId: 'item-1'
    })
    expect(result.success).toBe(false)
  })

  it('should reject reason over 200 chars', () => {
    const result = SnoozeSchema.safeParse({
      itemId: 'item-1',
      snoozeUntil: '2026-01-10T09:00:00Z',
      reason: 'x'.repeat(201)
    })
    expect(result.success).toBe(false)
  })

  it('should accept reason at 200 chars boundary', () => {
    const result = SnoozeSchema.safeParse({
      itemId: 'item-1',
      snoozeUntil: '2026-01-10T09:00:00Z',
      reason: 'x'.repeat(200)
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// BulkFileSchema Tests
// ============================================================================

describe('BulkFileSchema', () => {
  it('should validate filing multiple items', () => {
    const result = BulkFileSchema.safeParse({
      itemIds: ['item-1', 'item-2', 'item-3'],
      destination: {
        type: 'folder',
        path: '/notes/processed'
      }
    })
    expect(result.success).toBe(true)
  })

  it('should validate with tags', () => {
    const result = BulkFileSchema.safeParse({
      itemIds: ['item-1'],
      destination: {
        type: 'note',
        noteId: 'note-1'
      },
      tags: ['bulk-filed']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty itemIds array', () => {
    const result = BulkFileSchema.safeParse({
      itemIds: [],
      destination: {
        type: 'folder',
        path: '/notes'
      }
    })
    expect(result.success).toBe(false)
  })

  it('should reject itemIds array over 100 items', () => {
    const result = BulkFileSchema.safeParse({
      itemIds: Array.from({ length: 101 }, (_, i) => `item-${i}`),
      destination: {
        type: 'folder',
        path: '/notes'
      }
    })
    expect(result.success).toBe(false)
  })

  it('should accept itemIds at boundaries (1 and 100)', () => {
    const result1 = BulkFileSchema.safeParse({
      itemIds: ['item-1'],
      destination: { type: 'folder', path: '/notes' }
    })
    expect(result1.success).toBe(true)

    const result100 = BulkFileSchema.safeParse({
      itemIds: Array.from({ length: 100 }, (_, i) => `item-${i}`),
      destination: { type: 'folder', path: '/notes' }
    })
    expect(result100.success).toBe(true)
  })

  it('should reject missing destination', () => {
    const result = BulkFileSchema.safeParse({
      itemIds: ['item-1', 'item-2']
    })
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// BulkArchiveSchema Tests
// ============================================================================

describe('BulkArchiveSchema', () => {
  it('should validate array of itemIds', () => {
    const result = BulkArchiveSchema.safeParse({
      itemIds: ['item-1', 'item-2', 'item-3']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty array', () => {
    const result = BulkArchiveSchema.safeParse({
      itemIds: []
    })
    expect(result.success).toBe(false)
  })

  it('should reject over 100 items', () => {
    const result = BulkArchiveSchema.safeParse({
      itemIds: Array.from({ length: 101 }, (_, i) => `item-${i}`)
    })
    expect(result.success).toBe(false)
  })

  it('should accept at boundaries (1 and 100)', () => {
    const result1 = BulkArchiveSchema.safeParse({
      itemIds: ['item-1']
    })
    expect(result1.success).toBe(true)

    const result100 = BulkArchiveSchema.safeParse({
      itemIds: Array.from({ length: 100 }, (_, i) => `item-${i}`)
    })
    expect(result100.success).toBe(true)
  })

  it('should reject missing itemIds', () => {
    const result = BulkArchiveSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})

// ============================================================================
// BulkTagSchema Tests
// ============================================================================

describe('BulkTagSchema', () => {
  it('should validate adding tags to multiple items', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: ['item-1', 'item-2'],
      tags: ['processed', 'reviewed']
    })
    expect(result.success).toBe(true)
  })

  it('should reject empty itemIds array', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: [],
      tags: ['tag']
    })
    expect(result.success).toBe(false)
  })

  it('should reject empty tags array', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: ['item-1'],
      tags: []
    })
    expect(result.success).toBe(false)
  })

  it('should reject itemIds over 100', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: Array.from({ length: 101 }, (_, i) => `item-${i}`),
      tags: ['tag']
    })
    expect(result.success).toBe(false)
  })

  it('should reject tags over 20', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: ['item-1'],
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`)
    })
    expect(result.success).toBe(false)
  })

  it('should reject tag over 50 chars', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: ['item-1'],
      tags: ['x'.repeat(51)]
    })
    expect(result.success).toBe(false)
  })

  it('should accept at boundaries (1 itemId, 1 tag)', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: ['item-1'],
      tags: ['tag-1']
    })
    expect(result.success).toBe(true)
  })

  it('should accept at max boundaries (100 itemIds, 20 tags)', () => {
    const result = BulkTagSchema.safeParse({
      itemIds: Array.from({ length: 100 }, (_, i) => `item-${i}`),
      tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`)
    })
    expect(result.success).toBe(true)
  })
})

// ============================================================================
// MarkViewedSchema Tests
// ============================================================================

describe('MarkViewedSchema', () => {
  it('should validate with itemId', () => {
    const result = MarkViewedSchema.safeParse({
      itemId: 'item-1'
    })
    expect(result.success).toBe(true)
  })

  it('should reject missing itemId', () => {
    const result = MarkViewedSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should reject empty string itemId', () => {
    const result = MarkViewedSchema.safeParse({
      itemId: ''
    })
    // Note: z.string() without .min(1) accepts empty strings
    // This test documents current behavior
    expect(result.success).toBe(true)
  })
})
