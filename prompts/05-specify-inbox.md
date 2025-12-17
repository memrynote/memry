# Inbox & Quick Capture Specification

Quick capture system for links, notes, voice memos, and images.

```
/speckit.specify

Build the inbox system for quick capture that connects to the existing InboxPage component:

## USER STORIES

### P1 - Critical
1. As a user, I want to quickly capture a link and have it fetched with preview (title, excerpt, image)
2. As a user, I want to capture quick text notes without creating a full note
3. As a user, I want to file inbox items to folders/projects or convert them to notes
4. As a user, I want to bulk select and process multiple items at once
5. As a user, I want to delete items I don't need

### P2 - Important
6. As a user, I want to capture screenshots and images into my inbox
7. As a user, I want to record voice memos that get transcribed
8. As a user, I want stale items (>7 days old) highlighted for cleanup
9. As a user, I want a global shortcut to capture even when app is in background
10. As a user, I want to preview items before deciding what to do with them

### P3 - Nice to Have
11. As a user, I want AI to suggest how to organize similar items (clustering)
12. As a user, I want browser extension to send links directly to inbox
13. As a user, I want mobile share sheet integration (future)
14. As a user, I want to tag items before filing

## DATA MODEL

### InboxItem
```typescript
interface InboxItem {
  id: string                // UUID
  type: InboxItemType
  title: string             // User-editable or auto-generated
  createdAt: Date
  modifiedAt: Date

  // Type-specific data
  url?: string              // For links
  content?: string          // For notes, transcription
  filePath?: string         // For images, voice (relative to attachments/)

  // Metadata
  metadata: InboxMetadata

  // Processing state
  isProcessing: boolean     // Currently fetching/transcribing
  processingError?: string

  // Filing
  filedAt?: Date
  filedTo?: string          // Folder path or note ID
}

type InboxItemType = "link" | "note" | "image" | "voice"

interface InboxMetadata {
  // Link metadata
  siteName?: string
  description?: string
  excerpt?: string
  heroImage?: string
  favicon?: string

  // Image metadata
  width?: number
  height?: number
  format?: string

  // Voice metadata
  duration?: number         // Seconds
  transcription?: string
  transcriptionStatus?: "pending" | "processing" | "complete" | "failed"

  // Common
  source?: string           // "web-clipper", "share-sheet", "manual"
}
```

## FUNCTIONAL REQUIREMENTS

### Link Capture
```
On URL input:
1. Create InboxItem with type="link", isProcessing=true
2. Fetch URL in background (main process)
3. Parse HTML for:
   - Title (<title> or og:title)
   - Description (meta description or og:description)
   - Excerpt (first meaningful paragraph)
   - Hero image (og:image or largest image)
   - Favicon
   - Site name (og:site_name)
4. Update item with metadata
5. Set isProcessing=false
6. Handle errors gracefully (timeout, blocked, etc.)
```

### Note Capture
- Quick text input field always visible
- Enter or button creates note item
- Markdown supported in content
- No fetch needed, instant save

### Image Capture
- Drag and drop image files
- Paste from clipboard (Cmd+V)
- Screenshot capture (Cmd+Shift+4, then paste)
- Store in vault/attachments/ with UUID filename
- Extract EXIF metadata if available

### Voice Capture
- Record button starts recording (MediaRecorder API)
- Stop button saves and starts transcription
- Store audio file in vault/attachments/
- Transcription via:
  - Option A: Whisper API (OpenAI) - requires API key
  - Option B: Local whisper.cpp - bundled model
  - Make configurable in settings

### Filing Actions
```typescript
interface FilingOptions {
  // Move to folder (just organizes, keeps as inbox item type)
  folder?: string

  // Convert to note (creates .md file, deletes inbox item)
  convertToNote?: {
    title: string
    folder?: string
    tags?: string[]
  }

  // Link to existing note (adds reference)
  linkToNote?: {
    noteId: string
    section?: string  // Append to specific section
  }

  // Add tags (for organization before filing)
  tags?: string[]
}
```

### Bulk Operations
- Select multiple items (Cmd+click, Shift+click, Select All)
- Bulk file: apply same action to all selected
- Bulk delete: confirm dialog, then remove
- Bulk tag: add tags to all selected

### Stale Detection
- Items older than threshold (default 7 days) marked as stale
- Visual indicator (different color, section separator)
- Quick actions: "File all stale to Unsorted", "Delete all stale"
- Threshold configurable in settings

### Global Capture Shortcut
- Cmd+Shift+Space opens quick capture window
- Works when app is in background
- Mini window with:
  - URL input (auto-detects clipboard URL)
  - Quick note input
  - Voice record button
- Saves to inbox and closes

### Preview Panel
- Click item to see full preview
- Links: rendered article content (Reader mode style)
- Notes: full text
- Images: full size view
- Voice: audio player + transcription

## NON-FUNCTIONAL REQUIREMENTS

### Performance
- Link preview fetch completes in <3 seconds
- Voice transcription completes in <30 seconds (for 1 min audio)
- Inbox list with 100 items scrolls smoothly
- Global shortcut responds in <200ms

### Reliability
- Failed fetches retry once, then show error state
- Audio recording survives app crash (save chunks)
- Bulk operations are transactional (all or nothing)

## ACCEPTANCE CRITERIA

### Link Capture
- [ ] Pasting URL creates item and fetches preview
- [ ] Preview shows title, excerpt, and image
- [ ] Invalid URL shows error state
- [ ] Slow/blocked sites timeout gracefully

### Note Capture
- [ ] Typing text and pressing Enter creates note
- [ ] Markdown formatting preserved
- [ ] Empty input doesn't create item

### Image Capture
- [ ] Drag image file creates item
- [ ] Paste screenshot creates item
- [ ] Image thumbnail shown in list
- [ ] Original file stored in attachments

### Voice Capture
- [ ] Record button starts recording with indicator
- [ ] Stop button saves and queues transcription
- [ ] Transcription appears when complete
- [ ] Failed transcription shows retry option

### Filing
- [ ] "File" button opens filing panel
- [ ] Can select folder destination
- [ ] "Convert to Note" creates .md file
- [ ] "Link to Note" opens note picker
- [ ] Filed items removed from inbox

### Bulk Operations
- [ ] Cmd+A selects all items
- [ ] Cmd+click toggles selection
- [ ] Bulk action bar appears when selected
- [ ] Bulk file processes all selected
- [ ] Bulk delete shows confirmation

### Stale Items
- [ ] Items >7 days show stale indicator
- [ ] Stale section separated in list
- [ ] "File all to Unsorted" works
- [ ] Stale threshold configurable

### Global Capture
- [ ] Cmd+Shift+Space opens capture window
- [ ] Window appears quickly (<200ms)
- [ ] Clipboard URL auto-detected
- [ ] Saving closes window

### Edge Cases
- [ ] 100 items in inbox doesn't slow list
- [ ] Very long URLs truncated properly
- [ ] Missing metadata handled gracefully
- [ ] Network failure during fetch shows clear error
- [ ] Audio recording with no microphone shows error
```
