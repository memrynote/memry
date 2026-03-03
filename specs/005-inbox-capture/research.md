# Research: Inbox System for Quick Capture

**Feature**: 005-inbox-capture  
**Date**: 2025-12-27  
**Status**: Complete

## Overview

This document captures research findings and technology decisions for implementing Memry's inbox capture system backend. The research addresses unknowns from the Technical Context and evaluates best practices for each major component.

---

## 1. URL Metadata Extraction

### Decision: metascraper

**Rationale**: metascraper is a production-ready, modular library specifically designed for extracting metadata from web pages. It's used by companies like Microlink and handles edge cases that simpler solutions miss.

**Alternatives Considered**:

| Option                 | Pros                                                                | Cons                                       |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| **metascraper**        | Modular, extensive rule system, handles edge cases, well-maintained | Requires multiple sub-packages             |
| **open-graph-scraper** | Simple API, single package                                          | Less comprehensive, misses non-OG metadata |
| **unfurl**             | Good Twitter/OEmbed support                                         | Less maintained, narrower scope            |
| **Custom regex**       | No dependencies                                                     | Misses most metadata, brittle              |

**Implementation Notes**:

- Run in Electron main process to bypass CORS
- Use `got` or native `fetch` for HTTP requests
- Set reasonable timeout (10 seconds) and follow redirects
- Fallback chain: OpenGraph → Twitter Card → HTML meta → page title

**Dependencies**:

```json
{
  "metascraper": "^5.45.0",
  "metascraper-author": "^5.45.0",
  "metascraper-date": "^5.45.0",
  "metascraper-description": "^5.45.0",
  "metascraper-image": "^5.45.0",
  "metascraper-logo": "^5.45.0",
  "metascraper-publisher": "^5.45.0",
  "metascraper-title": "^5.45.0",
  "metascraper-url": "^5.45.0"
}
```

---

## 2. Voice Transcription

### Decision: OpenAI Whisper API

**Rationale**: Best accuracy-to-complexity ratio. Whisper API provides state-of-the-art transcription without requiring local model management. Cost is acceptable for typical usage (~$0.006/minute).

**Alternatives Considered**:

| Option                    | Pros                                | Cons                                             |
| ------------------------- | ----------------------------------- | ------------------------------------------------ |
| **Whisper API**           | Best accuracy, simple API, no setup | Requires internet, cost per minute               |
| **whisper.cpp (local)**   | Offline, free                       | Large models (1-6GB), slow on CPU, complex setup |
| **Deepgram**              | Fast, streaming support             | Higher cost, less accurate than Whisper          |
| **Google Speech-to-Text** | Good accuracy                       | More complex auth, similar cost                  |
| **Web Speech API**        | Free, browser-native                | Poor accuracy, limited languages                 |

**Implementation Notes**:

- Audio format: WebM (from MediaRecorder) or convert to MP3
- Maximum duration: 5 minutes (enforced in UI)
- Show transcription status: pending → processing → complete/failed
- Store transcription in database, not as separate file
- Allow retry on failure
- Consider offline queue for when network unavailable

**API Configuration**:

```typescript
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const transcription = await openai.audio.transcriptions.create({
  file: audioFile,
  model: 'whisper-1',
  response_format: 'text'
})
```

**Cost Analysis** (Whisper API pricing: $0.006/minute):

- 100 memos/month × 1 min avg = $0.60/month
- 500 memos/month × 1 min avg = $3.00/month

---

## 3. PDF Processing

### Decision: pdf-parse + pdfjs-dist

**Rationale**: pdf-parse handles text extraction reliably. pdfjs-dist (Mozilla's PDF.js) handles rendering for thumbnail generation. Together they cover the core PDF needs without heavy dependencies.

**Alternatives Considered**:

| Option                     | Pros                               | Cons                                  |
| -------------------------- | ---------------------------------- | ------------------------------------- |
| **pdf-parse + pdfjs-dist** | Well-maintained, covers both needs | Two packages                          |
| **pdf-lib**                | Good for creation/modification     | No text extraction, no rendering      |
| **pdf2json**               | Simple text extraction             | No thumbnails, less maintained        |
| **pdfkit**                 | PDF creation                       | No parsing/extraction                 |
| **Poppler (native)**       | Most complete                      | Requires native binary, complex setup |

**Implementation Notes**:

**Text Extraction** (pdf-parse):

```typescript
import pdf from 'pdf-parse'
const dataBuffer = fs.readFileSync('file.pdf')
const data = await pdf(dataBuffer)
// data.text - extracted text
// data.numpages - page count
// data.info - metadata (title, author, etc.)
```

**Thumbnail Generation** (pdfjs-dist):

```typescript
import * as pdfjsLib from 'pdfjs-dist'
const doc = await pdfjsLib.getDocument(pdfPath).promise
const page = await doc.getPage(1)
const viewport = page.getViewport({ scale: 0.5 })
// Render to canvas, then save as image
```

**Size Limits**:

- Warning at 50MB
- Hard limit at 100MB (configurable in settings)

---

## 4. OCR for Scanned PDFs

### Decision: tesseract.js (optional, async)

**Rationale**: tesseract.js provides reasonable OCR quality without native dependencies. Since OCR is slow, it should be optional and run asynchronously with progress reporting.

**Alternatives Considered**:

| Option                | Pros                                     | Cons                   |
| --------------------- | ---------------------------------------- | ---------------------- |
| **tesseract.js**      | Pure JS, no native deps, decent accuracy | Slow (30s+ per page)   |
| **Google Vision API** | Excellent accuracy                       | Cost, requires API key |
| **AWS Textract**      | Good accuracy, structure detection       | Cost, AWS dependency   |
| **Local Tesseract**   | Faster than JS                           | Requires native binary |

**Implementation Notes**:

- Detect scanned PDFs by checking if pdf-parse returns empty/minimal text
- OCR is opt-in (user clicks "Extract text from scan")
- Show progress (page X of Y)
- Cache OCR results
- Consider Web Worker to avoid blocking UI

```typescript
import Tesseract from 'tesseract.js'
const result = await Tesseract.recognize(imageBlob, 'eng', {
  logger: (m) => console.log(m) // Progress updates
})
```

---

## 5. Social Media Post Extraction

### Decision: Custom extractors per platform

**Rationale**: Social media platforms frequently change their APIs and block scrapers. A custom approach with graceful degradation is more robust than depending on a single library.

**Platforms to Support** (prioritized):

1. Twitter/X - Most common, but frequently blocks
2. LinkedIn - Requires auth for most content
3. Mastodon - Open API, easiest
4. Bluesky - AT Protocol, relatively open
5. Threads - Limited API

**Implementation Strategy**:

1. **Detect platform** from URL pattern
2. **Attempt OEmbed** first (Twitter, LinkedIn support this)
3. **Fallback to metadata extraction** (metascraper)
4. **Final fallback**: Store URL with basic info

**OEmbed Endpoints**:

```typescript
const oembedEndpoints = {
  'twitter.com': 'https://publish.twitter.com/oembed',
  'x.com': 'https://publish.twitter.com/oembed',
  'linkedin.com': 'https://www.linkedin.com/oembed'
}
```

**Graceful Degradation**:

- Always store the URL (never fail capture)
- Show what metadata we could extract
- Allow manual title editing
- Indicate if extraction was partial

---

## 6. Image Processing

### Decision: sharp

**Rationale**: sharp is the fastest Node.js image processing library. It handles thumbnails, format conversion, and EXIF extraction efficiently.

**Alternatives Considered**:

| Option      | Pros                                      | Cons                    |
| ----------- | ----------------------------------------- | ----------------------- |
| **sharp**   | Fast, extensive features, well-maintained | Native dependency       |
| **jimp**    | Pure JS, no native deps                   | Slower, fewer formats   |
| **canvas**  | Good for manipulation                     | Overkill for thumbnails |
| **squoosh** | Modern formats (AVIF)                     | Less stable in Node     |

**Implementation Notes**:

- Thumbnail size: 400x400 max (maintain aspect ratio)
- Extract EXIF for dimensions, format metadata
- Strip EXIF GPS data for privacy (optional setting)
- Support: PNG, JPG, JPEG, GIF, WebP, SVG

```typescript
import sharp from 'sharp'

// Generate thumbnail
await sharp(inputPath)
  .resize(400, 400, { fit: 'inside' })
  .jpeg({ quality: 80 })
  .toFile(thumbnailPath)

// Extract metadata
const metadata = await sharp(inputPath).metadata()
// { width, height, format, space, ... }
```

---

## 7. AI Filing Suggestions

### Decision: OpenAI embeddings + local similarity search

**Rationale**: Use text embeddings to find similar notes/folders based on content. Store embeddings locally for fast retrieval. More sophisticated than keyword matching, less complex than fine-tuning.

**Alternatives Considered**:

| Option                                 | Pros                   | Cons                                |
| -------------------------------------- | ---------------------- | ----------------------------------- |
| **OpenAI embeddings**                  | High quality, easy API | Cost per request, requires internet |
| **Local embeddings (transformers.js)** | Offline, free          | Large models, slower                |
| **TF-IDF + cosine similarity**         | Simple, fast, offline  | Lower quality matches               |
| **LLM classification**                 | Most flexible          | Expensive, slow                     |

**Implementation Notes**:

1. **Generate embedding** for inbox item content
2. **Compare** against embeddings of existing notes and folder contents
3. **Rank** by similarity score
4. **Filter** to top 2-3 suggestions above threshold

```typescript
const embedding = await openai.embeddings.create({
  model: 'text-embedding-3-small',
  input: itemContent
})

// Store embeddings in index.db for fast local search
// Use SQLite vec extension or simple linear search for small collections
```

**Cost Analysis** (text-embedding-3-small: $0.00002/1K tokens):

- Average inbox item: ~100 tokens = $0.000002
- 1000 items/month = $0.002/month (negligible)

**Learning from User Actions**:

- Track which suggestions user accepts
- Weight recent filing patterns higher
- Option to disable suggestions

---

## 8. Global Keyboard Shortcut

### Decision: Electron globalShortcut API

**Rationale**: Electron's built-in `globalShortcut` module is the standard approach. Works across platforms with proper handling.

**Implementation Notes**:

- Default shortcut: `Cmd+Shift+Space` (macOS) / `Ctrl+Shift+Space` (Windows/Linux)
- Allow customization in settings
- Handle shortcut conflicts gracefully
- Show notification if shortcut registration fails

```typescript
import { globalShortcut, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    showQuickCaptureWindow()
  })
})
```

**Quick Capture Window**:

- Small floating window (400x200)
- Auto-focus input
- Auto-detect clipboard content
- Close on Escape or click outside
- Always on top

---

## 9. Snooze/Remind Implementation

### Decision: SQLite-based scheduling + app startup check

**Rationale**: Store snooze schedules in database. Check for due items on app startup and periodically while running. No external scheduler needed.

**Implementation Notes**:

**Schema**:

```sql
CREATE TABLE snooze_schedule (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items(id),
  snoozed_at TEXT NOT NULL,
  snooze_until TEXT NOT NULL,
  reason TEXT
);
```

**Check Logic**:

1. On app startup: Query for `snooze_until <= now()`
2. Every 1 minute while running: Check for newly due items
3. When item becomes due: Remove from snooze_schedule, notify user

**Snooze Options**:

- Later Today: current time + 4 hours (or 9 AM next day if after 5 PM)
- Tomorrow: 9 AM tomorrow
- Next Week: 9 AM next Monday
- Custom: User-selected date/time

---

## 10. Database Schema Evolution

### Decision: Extend existing inbox.ts schema

**Rationale**: The existing `inbox_items` table is minimal. We'll extend it with additional columns and add related tables, using Drizzle migrations.

**Current Schema** (from `src/shared/db/schema/inbox.ts`):

```typescript
export const inboxItems = sqliteTable('inbox_items', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  content: text('content').notNull(),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  filedAt: text('filed_at')
})
```

**Extended Schema** (see data-model.md for full details):

- Add columns: title, url, transcription, transcriptionStatus, processingStatus, attachmentPath, thumbnailPath, snoozedUntil
- Add tables: inbox_item_tags, filing_history, filing_suggestions
- Add indexes for type, createdAt, snoozedUntil queries

---

## 11. Attachment Storage Strategy

### Decision: Separate inbox attachments folder

**Rationale**: Inbox items are temporary and may be deleted without filing. Keeping inbox attachments separate from note attachments simplifies cleanup.

**Structure**:

```
vault/
└── attachments/
    ├── notes/              # Existing - note attachments by noteId
    │   └── {noteId}/
    └── inbox/              # NEW - inbox attachments by itemId
        └── {itemId}/
            ├── original.{ext}
            └── thumbnail.{ext}
```

**Cleanup**:

- When inbox item deleted: Remove `attachments/inbox/{itemId}/` folder
- When filed to note: Move attachments to `attachments/notes/{noteId}/`
- Orphaned folders: Periodically check for folders without matching items

---

## 12. Performance Considerations

### Link Metadata Fetching

- **Parallel limit**: Max 3 concurrent fetches
- **Timeout**: 10 seconds per URL
- **Caching**: Store fetched metadata; don't re-fetch for same URL within 24 hours
- **Queue**: If offline, queue URLs for later fetching

### Voice Transcription

- **Async processing**: Don't block UI during transcription
- **Progress**: Show "Transcribing..." status
- **Retry**: Allow manual retry on failure
- **Offline**: Queue for transcription when online

### PDF Processing

- **Worker thread**: Use worker for text extraction to avoid blocking
- **Thumbnails**: Generate asynchronously after capture confirmed
- **Large files**: Show progress bar for files > 10MB

### List Performance

- **Virtual scrolling**: Already implemented in UI
- **Pagination**: Load items in batches of 50
- **Lazy loading**: Thumbnails load on scroll into view

---

## Summary of Technology Choices

| Component           | Choice                  | Notes                  |
| ------------------- | ----------------------- | ---------------------- |
| URL Metadata        | metascraper             | Modular, comprehensive |
| Voice Transcription | OpenAI Whisper API      | Best accuracy          |
| PDF Text            | pdf-parse               | Reliable extraction    |
| PDF Thumbnails      | pdfjs-dist              | Mozilla's PDF.js       |
| OCR                 | tesseract.js            | Optional, async        |
| Image Processing    | sharp                   | Fast thumbnails        |
| AI Suggestions      | OpenAI embeddings       | text-embedding-3-small |
| Global Shortcut     | Electron globalShortcut | Built-in API           |
| Snooze              | SQLite + polling        | Simple, reliable       |

---

## Open Questions Resolved

1. ✅ **SQLite in Electron**: Already working in project (better-sqlite3 with electron-vite)
2. ✅ **Voice transcription cost vs quality**: Whisper API preferred; local optional future enhancement
3. ✅ **PDF handling complexity**: pdf-parse for text, pdfjs-dist for thumbnails covers needs
4. ✅ **Social media extraction reliability**: Graceful degradation approach, never fail capture
5. ✅ **AI suggestions without cloud**: Considered TF-IDF fallback, but embeddings preferred for quality

## Deferred Decisions

1. **Real-time collaboration for shared inboxes** - v2 feature
2. **Browser extension for web clipping** - separate project
3. **Mobile capture** - React Native phase
4. **Local Whisper model** - performance optimization if demand exists
