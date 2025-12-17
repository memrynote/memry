# Feature Specification: Inbox System for Quick Capture

**Feature Branch**: `005-inbox-capture`
**Created**: 2025-12-18
**Status**: Draft
**Input**: Build the inbox system for quick capture that connects to the existing InboxPage component

## User Scenarios & Testing *(mandatory)*

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
2. **Given** I'm typing in the capture input, **When** I enter markdown formatting (e.g., **bold**, *italic*, `code`), **Then** the formatting is preserved when the note is saved
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

### Edge Cases

- What happens when a URL requires authentication to access? System should gracefully fail with a message indicating the page could not be accessed, while preserving the URL for manual review.
- What happens when pasting very long text content? Text is captured in full without truncation, but display in the list is truncated with "..." and full content visible in preview.
- What happens when audio recording exceeds maximum duration? Recording stops automatically at a reasonable limit (5 minutes) with a notification.
- What happens when storage space is low? System warns users before capture and prevents new captures if storage is critically low.
- What happens when network is unavailable during link fetch? System queues the fetch and retries when connectivity is restored, showing offline indicator.
- What happens when bulk selecting items across multiple pages? Selection is maintained across pagination/virtualized scrolling.

## Requirements *(mandatory)*

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

### Key Entities

- **InboxItem**: The core entity representing any captured content. Contains id, type, title, timestamps, processing state, and type-specific data (url, content, filePath). Supports four types: link, note, image, voice.

- **InboxMetadata**: Associated metadata varying by item type. For links: siteName, description, excerpt, heroImage, favicon. For images: width, height, format. For voice: duration, transcription, transcriptionStatus.

- **FilingDestination**: Represents where an item can be filed. Can be a folder path, a note to link to, or conversion parameters for creating a new note.

## Success Criteria *(mandatory)*

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

## Assumptions

- The existing InboxPage component provides the layout shell and can be extended with new functionality
- The Electron main process is available for handling link fetching (to bypass CORS) and global shortcuts
- Voice transcription will use an external API (OpenAI Whisper) initially, with local processing as a future option
- The vault/attachments directory structure exists for storing binary files
- The tab system supports the inbox as a singleton tab
- Users have standard keyboard access for shortcuts (Cmd on macOS, Ctrl alternatives for other platforms)
