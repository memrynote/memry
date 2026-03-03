# Implementation Plan: Inbox System for Quick Capture

**Branch**: `005-inbox-capture` | **Date**: 2025-12-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/005-inbox-capture/spec.md`

## Summary

Build the backend data layer for Memry's inbox system enabling quick capture of links, text notes, images, voice memos, web clips, PDFs, and social posts. The implementation uses **Drizzle ORM** with better-sqlite3 (consistent with existing core data layer), stores inbox items in `data.db`, and binary attachments in the vault's `attachments/inbox/` directory. The system supports filing items to notes/folders, bulk operations, snooze functionality, stale detection, and AI-powered filing suggestions.

## Technical Context

**Language/Version**: TypeScript 5.9+ with strict mode  
**Primary Dependencies**:

- drizzle-orm ^0.38.x (existing - TypeScript ORM)
- better-sqlite3 ^11.x (existing - SQLite driver)
- chokidar ^4.x (existing - file watching for attachments)
- nanoid ^5.x (existing - unique IDs)
- zod ^3.24.x (existing - schema validation)
- metascraper + metascraper-\* (NEW - URL metadata extraction)
- pdf-parse (NEW - PDF text extraction)
- pdfjs-dist (NEW - PDF thumbnail generation)
- tesseract.js (NEW - OCR for scanned PDFs, optional)
- openai ^4.x (NEW - transcription via Whisper API, AI suggestions)

**Storage**:

- SQLite via Drizzle ORM + better-sqlite3 in `data.db` (inbox_items, inbox_tags, snooze_schedule, filing_suggestions, inbox_stats tables)
- File system for binary attachments in `vault/attachments/inbox/{itemId}/`
- Voice recordings stored as WebM/MP3 files
- Images stored with thumbnails
- PDFs stored with first-page thumbnails

**Testing**: Vitest for unit/integration tests  
**Target Platform**: Electron 38+ (macOS, Windows, Linux)  
**Project Type**: Electron desktop application (main + renderer processes)

**Performance Goals**:

- Link metadata fetch < 3 seconds
- Text capture to display < 100ms
- Bulk processing 10 items < 30 seconds
- Voice transcription < 30s for recordings < 1 minute
- PDF text extraction < 5s for < 20 pages
- Inbox list render 100 items without lag
- Global capture shortcut response < 200ms
- Filing suggestions appear < 1 second

**Constraints**:

- Main process handles all file/database operations
- Renderer communicates via IPC only
- Zero data loss for captured items
- Voice transcription requires API key (OpenAI Whisper)
- OCR is optional/async (can be slow for large PDFs)
- Social post extraction may be blocked by some platforms

**Scale/Scope**:

- Support thousands of inbox items
- Voice recordings up to 5 minutes
- Images up to 10MB
- PDFs up to 50MB (with warning)

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

| Principle                              | Status  | Implementation                                                                                                   |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| **I. Local-First Architecture**        | PASS    | All inbox data stored in local SQLite and vault folder; captures work offline except link metadata/transcription |
| **II. E2EE**                           | N/A     | Encryption layer is separate feature; inbox items inherit vault encryption when implemented                      |
| **III. No Vendor Lock-In**             | PASS    | Inbox items exportable to JSON; attachments are standard files (images, audio, PDF); no proprietary formats      |
| **IV. Privacy by Design**              | PASS    | All data local by default; external API calls (Whisper, metadata) are explicit user actions                      |
| **V. Offline-First**                   | PASS    | Core capture works offline; link metadata queued for when online; transcription requires network                 |
| **VI. File System as Source of Truth** | PARTIAL | Binary attachments are files; metadata in SQLite (data.db is source of truth for inbox)                          |
| **VII. Database for Structured Data**  | PASS    | Inbox items, tags, snooze schedules stored in data.db                                                            |
| **VIII. External Edit Detection**      | N/A     | Inbox attachments not expected to be edited externally                                                           |
| **IX. Rename Tracking**                | N/A     | Inbox items use immutable IDs; not file-based                                                                    |
| **X. Single Source of Truth**          | PASS    | data.db is authoritative for inbox metadata; files for attachments                                               |

**Quality Standards Compliance**:

- Type Safety: All IPC messages validated with Zod schemas at boundaries
- Performance: Debounced capture input, lazy loading for lists, thumbnails for images/PDFs
- Accessibility: Keyboard navigation, screen reader announcements (existing in UI)
- Error Handling: Graceful degradation for failed fetches, retry capability
- Defensive Coding: URL validation, file size limits, timeout handling

## Project Structure

### Documentation (this feature)

```text
specs/005-inbox-capture/
├── plan.md              # This file
├── research.md          # Phase 0 output - technology research
├── data-model.md        # Phase 1 output - entity schemas
├── quickstart.md        # Phase 1 output - setup guide
├── contracts/           # Phase 1 output - IPC API definitions
│   └── inbox-api.ts     # Inbox IPC contract
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── shared/
│   ├── db/
│   │   └── schema/
│   │       └── inbox.ts            # Extended inbox schema (already exists, needs expansion)
│   └── contracts/
│       └── inbox-api.ts            # NEW: Inbox IPC contract
├── main/
│   ├── inbox/                      # NEW: Inbox service module
│   │   ├── index.ts                # Module exports
│   │   ├── capture.ts              # Capture handlers (text, link, image, voice)
│   │   ├── metadata.ts             # URL metadata extraction
│   │   ├── transcription.ts        # Voice transcription (Whisper)
│   │   ├── pdf.ts                  # PDF handling (text extraction, thumbnails)
│   │   ├── social.ts               # Social post extraction
│   │   ├── filing.ts               # Filing operations (to notes/folders)
│   │   ├── suggestions.ts          # AI-powered filing suggestions
│   │   ├── snooze.ts               # Snooze/remind functionality
│   │   ├── stats.ts                # Inbox statistics
│   │   └── attachments.ts          # Inbox attachment management
│   ├── ipc/
│   │   └── inbox-handlers.ts       # NEW: Inbox IPC handlers
│   └── lib/
│       └── url-utils.ts            # NEW: URL validation/parsing utilities
├── preload/
│   └── index.ts                    # Add inbox API to preload
└── renderer/
    └── src/
        ├── services/
        │   └── inbox-service.ts    # NEW: Inbox IPC client
        └── hooks/
            └── use-inbox.ts        # NEW: Inbox state hooks (replace sample data)

# Vault structure
vault/
└── attachments/
    └── inbox/                      # NEW: Inbox-specific attachments
        └── {itemId}/
            ├── original.{ext}      # Original file
            └── thumbnail.{ext}     # Generated thumbnail (if applicable)
```

**Structure Decision**: Follows established patterns from 001-core-data-layer. New `src/main/inbox/` module contains all inbox-specific logic. Extends existing schema in `src/shared/db/schema/inbox.ts`. IPC handlers follow existing patterns in `src/main/ipc/`.

## Complexity Tracking

| Violation                         | Why Needed                                                 | Simpler Alternative Rejected Because                             |
| --------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- |
| External API for transcription    | Voice-to-text requires ML; Whisper API is high quality     | Local whisper.cpp would require 1GB+ model download, slow on CPU |
| External API for URL metadata     | Cross-origin restrictions in Electron                      | Simple regex extraction misses most metadata                     |
| Separate inbox attachments folder | Inbox items are temporary; notes attachments are permanent | Mixing would complicate cleanup when items are deleted           |
| AI filing suggestions             | User-requested feature for smart filing                    | Rule-based suggestions would be inflexible                       |

## Implementation Phases

### Phase 1: Core Inbox Backend (Week 1-2)

1. Extend inbox schema in `src/shared/db/schema/inbox.ts`
2. Create inbox IPC contract in `src/shared/contracts/inbox-api.ts`
3. Implement basic CRUD handlers in `src/main/ipc/inbox-handlers.ts`
4. Text capture endpoint
5. Link capture with metadata extraction (metascraper)
6. Connect InboxPage to real data (replace sample data)

### Phase 2: Image & Voice Capture (Week 3-4)

1. Image capture (drag-drop, clipboard paste)
2. Thumbnail generation for images
3. Voice recording in renderer
4. Voice file storage
5. Whisper transcription integration

### Phase 3: Filing & Organization (Week 5-6)

1. Filing to folders
2. Convert to note
3. Link to existing note
4. Tag management
5. Bulk operations (file, delete, tag)
6. Stale item detection and highlighting

### Phase 4: Advanced Capture (Week 7-8)

1. PDF capture and text extraction
2. PDF thumbnail generation
3. OCR for scanned PDFs (optional, async)
4. Social post detection and extraction
5. Web clipper (selected text capture)

### Phase 5: Smart Features (Week 9-10)

1. Snooze/remind functionality
2. AI filing suggestions (embeddings-based)
3. Inbox statistics tracking
4. Capture patterns/insights

### Phase 6: Global Capture (Week 11)

1. Global keyboard shortcut registration
2. Quick capture mini window
3. Clipboard auto-detection

## Dependencies

```json
{
  "dependencies": {
    "metascraper": "^5.45.0",
    "metascraper-author": "^5.45.0",
    "metascraper-date": "^5.45.0",
    "metascraper-description": "^5.45.0",
    "metascraper-image": "^5.45.0",
    "metascraper-logo": "^5.45.0",
    "metascraper-publisher": "^5.45.0",
    "metascraper-title": "^5.45.0",
    "pdf-parse": "^1.1.1",
    "pdfjs-dist": "^4.0.0",
    "sharp": "^0.33.0",
    "openai": "^4.0.0"
  },
  "devDependencies": {
    "@types/pdf-parse": "^1.1.4"
  }
}
```

**Optional Dependencies** (for enhanced features):

```json
{
  "tesseract.js": "^5.0.0" // OCR for scanned PDFs
}
```

## Risk Assessment

| Risk                             | Likelihood | Impact | Mitigation                                         |
| -------------------------------- | ---------- | ------ | -------------------------------------------------- |
| Metascraper fails on some sites  | High       | Low    | Fallback to basic URL + title extraction           |
| Whisper API cost for heavy users | Medium     | Medium | Show transcription as optional; track usage        |
| PDF text extraction fails        | Medium     | Low    | Store PDF without text; allow retry                |
| Social API blocking              | High       | Medium | Graceful degradation; show URL as fallback         |
| Large attachments slow down app  | Medium     | Medium | Size limits; async processing; progress indicators |
| Global shortcut conflicts        | Low        | Low    | Allow user customization; provide fallback         |

## Notes

- The existing frontend UI in `src/renderer/src/pages/inbox.tsx` uses sample data from `sampleInboxItems` - this will be replaced with real IPC calls
- The `InboxItem` type in `src/renderer/src/types/index.ts` needs to be aligned with the backend schema
- The existing `inbox_items` table in `src/shared/db/schema/inbox.ts` is minimal - needs significant expansion
- Consider using existing attachment utilities from `src/main/vault/attachments.ts` as reference
