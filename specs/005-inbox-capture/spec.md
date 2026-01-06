# Feature Specification: Inbox System for Quick Capture

**Feature Branch**: `005-inbox-capture`
**Created**: 2025-12-18
**Status**: Draft
**Input**: Build the inbox system for quick capture that connects to the existing InboxPage component

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Quick Link Capture with Preview (Priority: P1)

As a user, I want to quickly capture a link and have it automatically fetched with a rich preview (title, excerpt, image) so I can save interesting web content for later review without manually entering details.

**Why this priority**: Link capture is the most common use case for an inbox system. Users frequently encounter links they want to save while browsing, and automatic preview extraction dramatically improves the experience by providing context at a glance.

**Independent Test**: Can be fully tested by pasting a URL into the inbox, waiting for preview generation, and verifying that title, description, and image are displayed correctly.

**Acceptance Scenarios**:

1. **Given** the inbox page is open, **When** I paste a URL into the capture input, **Then** the system creates a new inbox item with a loading state and begins fetching the page metadata
2. **Given** a link is being fetched, **When** the fetch completes successfully, **Then** the inbox item displays the page title, excerpt, and hero image
3. **Given** a link is being fetched, **When** the fetch fails or times out, **Then** the inbox item displays an error state with the URL still visible and a retry option
4. **Given** I enter an invalid URL, **When** I attempt to capture it, **Then** the system displays a validation error without creating an inbox item

---

### User Story 2 - Quick Text Note Capture (Priority: P1)

As a user, I want to capture quick text notes without the overhead of creating a full note file so I can jot down thoughts immediately and organize them later.

**Why this priority**: Text capture is equally fundamental alongside link capture. Users need a frictionless way to capture fleeting thoughts and ideas that can be processed later.

**Independent Test**: Can be fully tested by typing text into the capture input, pressing Enter, and verifying the note appears in the inbox list.

**Acceptance Scenarios**:

1. **Given** the inbox page is open, **When** I type text and press Enter, **Then** a new text note item is created and appears in the inbox list
2. **Given** I'm typing in the capture input, **When** I enter markdown formatting (e.g., **bold**, _italic_, `code`), **Then** the formatting is preserved when the note is saved
3. **Given** the capture input is empty, **When** I press Enter, **Then** no inbox item is created
4. **Given** I'm typing a note, **When** I click the capture button instead of pressing Enter, **Then** the note is captured identically

---

### User Story 3 - File Inbox Items (Priority: P1)

As a user, I want to file inbox items to folders/projects or convert them to full notes so I can process my captured items and keep my knowledge base organized.

**Why this priority**: Without the ability to process captured items, the inbox becomes a dumping ground. Filing is the essential "processing" step that makes the capture system valuable.

**Independent Test**: Can be fully tested by selecting an inbox item, choosing a filing destination, and verifying the item is moved/converted correctly.

**Acceptance Scenarios**:

1. **Given** I have an inbox item selected, **When** I click the "File" button, **Then** a filing panel opens with folder/project selection options
2. **Given** the filing panel is open, **When** I select a folder destination and confirm, **Then** the item is moved to that folder and removed from the inbox
3. **Given** the filing panel is open, **When** I choose "Convert to Note", **Then** a new markdown note file is created with the item's content and the inbox item is deleted
4. **Given** I'm filing a link item, **When** I convert to note, **Then** the note includes the link URL, title, excerpt, and any captured metadata as frontmatter or structured content

---

### User Story 4 - Delete Inbox Items (Priority: P1)

As a user, I want to delete items I don't need so I can clear out irrelevant captures and keep my inbox manageable.

**Why this priority**: Deletion is a core inbox operation. Users must be able to remove items they no longer want to prevent inbox clutter.

**Independent Test**: Can be fully tested by selecting an item, clicking delete, confirming, and verifying the item is removed.

**Acceptance Scenarios**:

1. **Given** I have an inbox item, **When** I click the delete button, **Then** a confirmation prompt appears
2. **Given** a delete confirmation prompt is shown, **When** I confirm deletion, **Then** the item is permanently removed from the inbox
3. **Given** a delete confirmation prompt is shown, **When** I cancel, **Then** the item remains in the inbox unchanged

---

### User Story 5 - Bulk Select and Process Items (Priority: P1)

As a user, I want to bulk select and process multiple items at once so I can efficiently clear my inbox when I have many items to organize.

**Why this priority**: Inbox processing efficiency is critical for users who capture frequently. Without bulk operations, processing becomes tedious and users abandon the system.

**Independent Test**: Can be fully tested by selecting multiple items via keyboard shortcuts, applying a bulk action, and verifying all selected items are processed.

**Acceptance Scenarios**:

1. **Given** I'm viewing the inbox list, **When** I press Cmd+A, **Then** all visible items are selected
2. **Given** some items are selected, **When** I Cmd+click an item, **Then** its selection state is toggled
3. **Given** multiple items are selected, **When** the selection changes, **Then** a bulk action bar appears showing the count and available actions
4. **Given** multiple items are selected, **When** I choose "Bulk File", **Then** all selected items are filed to the chosen destination
5. **Given** multiple items are selected, **When** I choose "Bulk Delete", **Then** a confirmation dialog appears showing the count of items to delete

---

### User Story 6 - Image Capture (Priority: P2)

As a user, I want to capture screenshots and images into my inbox so I can save visual information alongside text and links.

**Why this priority**: Image capture extends the inbox to handle visual content, which is common in research and reference workflows. Important but not as frequent as text/link capture.

**Independent Test**: Can be fully tested by dragging an image file onto the inbox, verifying a thumbnail appears, and confirming the file is stored.

**Acceptance Scenarios**:

1. **Given** the inbox page is open, **When** I drag and drop an image file, **Then** a new image inbox item is created with a thumbnail preview
2. **Given** I have an image in my clipboard (from screenshot), **When** I press Cmd+V while the inbox is focused, **Then** the image is captured as a new inbox item
3. **Given** an image is captured, **When** I view the item details, **Then** the image file is stored in the attachments directory
4. **Given** an image with EXIF data is captured, **When** the metadata is extracted, **Then** relevant metadata (dimensions, format) is stored with the item

---

### User Story 7 - Voice Memo Capture with Transcription (Priority: P2)

As a user, I want to record voice memos that get transcribed so I can capture thoughts verbally when typing is inconvenient.

**Why this priority**: Voice capture provides an alternative input modality that's valuable for mobile-first or accessibility scenarios. Transcription makes the content searchable and actionable.

**Independent Test**: Can be fully tested by clicking record, speaking, stopping, and verifying the audio is saved and transcription appears.

**Acceptance Scenarios**:

1. **Given** the inbox page is open, **When** I click the record button, **Then** audio recording starts with a visual indicator
2. **Given** I'm recording, **When** I click stop, **Then** the audio is saved and transcription begins
3. **Given** a voice memo is saved, **When** transcription completes, **Then** the transcribed text appears with the audio item
4. **Given** transcription fails, **When** I view the item, **Then** an error message is shown with a retry option
5. **Given** the device has no microphone, **When** I click record, **Then** a clear error message explains the issue

---

### User Story 8 - Stale Item Highlighting (Priority: P2)

As a user, I want stale items (older than 7 days by default) highlighted so I can identify items that need attention or cleanup.

**Why this priority**: Stale detection prevents inbox rot by visually highlighting items that have been sitting too long, encouraging regular processing.

**Independent Test**: Can be fully tested by creating items with backdated timestamps and verifying they display the stale indicator.

**Acceptance Scenarios**:

1. **Given** an inbox item is older than 7 days, **When** I view the inbox, **Then** the item displays a visual stale indicator (different color/badge)
2. **Given** there are stale items, **When** I view the inbox list, **Then** stale items are visually grouped or separated from fresh items
3. **Given** there are stale items, **When** I click "File all stale to Unsorted", **Then** all stale items are moved to the Unsorted folder
4. **Given** I'm in settings, **When** I change the stale threshold, **Then** the new threshold is applied to stale detection

---

### User Story 9 - Global Capture Shortcut (Priority: P2)

As a user, I want a global shortcut to capture content even when the app is in the background so I can save items without switching contexts.

**Why this priority**: Global shortcuts dramatically reduce capture friction, allowing users to save content from any application without interrupting their workflow.

**Independent Test**: Can be fully tested by pressing the global shortcut while another app is focused, entering content in the popup, and verifying the item appears in the inbox.

**Acceptance Scenarios**:

1. **Given** the app is running (foreground or background), **When** I press Cmd+Shift+Space, **Then** a quick capture mini window appears
2. **Given** the quick capture window is open, **When** my clipboard contains a URL, **Then** the URL is auto-populated in the input field
3. **Given** the quick capture window is open, **When** I enter content and save, **Then** the item is added to the inbox and the window closes
4. **Given** the quick capture window is open, **When** I press Escape, **Then** the window closes without saving

---

### User Story 10 - Item Preview (Priority: P2)

As a user, I want to preview items before deciding what to do with them so I can review content without opening external applications.

**Why this priority**: Preview reduces the cognitive load of processing by allowing users to see full content inline, improving decision-making efficiency.

**Independent Test**: Can be fully tested by clicking an inbox item and verifying the preview panel shows the appropriate content type.

**Acceptance Scenarios**:

1. **Given** I click on a link item, **When** the preview loads, **Then** the article content is displayed in a reader-friendly format
2. **Given** I click on a text note item, **When** the preview loads, **Then** the full note text is displayed with markdown rendered
3. **Given** I click on an image item, **When** the preview loads, **Then** the full-size image is displayed
4. **Given** I click on a voice item, **When** the preview loads, **Then** an audio player and transcription text are displayed

---

### User Story 11 - Tag Items Before Filing (Priority: P3)

As a user, I want to add tags to items before filing so I can categorize content as part of my inbox processing workflow.

**Why this priority**: Tagging adds organizational flexibility but is not essential for the core capture-process-file workflow.

**Independent Test**: Can be fully tested by adding tags to an item and verifying the tags persist and are searchable.

**Acceptance Scenarios**:

1. **Given** I have an inbox item selected, **When** I click add tag, **Then** a tag input appears with autocomplete for existing tags
2. **Given** I'm adding a tag, **When** I type a new tag name, **Then** the tag is created and associated with the item
3. **Given** an item has tags, **When** I file the item, **Then** the tags are preserved on the filed item

---

### User Story 12 - Web Clipper (Priority: P2)

As a user, I want to clip selected text/content from web pages so I can save specific passages rather than entire pages.

**Why this priority**: Web clipping extends link capture to handle partial content extraction, which is essential for research workflows where users want to save specific quotes or sections.

**Independent Test**: Can be fully tested by activating clip mode, selecting text on a webpage, and verifying the clipped content appears in the inbox with source attribution.

**Acceptance Scenarios**:

1. **Given** I'm in the app, **When** I use Cmd+Shift+C while on a webpage, **Then** a clipping mode activates allowing me to select content
2. **Given** clipping mode is active, **When** I select text on a page, **Then** the selected text is captured with source URL and page title
3. **Given** I've captured a clip, **When** viewing the inbox item, **Then** it displays the quoted text with visual quote styling and attribution link
4. **Given** the clip contains images within the selection, **When** captured, **Then** images are saved locally with the clip
5. **Given** I select text with formatting (bold, italic, links), **When** captured, **Then** the formatting is preserved in the clip

---

### User Story 13 - PDF Capture (Priority: P2)

As a user, I want to import PDF files and have key content extracted so I can save documents in my knowledge base.

**Why this priority**: PDFs are ubiquitous in research, academic, and professional workflows. Supporting PDF capture makes the inbox useful for a wider range of content types.

**Independent Test**: Can be fully tested by dragging a PDF file onto the inbox, verifying a thumbnail is generated, and confirming text extraction completes.

**Acceptance Scenarios**:

1. **Given** the inbox is open, **When** I drag and drop a PDF file, **Then** a new PDF inbox item is created with the first page as thumbnail
2. **Given** a PDF is captured, **When** processing completes, **Then** the title, page count, and text excerpt are extracted and displayed
3. **Given** a PDF has selectable text, **When** I open the preview, **Then** I can view and search text from the document
4. **Given** a PDF is image-only (scanned), **When** processing, **Then** OCR is attempted with a status indicator showing progress
5. **Given** a PDF exceeds the size limit (e.g., >50MB), **When** I attempt to capture, **Then** a warning is shown with options to proceed or cancel

---

### User Story 14 - Tweet/Social Post Capture (Priority: P2)

As a user, I want to paste social media links and have them displayed with rich formatting so I can save posts from Twitter/X, LinkedIn, Mastodon, etc.

**Why this priority**: Social media is a significant source of information and ideas. Rich display of social posts improves the capture experience and makes saved content more useful.

**Independent Test**: Can be fully tested by pasting a Twitter/X URL into the capture input and verifying the post content, author info, and media are displayed correctly.

**Acceptance Scenarios**:

1. **Given** I paste a Twitter/X URL, **When** the link is fetched, **Then** the system detects it as a social post and extracts author, content, timestamp, and engagement metrics
2. **Given** a social post is captured, **When** viewing the card, **Then** it displays in a tweet-like format with profile image, handle, and formatted text
3. **Given** a post contains media (images/videos), **When** captured, **Then** media thumbnails are displayed in the card
4. **Given** a post is part of a thread, **When** captured, **Then** the system offers to capture the entire thread or just the single post
5. **Given** I paste a link from a supported platform (Twitter/X, LinkedIn, Mastodon, Bluesky, Threads), **When** fetched, **Then** platform-specific formatting is applied

---

### User Story 15 - Smart Filing Suggestions (Priority: P2)

As a user, I want AI-powered suggestions for where to file items so I can process my inbox faster with intelligent recommendations.

**Why this priority**: Smart suggestions reduce decision fatigue during inbox processing. AI-powered recommendations can significantly speed up the filing workflow for users with established folder structures.

**Independent Test**: Can be fully tested by selecting an inbox item and verifying that relevant folder/tag suggestions appear based on content similarity.

**Acceptance Scenarios**:

1. **Given** I select an inbox item, **When** the filing panel opens, **Then** 2-3 suggested folders/tags appear based on content analysis
2. **Given** suggestions are shown, **When** I hover over a suggestion, **Then** I see why it was recommended (e.g., "Similar to 5 notes in /projects/research")
3. **Given** I accept a suggestion, **When** filing completes, **Then** the system learns from my choice to improve future suggestions
4. **Given** I reject suggestions repeatedly for a certain pattern, **When** similar suggestions appear, **Then** they are deprioritized or excluded
5. **Given** no relevant suggestions can be determined, **When** the filing panel opens, **Then** a "No suggestions" message appears with manual filing options

---

### User Story 16 - Remind Me Later / Snooze (Priority: P2)

As a user, I want to snooze inbox items to resurface later so I can defer items I can't process now without losing them.

**Why this priority**: Not all captured items can be processed immediately. Snooze functionality prevents inbox overload by allowing users to defer items without deleting them.

**Independent Test**: Can be fully tested by snoozing an item, verifying it disappears from the main view, and confirming it reappears at the scheduled time.

**Acceptance Scenarios**:

1. **Given** I have an inbox item, **When** I click the snooze/remind button, **Then** a picker appears with options: Later Today, Tomorrow, Next Week, Pick Date
2. **Given** I snooze an item, **When** confirmed, **Then** the item is hidden from the main inbox view with a "snoozed" status
3. **Given** an item's snooze time arrives, **When** I next open the inbox, **Then** the item reappears at the top with a "Snoozed item returned" indicator
4. **Given** I want to see snoozed items, **When** I select the "Snoozed" filter, **Then** all snoozed items are displayed with their return dates
5. **Given** I'm viewing a snoozed item, **When** I click "Unsnooze", **Then** the item immediately returns to the main inbox

---

### User Story 17 - Inbox Stats Dashboard (Priority: P3)

As a user, I want to see statistics about my inbox usage so I can understand my capture and processing habits.

**Why this priority**: Stats provide insight into usage patterns but are not essential for core inbox functionality. Useful for power users who want to optimize their workflow.

**Independent Test**: Can be fully tested by capturing several items over time and verifying the stats panel displays accurate counts and breakdowns.

**Acceptance Scenarios**:

1. **Given** I'm on the inbox page, **When** I click the stats icon, **Then** a panel shows: items captured today/this week, items processed, average time-to-process
2. **Given** viewing stats, **When** I see the breakdown, **Then** it shows captures by type (links, notes, images, voice, clips, PDFs)
3. **Given** I have stale items, **When** viewing stats, **Then** I see "X items older than 7 days" with a quick action to review them
4. **Given** the panel is open, **When** I view weekly trends, **Then** a simple bar chart shows daily capture counts for the past 7 days

---

### User Story 18 - Capture Patterns / Insights (Priority: P3)

As a user, I want insights about when and what I capture most so I can optimize my capture workflow and understand my information diet.

**Why this priority**: Insights help users understand their capture behavior over time. This is an analytics feature that adds value but is not required for core functionality.

**Independent Test**: Can be fully tested by capturing items at various times and verifying the insights view shows accurate patterns and breakdowns.

**Acceptance Scenarios**:

1. **Given** I access the insights view, **When** data is loaded, **Then** I see a heatmap of capture times (hour of day / day of week)
2. **Given** viewing patterns, **When** I look at content breakdown, **Then** I see percentage split by item type with trend arrows (up/down vs. previous period)
3. **Given** I capture from recurring domains, **When** viewing top sources, **Then** the top 5 domains I capture from are listed with counts
4. **Given** I have tags on items, **When** viewing tag insights, **Then** most-used tags are shown with counts
5. **Given** insufficient data (< 10 items), **When** viewing insights, **Then** a message explains more data is needed for meaningful patterns

---

### Edge Cases

- What happens when a URL requires authentication to access? System should gracefully fail with a message indicating the page could not be accessed, while preserving the URL for manual review.
- What happens when pasting very long text content? Text is captured in full without truncation, but display in the list is truncated with "..." and full content visible in preview.
- What happens when audio recording exceeds maximum duration? Recording stops automatically at a reasonable limit (5 minutes) with a notification.
- What happens when storage space is low? System warns users before capture and prevents new captures if storage is critically low.
- What happens when network is unavailable during link fetch? System queues the fetch and retries when connectivity is restored, showing offline indicator.
- What happens when bulk selecting items across multiple pages? Selection is maintained across pagination/virtualized scrolling.
- What happens when a social media post is deleted after capture? The captured content remains in the inbox with an indicator that the original is no longer available.
- What happens when a PDF is password-protected? System detects protection and prompts for password, or stores the file without text extraction.
- What happens when OCR fails on a scanned PDF? System stores the PDF with thumbnail but marks text extraction as failed with retry option.
- What happens when web clip source page changes? The original clipped content is preserved; a "source may have changed" indicator can be shown on revisit.
- What happens when snooze time passes while app is closed? On next app launch, all due snoozed items are surfaced immediately with a summary notification.
- What happens when AI suggestions have low confidence? System shows suggestions with a "low confidence" indicator or omits suggestions entirely.

## Requirements _(mandatory)_

### Functional Requirements

**Core Capture**

- **FR-001**: System MUST provide a quick capture input that accepts both URLs and plain text
- **FR-002**: System MUST automatically detect whether input is a URL or text and create the appropriate item type
- **FR-003**: System MUST fetch and parse webpage metadata (title, description, excerpt, hero image, favicon) for URL captures
- **FR-004**: System MUST store captured text notes with full markdown content preserved
- **FR-005**: System MUST create unique identifiers for each inbox item

**Image Capture**

- **FR-006**: System MUST accept image files via drag-and-drop
- **FR-007**: System MUST accept images pasted from clipboard
- **FR-008**: System MUST store image files in a designated attachments directory
- **FR-009**: System MUST generate thumbnail previews for captured images

**Voice Capture**

- **FR-010**: System MUST provide audio recording controls (start, stop)
- **FR-011**: System MUST display recording status indicator while recording
- **FR-012**: System MUST store audio files in the attachments directory
- **FR-013**: System MUST transcribe audio recordings to text
- **FR-014**: System MUST display transcription status (pending, processing, complete, failed)

**Filing & Organization**

- **FR-015**: System MUST allow filing items to folders or projects
- **FR-016**: System MUST support converting inbox items to full markdown notes
- **FR-017**: System MUST support linking inbox items to existing notes
- **FR-018**: System MUST remove filed items from the inbox view
- **FR-019**: System MUST support adding tags to inbox items

**Bulk Operations**

- **FR-020**: System MUST support selecting multiple items via Cmd+click
- **FR-021**: System MUST support selecting all items via Cmd+A
- **FR-022**: System MUST support range selection via Shift+click
- **FR-023**: System MUST display a bulk action bar when items are selected
- **FR-024**: System MUST support bulk filing of selected items
- **FR-025**: System MUST support bulk deletion with confirmation dialog

**Stale Detection**

- **FR-026**: System MUST identify items older than the stale threshold (default: 7 days)
- **FR-027**: System MUST visually distinguish stale items from fresh items
- **FR-028**: System MUST provide quick action to file all stale items
- **FR-029**: System MUST allow users to configure the stale threshold in settings

**Global Capture**

- **FR-030**: System MUST register a global keyboard shortcut (Cmd+Shift+Space)
- **FR-031**: System MUST display a quick capture window when shortcut is pressed
- **FR-032**: System MUST auto-detect and populate clipboard URL in quick capture
- **FR-033**: System MUST save captured items and close the window on submit

**Preview**

- **FR-034**: System MUST display full preview when an item is selected
- **FR-035**: System MUST render link content in reader-friendly format
- **FR-036**: System MUST display full-size images in preview
- **FR-037**: System MUST provide audio playback controls for voice items

**Data Persistence**

- **FR-038**: System MUST persist inbox items across application restarts
- **FR-039**: System MUST persist processing state for items being fetched/transcribed
- **FR-040**: System MUST handle failed operations gracefully with retry capability

**Web Clipper**

- **FR-041**: System MUST provide a clipping mode activated via keyboard shortcut (Cmd+Shift+C)
- **FR-042**: System MUST capture selected text with source URL and page title
- **FR-043**: System MUST preserve text formatting (bold, italic, links) in clips
- **FR-044**: System MUST save images within clip selection to local attachments
- **FR-045**: System MUST display clips with quote styling and source attribution

**PDF Capture**

- **FR-046**: System MUST accept PDF files via drag-and-drop
- **FR-047**: System MUST generate thumbnail from first page of PDF
- **FR-048**: System MUST extract text content from PDFs with selectable text
- **FR-049**: System MUST attempt OCR for image-only/scanned PDFs
- **FR-050**: System MUST display PDF metadata (title, page count, file size)
- **FR-051**: System MUST handle password-protected PDFs with password prompt

**Social Post Capture**

- **FR-052**: System MUST detect social media URLs (Twitter/X, LinkedIn, Mastodon, Bluesky, Threads)
- **FR-053**: System MUST extract author info (name, handle, avatar) from social posts
- **FR-054**: System MUST extract post content, timestamp, and engagement metrics
- **FR-055**: System MUST download and display media attachments (images, video thumbnails)
- **FR-056**: System MUST offer thread capture option for multi-post threads

**Smart Filing Suggestions**

- **FR-057**: System MUST analyze inbox item content for filing suggestions
- **FR-058**: System MUST display 2-3 folder/tag suggestions when filing panel opens
- **FR-059**: System MUST show reasoning for each suggestion on hover
- **FR-060**: System MUST learn from user filing decisions to improve future suggestions
- **FR-061**: System MUST allow users to dismiss or deprioritize unwanted suggestions

**Snooze / Remind Me Later**

- **FR-062**: System MUST provide snooze options (Later Today, Tomorrow, Next Week, Custom Date)
- **FR-063**: System MUST hide snoozed items from main inbox view
- **FR-064**: System MUST resurface items when snooze time arrives
- **FR-065**: System MUST provide filter to view all snoozed items
- **FR-066**: System MUST allow manual unsnooze of snoozed items

**Inbox Stats**

- **FR-067**: System MUST track capture counts by day and by type
- **FR-068**: System MUST track processing/filing counts
- **FR-069**: System MUST calculate average time-to-process for filed items
- **FR-070**: System MUST display stats in a dedicated panel/view

**Capture Patterns**

- **FR-071**: System MUST generate capture time heatmap (hour x day of week)
- **FR-072**: System MUST calculate content type distribution with trends
- **FR-073**: System MUST identify top capture source domains
- **FR-074**: System MUST show most-used tags with counts
- **FR-075**: System MUST require minimum data threshold before showing patterns

### Key Entities

- **InboxItem**: The core entity representing any captured content. Contains id, type, title, timestamps, processing state, and type-specific data (url, content, filePath). Supports seven types: link, note, image, voice, clip, pdf, social.

- **InboxMetadata**: Associated metadata varying by item type. For links: siteName, description, excerpt, heroImage, favicon. For images: width, height, format. For voice: duration, transcription, transcriptionStatus. For clips: sourceUrl, sourceTitle, quotedText, capturedImages[]. For PDFs: pageCount, extractedTitle, textExcerpt, ocrStatus, fileSizeKb. For social posts: platform, authorName, authorHandle, authorAvatar, postContent, mediaUrls[], metrics (likes, reposts, replies), threadId.

- **FilingDestination**: Represents where an item can be filed. Can be a folder path, a note to link to, or conversion parameters for creating a new note.

- **FilingSuggestion**: AI-generated suggestion for filing. Contains destinationPath, confidence score, reasoning text, and suggestion type (folder, tag, or note link).

- **SnoozeSchedule**: Tracks snoozed items. Contains itemId, snoozedAt timestamp, snoozeUntil timestamp, and snooze reason (optional).

- **InboxStats**: Aggregated statistics. Contains captureCountByDay, captureCountByType, processedCount, averageTimeToProcess, staleItemCount.

- **CapturePattern**: Derived insights. Contains timeHeatmap (24x7 grid), typeDistribution with trends, topDomains[], topTags[].

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Users can capture a link and see preview within 3 seconds of pasting
- **SC-002**: Users can capture a text note with a single keypress (Enter) after typing
- **SC-003**: Users can process (file or delete) an inbox item in under 5 seconds
- **SC-004**: Users can bulk process 10 items in under 30 seconds
- **SC-005**: Voice transcription completes within 30 seconds for recordings under 1 minute
- **SC-006**: Inbox displays 100 items without noticeable scroll lag
- **SC-007**: Global capture shortcut activates within 200ms of keypress
- **SC-008**: 95% of link metadata fetches complete successfully (excluding blocked/authenticated sites)
- **SC-009**: Users can identify stale items at a glance without reading timestamps
- **SC-010**: Zero data loss for captured items during normal operation
- **SC-011**: Web clips capture selected content with formatting preserved in under 2 seconds
- **SC-012**: PDF text extraction completes within 5 seconds for documents under 20 pages
- **SC-013**: Social post metadata is extracted and displayed within 3 seconds of pasting URL
- **SC-014**: Filing suggestions appear within 1 second of opening the filing panel
- **SC-015**: Snoozed items resurface within 1 minute of their scheduled time when app is running
- **SC-016**: Inbox stats update in real-time as items are captured and processed
- **SC-017**: Capture patterns are generated from at least 10 items with 90% accuracy

## Assumptions

- The existing InboxPage component provides the layout shell and can be extended with new functionality
- The Electron main process is available for handling link fetching (to bypass CORS) and global shortcuts
- Voice transcription will use an external API (OpenAI Whisper) initially, with local processing as a future option
- The vault/attachments directory structure exists for storing binary files
- The tab system supports the inbox as a singleton tab
- Users have standard keyboard access for shortcuts (Cmd on macOS, Ctrl alternatives for other platforms)
- PDF.js or similar library is available for PDF rendering and text extraction
- OCR capability is available via external API (e.g., Tesseract.js or cloud OCR service)
- Social media APIs or scraping methods are available for extracting post metadata (may require API keys for some platforms)
- AI/ML service is available for generating filing suggestions (can use local embeddings or cloud API)
- System clock is reasonably accurate for snooze timing functionality
