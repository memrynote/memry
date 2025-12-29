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
│  ┌───────────────┐                                                  │
│  │   reminders   │  (cross-feature: notes, journal, highlights)     │
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

┌─────────────────────────────────────────────────────────────────────┐
│                       Reminders Architecture                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌─────────────────┐                                                │
│  │    reminders    │                                                │
│  └────────┬────────┘                                                │
│           │                                                          │
│           │ targetType + targetId                                    │
│           │                                                          │
│     ┌─────┴─────┬──────────────┐                                    │
│     ▼           ▼              ▼                                    │
│  ┌──────┐   ┌─────────┐   ┌───────────┐                             │
│  │ note │   │ journal │   │ highlight │                             │
│  └──────┘   └─────────┘   └───────────┘                             │
│     │           │              │                                    │
│     │           │              │ stores text + position             │
│     │           │              │ for inline display                 │
│     ▼           ▼              ▼                                    │
│  ┌──────────────────────────────────────┐                           │
│  │           Reminder Scheduler          │                          │
│  │  - Checks every 1 minute              │                          │
│  │  - Emits REMINDER_DUE events          │                          │
│  │  - Handles snooze and dismiss         │                          │
│  └──────────────────────────────────────┘                           │
│                      │                                               │
│                      ▼                                               │
│  ┌──────────────────────────────────────┐                           │
│  │       Desktop Notification            │                          │
│  │  - Shows target title + highlight     │                          │
│  │  - Click to open target               │                          │
│  │  - Snooze options                     │                          │
│  └──────────────────────────────────────┘                           │
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

---

### reminders Table (Cross-Feature)

Reminders for notes, journal entries, and highlighted text. While defined in the inbox spec for organizational purposes, this table supports the entire PKM system.

**Location**: `src/shared/db/schema/reminders.ts`

```typescript
// src/shared/db/schema/reminders.ts
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const reminderTargetType = {
  NOTE: 'note',
  JOURNAL: 'journal',
  HIGHLIGHT: 'highlight'
} as const

export type ReminderTargetType = (typeof reminderTargetType)[keyof typeof reminderTargetType]

export const reminderStatus = {
  PENDING: 'pending',
  TRIGGERED: 'triggered',
  DISMISSED: 'dismissed',
  SNOOZED: 'snoozed'
} as const

export type ReminderStatus = (typeof reminderStatus)[keyof typeof reminderStatus]

export const reminders = sqliteTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    targetType: text('target_type').notNull(), // ReminderTargetType
    targetId: text('target_id').notNull(), // noteId, journalEntryId, or highlightId

    // Reminder timing
    remindAt: text('remind_at').notNull(), // ISO datetime

    // Optional context for highlights
    highlightText: text('highlight_text'), // The highlighted text (for display)
    highlightStart: integer('highlight_start'), // Character offset start
    highlightEnd: integer('highlight_end'), // Character offset end

    // Reminder metadata
    title: text('title'), // Custom reminder title (optional)
    note: text('note'), // User note about why they set reminder

    // Status tracking
    status: text('status').notNull().default('pending'), // ReminderStatus
    triggeredAt: text('triggered_at'), // When reminder was shown
    dismissedAt: text('dismissed_at'), // When user dismissed
    snoozedUntil: text('snoozed_until'), // If snoozed, when to remind again

    // Timestamps
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    modifiedAt: text('modified_at')
      .notNull()
      .default(sql`(datetime('now'))`)
  },
  (table) => [
    index('idx_reminders_target').on(table.targetType, table.targetId),
    index('idx_reminders_remind_at').on(table.remindAt),
    index('idx_reminders_status').on(table.status)
  ]
)

export type Reminder = typeof reminders.$inferSelect
export type NewReminder = typeof reminders.$inferInsert
```

---

## Reminder TypeScript Interfaces

### Reminder Full Interface

```typescript
// For frontend/API use
interface ReminderFull {
  id: string
  targetType: ReminderTargetType
  targetId: string

  // Timing
  remindAt: Date

  // Highlight context (only for 'highlight' type)
  highlightText: string | null
  highlightStart: number | null
  highlightEnd: number | null

  // Metadata
  title: string | null
  note: string | null

  // Status
  status: ReminderStatus
  triggeredAt: Date | null
  dismissedAt: Date | null
  snoozedUntil: Date | null

  // Timestamps
  createdAt: Date
  modifiedAt: Date

  // Computed/loaded (from join)
  targetTitle: string // Note title, journal date, or parent note title for highlights
  targetPreview: string // Excerpt or highlight text
}
```

### Reminder Request Types

```typescript
// Create reminder for a note
interface CreateNoteReminderRequest {
  noteId: string
  remindAt: string // ISO datetime
  title?: string
  note?: string
}

// Create reminder for a journal entry
interface CreateJournalReminderRequest {
  journalEntryId: string
  remindAt: string
  title?: string
  note?: string
}

// Create reminder for a highlight
interface CreateHighlightReminderRequest {
  noteId: string // Parent note
  highlightText: string // Selected text
  highlightStart: number // Character offset
  highlightEnd: number // Character offset
  remindAt: string
  title?: string
  note?: string
}

// Update reminder
interface UpdateReminderRequest {
  id: string
  remindAt?: string
  title?: string
  note?: string
}

// Snooze reminder
interface SnoozeReminderRequest {
  id: string
  snoozeUntil: string // ISO datetime
}

// List reminders with filters
interface ListRemindersRequest {
  targetType?: ReminderTargetType
  targetId?: string
  status?: ReminderStatus | ReminderStatus[]
  fromDate?: string
  toDate?: string
  limit?: number
  offset?: number
}
```

---

## Reminder Migration SQL

```sql
-- Migration: 006_reminders.sql
-- Creates reminders table for notes, journal, and highlight reminders

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,

  remind_at TEXT NOT NULL,

  highlight_text TEXT,
  highlight_start INTEGER,
  highlight_end INTEGER,

  title TEXT,
  note TEXT,

  status TEXT NOT NULL DEFAULT 'pending',
  triggered_at TEXT,
  dismissed_at TEXT,
  snoozed_until TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reminders_target ON reminders(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reminders_remind_at ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
```

---

## Reminder Validation Schemas (Zod)

```typescript
import { z } from 'zod'

export const ReminderTargetTypeSchema = z.enum(['note', 'journal', 'highlight'])
export const ReminderStatusSchema = z.enum(['pending', 'triggered', 'dismissed', 'snoozed'])

export const CreateNoteReminderSchema = z.object({
  noteId: z.string().min(1),
  remindAt: z.string().datetime(),
  title: z.string().max(200).optional(),
  note: z.string().max(1000).optional()
})

export const CreateJournalReminderSchema = z.object({
  journalEntryId: z.string().min(1),
  remindAt: z.string().datetime(),
  title: z.string().max(200).optional(),
  note: z.string().max(1000).optional()
})

export const CreateHighlightReminderSchema = z
  .object({
    noteId: z.string().min(1),
    highlightText: z.string().min(1).max(5000),
    highlightStart: z.number().int().min(0),
    highlightEnd: z.number().int().min(0),
    remindAt: z.string().datetime(),
    title: z.string().max(200).optional(),
    note: z.string().max(1000).optional()
  })
  .refine((data) => data.highlightEnd > data.highlightStart, {
    message: 'highlightEnd must be greater than highlightStart'
  })

export const UpdateReminderSchema = z.object({
  id: z.string().min(1),
  remindAt: z.string().datetime().optional(),
  title: z.string().max(200).optional(),
  note: z.string().max(1000).optional()
})

export const SnoozeReminderSchema = z.object({
  id: z.string().min(1),
  snoozeUntil: z.string().datetime()
})

export const ListRemindersSchema = z.object({
  targetType: ReminderTargetTypeSchema.optional(),
  targetId: z.string().optional(),
  status: z.union([ReminderStatusSchema, z.array(ReminderStatusSchema)]).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0)
})
```

---

## Reminder Example Data

### Note Reminder

```json
{
  "id": "rem_note_a1b2c3",
  "targetType": "note",
  "targetId": "note_xyz789",
  "remindAt": "2025-01-15T09:00:00Z",
  "highlightText": null,
  "highlightStart": null,
  "highlightEnd": null,
  "title": "Review research findings",
  "note": "Check if conclusions still hold after more data",
  "status": "pending",
  "triggeredAt": null,
  "dismissedAt": null,
  "snoozedUntil": null,
  "createdAt": "2025-12-29T10:30:00Z",
  "modifiedAt": "2025-12-29T10:30:00Z"
}
```

### Journal Reminder (Reflection)

```json
{
  "id": "rem_journal_d4e5f6",
  "targetType": "journal",
  "targetId": "journal_2025-12-29",
  "remindAt": "2026-01-29T09:00:00Z",
  "highlightText": null,
  "highlightStart": null,
  "highlightEnd": null,
  "title": "1 month reflection",
  "note": "How did the new year's resolution go?",
  "status": "pending",
  "triggeredAt": null,
  "dismissedAt": null,
  "snoozedUntil": null,
  "createdAt": "2025-12-29T14:00:00Z",
  "modifiedAt": "2025-12-29T14:00:00Z"
}
```

### Highlight Reminder

```json
{
  "id": "rem_highlight_g7h8i9",
  "targetType": "highlight",
  "targetId": "note_abc123",
  "remindAt": "2025-01-05T10:00:00Z",
  "highlightText": "The key insight here is that spaced repetition improves retention by 40%",
  "highlightStart": 1234,
  "highlightEnd": 1312,
  "title": null,
  "note": "Test this with my own learning",
  "status": "pending",
  "triggeredAt": null,
  "dismissedAt": null,
  "snoozedUntil": null,
  "createdAt": "2025-12-29T11:45:00Z",
  "modifiedAt": "2025-12-29T11:45:00Z"
}
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
