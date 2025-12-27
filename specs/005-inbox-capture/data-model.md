# Data Model: Inbox System for Quick Capture

**Feature**: 005-inbox-capture  
**Date**: 2025-12-27  
**Status**: Complete

## Overview

This document defines the data models for Memry's inbox capture system. The inbox stores captured items (links, notes, images, voice memos, web clips, PDFs, social posts) in SQLite (`data.db`) with binary attachments in the vault file system.

---

## Storage Architecture

```
vault/                              # User-selected vault folder
├── attachments/
│   ├── notes/                      # Existing: note attachments
│   │   └── {noteId}/
│   └── inbox/                      # NEW: inbox attachments
│       └── {itemId}/
│           ├── original.{ext}      # Original file (image, audio, PDF)
│           └── thumbnail.{ext}     # Generated thumbnail (jpg)
└── .memry/
    └── data.db                     # Source of truth: inbox_items, etc.
```

---

## Database Entities

### inbox_items Table (Extended)

The core table for all inbox captured content. Extends the minimal existing schema.

**Location**: `src/shared/db/schema/inbox.ts`

```typescript
// src/shared/db/schema/inbox.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const inboxItemType = {
  LINK: 'link',
  NOTE: 'note',
  IMAGE: 'image',
  VOICE: 'voice',
  CLIP: 'clip',
  PDF: 'pdf',
  SOCIAL: 'social'
} as const

export type InboxItemType = (typeof inboxItemType)[keyof typeof inboxItemType]

export const processingStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  FAILED: 'failed'
} as const

export type ProcessingStatus = (typeof processingStatus)[keyof typeof processingStatus]

export const inboxItems = sqliteTable(
  'inbox_items',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // InboxItemType

    // Common fields
    title: text('title').notNull(),
    content: text('content'), // Text content or excerpt
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(datetime('now'))`),

    // Filing status
    filedAt: text('filed_at'),
    filedTo: text('filed_to'), // noteId or folder path
    filedAction: text('filed_action'), // 'note' | 'folder' | 'linked'

    // Snooze status
    snoozedUntil: text('snoozed_until'),
    snoozeReason: text('snooze_reason'),

    // Processing status (for async operations like transcription, metadata fetch)
    processingStatus: text('processing_status').default('complete'),
    processingError: text('processing_error'),

    // Type-specific metadata (JSON)
    metadata: text('metadata', { mode: 'json' }),

    // Attachment info
    attachmentPath: text('attachment_path'), // Relative path to attachment folder
    thumbnailPath: text('thumbnail_path'), // Relative path to thumbnail

    // Transcription (for voice items)
    transcription: text('transcription'),
    transcriptionStatus: text('transcription_status'), // ProcessingStatus

    // Source info
    sourceUrl: text('source_url'), // Original URL for links, clips, social
    sourceTitle: text('source_title') // Page title for clips
  },
  (table) => [
    index('idx_inbox_items_type').on(table.type),
    index('idx_inbox_items_created').on(table.createdAt),
    index('idx_inbox_items_filed').on(table.filedAt),
    index('idx_inbox_items_snoozed').on(table.snoozedUntil),
    index('idx_inbox_items_processing').on(table.processingStatus)
  ]
)

export type InboxItem = typeof inboxItems.$inferSelect
export type NewInboxItem = typeof inboxItems.$inferInsert
```

---

### inbox_item_tags Table

Tags associated with inbox items (for pre-filing organization).

```typescript
// src/shared/db/schema/inbox.ts (continued)

export const inboxItemTags = sqliteTable(
  'inbox_item_tags',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => inboxItems.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_inbox_tags_item').on(table.itemId),
    index('idx_inbox_tags_tag').on(table.tag)
  ]
)

export type InboxItemTag = typeof inboxItemTags.$inferSelect
export type NewInboxItemTag = typeof inboxItemTags.$inferInsert
```

---

### filing_history Table

Track where items were filed for suggestion learning.

```typescript
// src/shared/db/schema/inbox.ts (continued)

export const filingHistory = sqliteTable(
  'filing_history',
  {
    id: text('id').primaryKey(),
    itemType: text('item_type').notNull(),
    itemContent: text('item_content'), // First 500 chars for matching
    filedTo: text('filed_to').notNull(),
    filedAction: text('filed_action').notNull(),
    tags: text('tags', { mode: 'json' }), // string[]
    filedAt: text('filed_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_filing_history_type').on(table.itemType),
    index('idx_filing_history_filed_at').on(table.filedAt)
  ]
)

export type FilingHistory = typeof filingHistory.$inferSelect
export type NewFilingHistory = typeof filingHistory.$inferInsert
```

---

### inbox_stats Table

Track capture and processing statistics.

```typescript
// src/shared/db/schema/inbox.ts (continued)

export const inboxStats = sqliteTable(
  'inbox_stats',
  {
    id: text('id').primaryKey(),
    date: text('date').notNull().unique(), // YYYY-MM-DD
    captureCountLink: integer('capture_count_link').default(0),
    captureCountNote: integer('capture_count_note').default(0),
    captureCountImage: integer('capture_count_image').default(0),
    captureCountVoice: integer('capture_count_voice').default(0),
    captureCountClip: integer('capture_count_clip').default(0),
    captureCountPdf: integer('capture_count_pdf').default(0),
    captureCountSocial: integer('capture_count_social').default(0),
    processedCount: integer('processed_count').default(0),
    deletedCount: integer('deleted_count').default(0)
  },
  (table) => [index('idx_inbox_stats_date').on(table.date)]
)

export type InboxStats = typeof inboxStats.$inferSelect
export type NewInboxStats = typeof inboxStats.$inferInsert
```

---

## Metadata JSON Structures

The `metadata` column stores type-specific data as JSON.

### Link Metadata

```typescript
interface LinkMetadata {
  url: string
  siteName?: string
  description?: string
  excerpt?: string
  heroImage?: string | null // URL or local path
  favicon?: string | null
  author?: string
  publishedDate?: string
  fetchedAt: string // When metadata was fetched
  fetchStatus: 'success' | 'partial' | 'failed'
}
```

### Image Metadata

```typescript
interface ImageMetadata {
  originalFilename: string
  format: string // 'png' | 'jpg' | 'gif' | 'webp' | 'svg'
  width: number
  height: number
  fileSize: number // bytes
  hasExif: boolean
  caption?: string
}
```

### Voice Metadata

```typescript
interface VoiceMetadata {
  duration: number // seconds
  format: string // 'webm' | 'mp3' | 'wav'
  fileSize: number // bytes
  sampleRate?: number
}
```

### Clip Metadata (Web Clip)

```typescript
interface ClipMetadata {
  sourceUrl: string
  sourceTitle: string
  quotedText: string
  selectionContext?: string // Text before/after selection
  capturedImages: string[] // Paths to captured images within selection
  hasFormatting: boolean
}
```

### PDF Metadata

```typescript
interface PdfMetadata {
  originalFilename: string
  pageCount: number
  fileSize: number // bytes
  extractedTitle?: string
  author?: string
  creationDate?: string
  textExcerpt?: string // First ~500 chars of extracted text
  hasText: boolean // false if scanned/image-only
  ocrStatus?: 'pending' | 'processing' | 'complete' | 'failed' | 'skipped'
  isPasswordProtected?: boolean
}
```

### Social Post Metadata

```typescript
interface SocialMetadata {
  platform: 'twitter' | 'linkedin' | 'mastodon' | 'bluesky' | 'threads' | 'other'
  postUrl: string
  authorName: string
  authorHandle: string
  authorAvatar?: string
  postContent: string
  timestamp?: string
  mediaUrls: string[] // Images/videos in the post
  metrics?: {
    likes?: number
    reposts?: number
    replies?: number
  }
  isThread?: boolean
  threadId?: string
  extractionStatus: 'full' | 'partial' | 'failed'
}
```

---

## TypeScript Interfaces

### Full InboxItem Interface

```typescript
// For frontend/API use - expanded from database row
interface InboxItemFull {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  modifiedAt: Date

  // Filing
  filedAt: Date | null
  filedTo: string | null
  filedAction: 'note' | 'folder' | 'linked' | null

  // Snooze
  snoozedUntil: Date | null
  snoozeReason: string | null

  // Processing
  processingStatus: ProcessingStatus
  processingError: string | null

  // Type-specific metadata
  metadata:
    | LinkMetadata
    | ImageMetadata
    | VoiceMetadata
    | ClipMetadata
    | PdfMetadata
    | SocialMetadata
    | null

  // Attachments
  attachmentPath: string | null
  attachmentUrl: string | null // Resolved URL for renderer
  thumbnailPath: string | null
  thumbnailUrl: string | null // Resolved URL for renderer

  // Transcription (voice only)
  transcription: string | null
  transcriptionStatus: ProcessingStatus | null

  // Source
  sourceUrl: string | null
  sourceTitle: string | null

  // Computed/loaded
  tags: string[]
  isStale: boolean // createdAt > 7 days ago
}
```

### Filing Destination

```typescript
interface FilingDestination {
  type: 'folder' | 'note' | 'new-note'
  path?: string // Folder path for 'folder' type
  noteId?: string // Note ID for 'note' type
  noteTitle?: string // For display
}
```

### Filing Suggestion

```typescript
interface FilingSuggestion {
  destination: FilingDestination
  confidence: number // 0-1
  reason: string // "Similar to 5 notes in /projects/research"
  suggestedTags: string[]
}
```

### Capture Request Types

```typescript
// Text/Note capture
interface CaptureTextRequest {
  content: string
  tags?: string[]
}

// Link capture
interface CaptureLinkRequest {
  url: string
  tags?: string[]
}

// Image capture (from drag-drop or clipboard)
interface CaptureImageRequest {
  data: ArrayBuffer
  filename: string
  mimeType: string
  tags?: string[]
}

// Voice capture
interface CaptureVoiceRequest {
  data: ArrayBuffer
  duration: number
  format: 'webm' | 'mp3'
  transcribe?: boolean // default: true
  tags?: string[]
}

// Clip capture
interface CaptureClipRequest {
  html: string // Selected HTML
  text: string // Plain text fallback
  sourceUrl: string
  sourceTitle: string
  images?: { url: string; data?: ArrayBuffer }[]
  tags?: string[]
}

// PDF capture
interface CapturePdfRequest {
  data: ArrayBuffer
  filename: string
  extractText?: boolean // default: true
  tags?: string[]
}
```

---

## Relationships

```
┌─────────────────────────────────────────────────────────────────────┐
│                         data.db (SQLite)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────┐                                                  │
│  │  inbox_items  │◄──────────────────────────────────────────┐      │
│  └───────┬───────┘                                           │      │
│          │                                                   │      │
│          │ has tags                                          │      │
│          ▼                                                   │      │
│  ┌─────────────────┐                                         │      │
│  │ inbox_item_tags │                                         │      │
│  └─────────────────┘                                         │      │
│                                                              │      │
│  ┌─────────────────┐     filed item creates history          │      │
│  │ filing_history  │◄────────────────────────────────────────┘      │
│  └─────────────────┘                                                │
│                                                                      │
│  ┌───────────────┐                                                  │
│  │  inbox_stats  │  (aggregated daily statistics)                   │
│  └───────────────┘                                                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      vault/attachments/ (File System)                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  inbox/{itemId}/                                                     │
│  ├── original.{ext}  ──────►  Stored via attachmentPath             │
│  └── thumbnail.jpg   ──────►  Stored via thumbnailPath              │
│                                                                      │
│  When filed to note ──────────────────────────────────────────┐     │
│                                                               │     │
│  notes/{noteId}/                                              │     │
│  └── {prefix}-{filename}  ◄───────────────────────────────────┘     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         Filing Flow                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  inbox_item ──┬──► File to Folder ──► Mark filedAt + filedTo        │
│               │                       Copy attachments to folder     │
│               │                       Create filing_history record   │
│               │                       Delete from inbox (soft/hard)  │
│               │                                                      │
│               ├──► Convert to Note ──► Create new note file         │
│               │                        Move attachments to notes/    │
│               │                        Set filedAction='note'        │
│               │                                                      │
│               └──► Link to Note ────► Add reference in note         │
│                                       Keep or move attachments       │
│                                       Set filedAction='linked'       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Migration SQL

```sql
-- Migration: 005_inbox_capture.sql
-- Extends inbox_items table and adds supporting tables

-- Add new columns to inbox_items
ALTER TABLE inbox_items ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox_items ADD COLUMN modified_at TEXT NOT NULL DEFAULT (datetime('now'));
ALTER TABLE inbox_items ADD COLUMN filed_to TEXT;
ALTER TABLE inbox_items ADD COLUMN filed_action TEXT;
ALTER TABLE inbox_items ADD COLUMN snoozed_until TEXT;
ALTER TABLE inbox_items ADD COLUMN snooze_reason TEXT;
ALTER TABLE inbox_items ADD COLUMN processing_status TEXT DEFAULT 'complete';
ALTER TABLE inbox_items ADD COLUMN processing_error TEXT;
ALTER TABLE inbox_items ADD COLUMN attachment_path TEXT;
ALTER TABLE inbox_items ADD COLUMN thumbnail_path TEXT;
ALTER TABLE inbox_items ADD COLUMN transcription TEXT;
ALTER TABLE inbox_items ADD COLUMN transcription_status TEXT;
ALTER TABLE inbox_items ADD COLUMN source_url TEXT;
ALTER TABLE inbox_items ADD COLUMN source_title TEXT;

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_inbox_items_created ON inbox_items(created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_items_filed ON inbox_items(filed_at);
CREATE INDEX IF NOT EXISTS idx_inbox_items_snoozed ON inbox_items(snoozed_until);
CREATE INDEX IF NOT EXISTS idx_inbox_items_processing ON inbox_items(processing_status);

-- Create inbox_item_tags table
CREATE TABLE IF NOT EXISTS inbox_item_tags (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbox_tags_item ON inbox_item_tags(item_id);
CREATE INDEX IF NOT EXISTS idx_inbox_tags_tag ON inbox_item_tags(tag);

-- Create filing_history table
CREATE TABLE IF NOT EXISTS filing_history (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_content TEXT,
  filed_to TEXT NOT NULL,
  filed_action TEXT NOT NULL,
  tags TEXT, -- JSON array
  filed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_filing_history_type ON filing_history(item_type);
CREATE INDEX IF NOT EXISTS idx_filing_history_filed_at ON filing_history(filed_at);

-- Create inbox_stats table
CREATE TABLE IF NOT EXISTS inbox_stats (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  capture_count_link INTEGER DEFAULT 0,
  capture_count_note INTEGER DEFAULT 0,
  capture_count_image INTEGER DEFAULT 0,
  capture_count_voice INTEGER DEFAULT 0,
  capture_count_clip INTEGER DEFAULT 0,
  capture_count_pdf INTEGER DEFAULT 0,
  capture_count_social INTEGER DEFAULT 0,
  processed_count INTEGER DEFAULT 0,
  deleted_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_inbox_stats_date ON inbox_stats(date);
```

---

## Validation Schemas (Zod)

```typescript
import { z } from 'zod'

export const InboxItemTypeSchema = z.enum([
  'link',
  'note',
  'image',
  'voice',
  'clip',
  'pdf',
  'social'
])

export const ProcessingStatusSchema = z.enum(['pending', 'processing', 'complete', 'failed'])

export const CaptureTextSchema = z.object({
  content: z.string().min(1).max(50000),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CaptureLinkSchema = z.object({
  url: z.string().url().max(2000),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CaptureImageSchema = z.object({
  data: z.instanceof(ArrayBuffer),
  filename: z.string().min(1).max(255),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CaptureVoiceSchema = z.object({
  data: z.instanceof(ArrayBuffer),
  duration: z.number().min(0).max(300), // Max 5 minutes
  format: z.enum(['webm', 'mp3']),
  transcribe: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const FileItemSchema = z.object({
  itemId: z.string(),
  destination: z.object({
    type: z.enum(['folder', 'note', 'new-note']),
    path: z.string().optional(),
    noteId: z.string().optional(),
    noteTitle: z.string().optional()
  }),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const SnoozeItemSchema = z.object({
  itemId: z.string(),
  snoozeUntil: z.string().datetime(),
  reason: z.string().max(200).optional()
})

export const InboxListSchema = z.object({
  type: InboxItemTypeSchema.optional(),
  includesFiled: z.boolean().default(false),
  includesSnoozed: z.boolean().default(false),
  sortBy: z.enum(['created', 'modified', 'title']).default('created'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0)
})
```

---

## Example Data

### Link Item

```json
{
  "id": "inbox_lnk_a1b2c3",
  "type": "link",
  "title": "The Design of Everyday Things",
  "content": "Don Norman's classic on human-centered design...",
  "createdAt": "2025-12-27T14:34:00Z",
  "modifiedAt": "2025-12-27T14:34:05Z",
  "processingStatus": "complete",
  "sourceUrl": "https://nngroup.com/articles/design-everyday-things",
  "metadata": {
    "url": "https://nngroup.com/articles/design-everyday-things",
    "siteName": "Nielsen Norman Group",
    "description": "Don Norman's The Design of Everyday Things...",
    "excerpt": "Good design is actually harder to notice...",
    "heroImage": null,
    "favicon": "https://nngroup.com/favicon.ico",
    "author": "Don Norman",
    "publishedDate": "2020-05-15",
    "fetchedAt": "2025-12-27T14:34:05Z",
    "fetchStatus": "success"
  },
  "tags": ["design", "ux"]
}
```

### Voice Item

```json
{
  "id": "inbox_voi_d4e5f6",
  "type": "voice",
  "title": "Voice memo",
  "content": null,
  "createdAt": "2025-12-27T11:20:00Z",
  "modifiedAt": "2025-12-27T11:21:30Z",
  "processingStatus": "complete",
  "attachmentPath": "attachments/inbox/inbox_voi_d4e5f6/original.webm",
  "transcription": "Remember to ask about the API architecture...",
  "transcriptionStatus": "complete",
  "metadata": {
    "duration": 34,
    "format": "webm",
    "fileSize": 245760,
    "sampleRate": 48000
  },
  "tags": []
}
```

### PDF Item

```json
{
  "id": "inbox_pdf_g7h8i9",
  "type": "pdf",
  "title": "Design Systems Handbook",
  "content": "A comprehensive guide to building...",
  "createdAt": "2025-12-27T09:15:00Z",
  "modifiedAt": "2025-12-27T09:15:45Z",
  "processingStatus": "complete",
  "attachmentPath": "attachments/inbox/inbox_pdf_g7h8i9/original.pdf",
  "thumbnailPath": "attachments/inbox/inbox_pdf_g7h8i9/thumbnail.jpg",
  "metadata": {
    "originalFilename": "design-systems-handbook.pdf",
    "pageCount": 156,
    "fileSize": 8234567,
    "extractedTitle": "Design Systems Handbook",
    "author": "InVision",
    "textExcerpt": "Design systems are a collection of...",
    "hasText": true,
    "ocrStatus": "skipped"
  },
  "tags": ["design", "reference"]
}
```
