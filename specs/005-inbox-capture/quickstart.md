# Quickstart: Inbox System for Quick Capture

**Feature**: 005-inbox-capture  
**Date**: 2025-12-27

## Prerequisites

- Node.js 20+
- pnpm installed
- Vault folder already configured (via 001-core-data-layer)
- OpenAI API key (for voice transcription and AI suggestions)

## 1. Install Dependencies

```bash
cd /Users/h4yfans/sideproject/memry

# Core dependencies
pnpm add metascraper metascraper-author metascraper-date metascraper-description \
  metascraper-image metascraper-logo metascraper-publisher metascraper-title \
  metascraper-url

# PDF handling
pnpm add pdf-parse pdfjs-dist

# Image processing
pnpm add sharp

# AI services
pnpm add openai

# Dev dependencies
pnpm add -D @types/pdf-parse
```

### Optional Dependencies

```bash
# OCR for scanned PDFs (optional, adds ~15MB)
pnpm add tesseract.js
```

## 2. Environment Setup

Create or update `.env` in project root:

```env
# Required for voice transcription and AI suggestions
OPENAI_API_KEY=sk-...

# Optional: Customize transcription model
OPENAI_WHISPER_MODEL=whisper-1

# Optional: Customize embedding model
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
```

## 3. Database Migration

Run the Drizzle migration to add inbox tables:

```bash
# Generate migration from schema changes
pnpm drizzle-kit generate

# Apply migration (development)
pnpm drizzle-kit push
```

Or manually apply the migration SQL from `data-model.md`.

## 4. File Structure

Ensure the following structure exists in the vault:

```
vault/
├── attachments/
│   └── inbox/           # Created automatically
└── .memry/
    └── data.db          # Contains inbox_items table
```

## 5. Quick Verification

### Test Text Capture

```typescript
// In main process console or test file
import { captureText } from './src/main/inbox/capture'

const result = await captureText({
  content: 'Test inbox item',
  title: 'My Test Note',
  tags: ['test']
})

console.log(result)
// { success: true, item: { id: 'inbox_not_...', type: 'note', ... } }
```

### Test Link Capture

```typescript
import { captureLink } from './src/main/inbox/capture'

const result = await captureLink({
  url: 'https://example.com',
  tags: ['web']
})

console.log(result)
// { success: true, item: { id: 'inbox_lnk_...', type: 'link', metadata: {...} } }
```

### Test IPC from Renderer

```typescript
// In renderer console
const inbox = window.api.inbox

// Capture text
const item = await inbox.captureText({ content: 'Quick thought' })

// List items
const { items, total } = await inbox.list({ limit: 10 })
console.log(`${total} items in inbox`)

// File an item
await inbox.file({
  itemId: items[0].id,
  destination: { type: 'folder', path: 'Unsorted' }
})
```

## 6. Connect to Existing UI

The frontend inbox page (`src/renderer/src/pages/inbox.tsx`) currently uses sample data. To connect it to real data:

### Step 1: Create inbox service

```typescript
// src/renderer/src/services/inbox-service.ts
import type { InboxClientAPI } from '@shared/contracts/inbox-api'

export const inboxService: InboxClientAPI = window.api.inbox
```

### Step 2: Create inbox hook

```typescript
// src/renderer/src/hooks/use-inbox.ts
import { useState, useEffect, useCallback } from 'react'
import { inboxService } from '@/services/inbox-service'
import type { InboxItemListItem, InboxListResponse } from '@shared/contracts/inbox-api'

export function useInbox() {
  const [items, setItems] = useState<InboxItemListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true)
      const response = await inboxService.list({ limit: 100 })
      setItems(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load inbox')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // Listen for real-time updates
  useEffect(() => {
    const unsubscribe = window.api.on('inbox:captured', ({ item }) => {
      setItems((prev) => [item, ...prev])
    })
    return unsubscribe
  }, [])

  return { items, loading, error, refresh: fetchItems }
}
```

### Step 3: Update InboxPage

Replace sample data import with the hook:

```typescript
// src/renderer/src/pages/inbox.tsx

// Remove this:
// import { sampleInboxItems } from "@/data/sample-inbox-items"

// Add this:
import { useInbox } from '@/hooks/use-inbox'

export function InboxPage({ className }: InboxPageProps): React.JSX.Element {
  // Replace useState with hook:
  // const [items, setItems] = useState<InboxItem[]>(sampleInboxItems)
  const { items, loading, error, refresh } = useInbox()

  // ... rest of component
}
```

## 7. Key Code Locations

| Component        | Location                                         |
| ---------------- | ------------------------------------------------ |
| Schema           | `src/shared/db/schema/inbox.ts`                  |
| IPC Contract     | `src/shared/contracts/inbox-api.ts`              |
| IPC Channels     | `src/shared/ipc-channels.ts` (add InboxChannels) |
| Capture Service  | `src/main/inbox/capture.ts`                      |
| Metadata Fetcher | `src/main/inbox/metadata.ts`                     |
| Transcription    | `src/main/inbox/transcription.ts`                |
| IPC Handlers     | `src/main/ipc/inbox-handlers.ts`                 |
| Renderer Service | `src/renderer/src/services/inbox-service.ts`     |
| Inbox Hook       | `src/renderer/src/hooks/use-inbox.ts`            |

## 8. Testing

```bash
# Run all tests
pnpm test

# Run inbox-specific tests
pnpm test inbox

# Run with coverage
pnpm test:coverage
```

### Test File Structure

```
tests/
├── inbox/
│   ├── capture.test.ts      # Unit tests for capture functions
│   ├── metadata.test.ts     # Unit tests for URL metadata
│   ├── filing.test.ts       # Unit tests for filing operations
│   └── integration.test.ts  # Integration tests with real DB
└── e2e/
    └── inbox.spec.ts        # Playwright E2E tests
```

## 9. Development Workflow

```bash
# Start dev server
pnpm dev

# Open inbox page
# Navigate to Inbox in the sidebar

# Capture a link
# Paste a URL into the capture input

# Verify in database
pnpm drizzle-kit studio
# View inbox_items table
```

## 10. Troubleshooting

### Metadata fetch fails

- Check network connectivity
- Some sites block scrapers; this is expected
- Check console for specific error messages

### Transcription not working

- Verify OPENAI_API_KEY is set correctly
- Check OpenAI API quota/billing
- Audio must be valid WebM/MP3 format

### Attachments not showing

- Check that vault path is correctly configured
- Verify attachments/inbox/ directory exists
- Check file permissions

### Database errors

- Run `pnpm drizzle-kit push` to sync schema
- Check that data.db is accessible
- Verify no other process has locked the database

## Next Steps

After basic setup is working:

1. Implement remaining capture types (image, voice, PDF)
2. Add global capture shortcut
3. Implement snooze functionality
4. Add AI filing suggestions
5. Connect stats/patterns UI

See `tasks.md` (generated via `/speckit.tasks`) for detailed implementation tasks.
