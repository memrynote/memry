# Feature Specification: Journal System

**Feature Branch**: `004-journal-system`
**Created**: 2025-12-18
**Status**: Draft
**Input**: User description: "Build the journal system for daily entries that connects to the existing JournalPage component"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Daily Journal Entry (Priority: P1)

As a user, I want one journal entry per day stored as a markdown file so I can maintain a consistent daily writing practice with reliable persistence.

**Why this priority**: The core value proposition of a journal is the ability to write and save daily entries. Without this, no other features matter.

**Independent Test**: Can be fully tested by opening the journal, writing content for today, closing and reopening the app, and verifying the content persists. Delivers immediate journaling value.

**Acceptance Scenarios**:

1. **Given** the user opens the journal, **When** the view loads, **Then** today's entry (or empty editor for today's date) is displayed by default
2. **Given** the user types in the journal editor, **When** they pause typing for 1 second, **Then** the content is automatically saved to a markdown file
3. **Given** a journal entry exists for a date, **When** the user navigates to that date, **Then** the saved content loads in the editor
4. **Given** the user is writing, **When** the application crashes unexpectedly, **Then** the content from the last auto-save is preserved

---

### User Story 2 - Calendar Navigation with Heatmap (Priority: P1)

As a user, I want to navigate between days using a calendar widget that shows which days have entries via a visual heatmap so I can see my journaling activity at a glance and quickly jump to any day.

**Why this priority**: Navigation is essential for accessing past entries. The heatmap provides motivation by visualizing consistency and makes the calendar actionable rather than just decorative.

**Independent Test**: Can be tested by creating entries on multiple days, opening the calendar, verifying heatmap colors reflect entry length, and clicking different days to navigate. Delivers navigation and activity visualization.

**Acceptance Scenarios**:

1. **Given** the calendar widget is visible, **When** the user views it, **Then** the current month is displayed with today highlighted
2. **Given** days have journal entries, **When** viewing the calendar, **Then** each day shows a color intensity based on entry length (activity level 0-4)
3. **Given** the user clicks a past date, **When** the date loads, **Then** that day's entry content appears in the editor
4. **Given** the user clicks a future date, **When** the date loads, **Then** an empty editor appears with appropriate placeholder text
5. **Given** the user hovers over a day with an entry, **When** the tooltip appears, **Then** it shows the date and character count

---

### User Story 3 - Auto-Save Journal Entries (Priority: P1)

As a user, I want my journal entries auto-saved as I type so I never lose my reflections due to forgetting to save or unexpected issues.

**Why this priority**: Journal entries contain personal, irreplaceable reflections. Data integrity is critical for user trust.

**Independent Test**: Can be tested by writing content, waiting for save indicator, modifying content, and verifying both saves occur. Delivers peace of mind.

**Acceptance Scenarios**:

1. **Given** the user is writing in the journal, **When** they pause typing for 1 second, **Then** the entry auto-saves
2. **Given** a save operation is in progress, **When** the user continues typing, **Then** a new save is queued after the current save completes
3. **Given** an entry is being saved, **When** save completes, **Then** word count and character count update in the entry metadata
4. **Given** the entry has been saved, **When** the user navigates away and returns, **Then** all content is intact

---

### User Story 4 - Word and Character Count (Priority: P1)

As a user, I want to see word count and character count displayed while writing so I can track my writing progress and maintain awareness of entry length.

**Why this priority**: Writers often have daily word count goals. Real-time feedback supports writing habits and provides the data needed for heatmap activity levels.

**Independent Test**: Can be tested by typing content and verifying counts update in real-time. Delivers immediate writing feedback.

**Acceptance Scenarios**:

1. **Given** the user is viewing a journal entry, **When** they type content, **Then** word count and character count update in real-time
2. **Given** the counts are displayed, **Then** they appear in a subtle location that doesn't distract from writing
3. **Given** an empty entry, **When** the user starts typing, **Then** counts begin from zero

---

### User Story 5 - Focus Mode (Priority: P2)

As a user, I want a focus mode that hides distractions (sidebars) for deep writing so I can concentrate fully on my journal entry.

**Why this priority**: Journaling benefits from uninterrupted reflection. Focus mode removes visual clutter but isn't required for basic journaling functionality.

**Independent Test**: Can be tested by toggling focus mode (Cmd+\), verifying sidebars hide, editor width narrows, and the preference persists across sessions.

**Acceptance Scenarios**:

1. **Given** the user is in normal view, **When** they press Cmd+\, **Then** both sidebars smoothly animate out
2. **Given** focus mode is active, **When** the user views the editor, **Then** it centers with a narrower max-width for comfortable reading
3. **Given** focus mode is active, **When** the user presses Escape or Cmd+\, **Then** focus mode exits and sidebars restore
4. **Given** focus mode preference is set, **When** the user closes and reopens the app, **Then** focus mode preference is preserved

---

### User Story 6 - Day Context Sidebar (Priority: P2)

As a user, I want to see today's tasks and calendar events alongside my journal so I can reflect on my day with full context of what I did and what was scheduled.

**Why this priority**: Context enriches journal entries. Seeing tasks and events helps users write more meaningful reflections about their day.

**Independent Test**: Can be tested by viewing today's journal entry and verifying tasks appear in the sidebar with completion toggles that sync with the task system.

**Acceptance Scenarios**:

1. **Given** the user is viewing today's entry, **When** the sidebar loads, **Then** today's tasks are displayed with completion status
2. **Given** tasks are shown in the sidebar, **When** the user toggles a task complete, **Then** the task system updates and the UI reflects the change
3. **Given** there are overdue tasks, **When** viewing the sidebar, **Then** overdue tasks are highlighted with a warning indicator
4. **Given** the user navigates to a past date, **When** viewing the sidebar, **Then** tasks and events for that specific date are shown (or empty state if none)

---

### User Story 7 - Month and Year Views (Priority: P2)

As a user, I want month and year views to see my journaling history at a glance so I can browse past entries and understand my long-term journaling patterns.

**Why this priority**: Historical overview helps users appreciate their journaling habit and navigate to specific past entries without clicking through individual days.

**Independent Test**: Can be tested by clicking the month in breadcrumb to see month view, clicking year to see year view, and verifying navigation back to day view works.

**Acceptance Scenarios**:

1. **Given** the user is in day view, **When** they click the month in the breadcrumb, **Then** month view displays showing all entries for that month
2. **Given** month view is displayed, **When** viewing entries, **Then** each entry shows a preview (first 100 chars), word count, and tags
3. **Given** the user is in month view, **When** they click the year in the breadcrumb, **Then** year view displays a grid of 12 month cards
4. **Given** year view is displayed, **When** viewing month cards, **Then** each card shows entry count, total word count, and activity indicator
5. **Given** any overview view, **When** the user clicks an entry or month, **Then** they navigate to the corresponding day or month view

---

### User Story 8 - AI-Suggested Connections (Priority: P2)

As a user, I want to see AI-suggested connections to past entries and notes so I can discover patterns in my thinking and connect related ideas.

**Why this priority**: Connections transform a journal from isolated entries into a knowledge graph. AI assistance surfaces connections users might miss.

**Independent Test**: Can be tested by writing content, waiting for connections to load, and clicking a connection to navigate to the related content.

**Acceptance Scenarios**:

1. **Given** the user is writing, **When** they pause typing for 2 seconds, **Then** AI searches for related past entries and notes
2. **Given** connections are loading, **When** the panel is visible, **Then** it shows "Finding connections..." indicator
3. **Given** connections are found, **When** displayed, **Then** each shows source type (journal/note), date or title, and a relevant snippet
4. **Given** connections are displayed, **When** the user clicks one, **Then** the related content opens in a new tab
5. **Given** no connections are found, **When** viewing the panel, **Then** an appropriate empty state message is shown

---

### User Story 9 - Journal Templates (Priority: P3)

As a user, I want journal templates for different entry types (morning pages, reflection, gratitude) so I can quickly start entries with predefined prompts and structure.

**Why this priority**: Templates help establish writing habits and overcome blank page anxiety, but users can journal effectively without them.

**Independent Test**: Can be tested by selecting a template when creating an entry and verifying the template content appears in the editor.

**Acceptance Scenarios**:

1. **Given** the user opens a new journal entry, **When** they choose to use a template, **Then** template options are displayed
2. **Given** templates are shown, **When** the user selects one, **Then** the editor populates with the template's prompts and structure
3. **Given** a template is applied, **When** the user edits content, **Then** changes are saved as normal (template is just starting content)

---

### User Story 10 - Journaling Streak (Priority: P3)

As a user, I want to see streak information (consecutive days journaled) so I can track my consistency and stay motivated to maintain my journaling habit.

**Why this priority**: Gamification through streaks motivates consistent behavior, but the core journaling experience works without it.

**Independent Test**: Can be tested by journaling on consecutive days and verifying the streak count increments correctly.

**Acceptance Scenarios**:

1. **Given** the user has journaled on consecutive days, **When** they view the journal, **Then** current streak count is displayed
2. **Given** the user missed a day, **When** viewing streak info, **Then** the streak resets and shows the break
3. **Given** streak data exists, **When** displayed, **Then** longest streak is also shown for motivation

---

### User Story 11 - Journal Search (Priority: P3)

As a user, I want to search across all journal entries so I can find past reflections and specific content I've written.

**Why this priority**: Search becomes important as the journal grows, but users can browse via calendar and month views in the meantime.

**Independent Test**: Can be tested by searching for a term and verifying matching entries are returned with highlighted snippets.

**Acceptance Scenarios**:

1. **Given** the user opens journal search, **When** they type a query, **Then** matching entries are displayed as results
2. **Given** results are shown, **When** viewing them, **Then** each result shows the date, a snippet with highlighted matches
3. **Given** results are shown, **When** the user clicks a result, **Then** they navigate to that journal entry

---

### Edge Cases

- What happens when the user navigates to a very old date (e.g., 2020)? **The system loads or creates an entry for that date; no artificial date restrictions exist.**
- What happens on leap years (February 29)? **Date handling correctly supports Feb 29; entries can be created and accessed.**
- What happens with a 10,000-word journal entry? **Editor remains responsive; auto-save handles large content without UI stutter.**
- What happens when rapidly switching between days? **Navigation is debounced; race conditions are prevented; only the final selected date loads.**
- What happens when a journal file is edited externally (e.g., in VS Code)? **System detects file change on focus and offers to reload the content.**
- What happens when disk is full during auto-save? **Error is displayed; content remains in memory; user prompted to free space.**
- What happens when the AI connection search times out? **Graceful timeout with message; user can manually retry.**

## Requirements *(mandatory)*

### Functional Requirements

#### Entry Management
- **FR-001**: System MUST store each journal entry as a markdown file at `vault/journal/YYYY-MM-DD.md`
- **FR-002**: System MUST parse and display note content with YAML frontmatter metadata including id, date, created, modified, wordCount, characterCount, and tags
- **FR-003**: System MUST create entry file on first keystroke for a date (lazy creation)
- **FR-004**: System MUST save entries automatically 1 second after the user stops typing
- **FR-005**: System MUST use atomic writes (write to temp file, then rename) to prevent corruption
- **FR-006**: System MUST update wordCount, characterCount, and modified timestamp on each save
- **FR-007**: System MUST open today's date by default when journal is accessed

#### Calendar Widget
- **FR-008**: System MUST display current month by default with today highlighted
- **FR-009**: System MUST allow previous/next month navigation
- **FR-010**: System MUST navigate to selected day when user clicks a calendar date
- **FR-011**: System MUST provide "Today" button to jump to current date
- **FR-012**: System MUST display visual heatmap with 5 levels (0-4) based on character count
- **FR-013**: System MUST show future dates in muted styling but allow navigation to them

#### Heatmap Calculation
- **FR-014**: System MUST calculate activity level 0 for entries with 0 characters
- **FR-015**: System MUST calculate activity level 1 for entries with 1-100 characters
- **FR-016**: System MUST calculate activity level 2 for entries with 101-500 characters
- **FR-017**: System MUST calculate activity level 3 for entries with 501-1000 characters
- **FR-018**: System MUST calculate activity level 4 for entries with 1001+ characters

#### Month View
- **FR-019**: System MUST list all entries in selected month with preview, word count, and tags
- **FR-020**: System MUST navigate to day view when entry is clicked

#### Year View
- **FR-021**: System MUST display grid of 12 month cards showing entry count and total word count
- **FR-022**: System MUST navigate to month view when month card is clicked

#### Day Context Sidebar
- **FR-023**: System MUST display tasks for the viewed date from the task system
- **FR-024**: System MUST allow toggling task completion from sidebar (syncs with task system)
- **FR-025**: System MUST highlight overdue tasks with warning styling
- **FR-026**: System MUST display calendar events (initially mock data, integration later)

#### AI Connections Panel
- **FR-027**: System MUST search for related content 2 seconds after user stops typing
- **FR-028**: System MUST display top 3-5 semantic matches from past journal entries and notes
- **FR-029**: System MUST show source type, date/title, and relevant snippet for each connection
- **FR-030**: System MUST open connected content in new tab when clicked

#### Focus Mode
- **FR-031**: System MUST toggle focus mode via Cmd+\ keyboard shortcut
- **FR-032**: System MUST hide left sidebar when focus mode is active
- **FR-033**: System MUST hide right context sidebar when focus mode is active
- **FR-034**: System MUST narrow editor max-width for comfortable reading in focus mode
- **FR-035**: System MUST exit focus mode when Escape is pressed
- **FR-036**: System MUST persist focus mode preference in localStorage

#### Writing Experience
- **FR-037**: System MUST display word count and character count that update in real-time
- **FR-038**: System MUST support headings, bold, italic, lists, and code blocks in journal content
- **FR-039**: System MUST support [[wiki links]] to notes with autocomplete
- **FR-040**: System MUST support embedding images via drag-drop or paste

### Key Entities

- **JournalEntry**: A markdown file with YAML frontmatter containing id (journal-YYYY-MM-DD), date, created timestamp, modified timestamp, wordCount, characterCount, and tags array. Content stored as markdown below frontmatter.

- **JournalIndex**: A cached representation for fast querying. Contains id, date, path, createdAt, modifiedAt, wordCount, characterCount, mood (optional), tags, and computed activityLevel (0-4). Updated on each entry save.

- **HeatmapEntry**: Lightweight structure for calendar display containing date string, characterCount, and activity level (0-4).

- **AIConnection**: A semantic match result containing id, type (journal/note), date or title, preview snippet, relevance score, and matched keywords.

- **DayContext**: Aggregated data for the sidebar containing date, tasks for that day, calendar events, and overdue task count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can switch between journal days in under 100 milliseconds perceived response time
- **SC-002**: Calendar heatmap renders 365 days of activity data in under 50 milliseconds
- **SC-003**: AI connections panel updates with results within 2 seconds of typing pause
- **SC-004**: Focus mode toggle feels instant with no perceptible delay
- **SC-005**: Auto-save completes without any visible UI stutter during continuous typing
- **SC-006**: Zero data loss: all auto-saved content survives application crashes and unexpected closures
- **SC-007**: Journal entries with 10,000+ words remain editable without performance degradation
- **SC-008**: Users can navigate to any date within the past 5 years in under 200 milliseconds
- **SC-009**: 90% of users can navigate to a past journal entry within 10 seconds on first use
- **SC-010**: Journal index rebuilds from 2,000 entry files in under 2 seconds on startup

## Assumptions

- Journal entries are stored as markdown files in a local vault/journal directory (file-based)
- The existing JournalPage component provides the container/layout; this feature implements the data layer and integration
- Users have sufficient disk space for journal content and any embedded images
- A single user accesses the journal at a time (no real-time collaboration)
- The Electron main process handles file system operations; renderer process handles UI
- Task system integration uses the existing TasksProvider context from the codebase
- AI connections feature requires a semantic search backend (can be mocked initially)
- Calendar events integration will use mock data initially until system calendar integration is implemented
