# Feature Specification: Global Search System

**Feature Branch**: `007-global-search`
**Created**: 2025-12-18
**Status**: Draft
**Input**: User description: "Build the search system that enables finding content across notes, tasks, journal, and inbox"

## Overview

The Global Search System provides users with a unified search experience to find content across all data types in Memry (notes, tasks, journal entries, and inbox items). Users can quickly locate information using a command palette-style interface, with support for instant results, type filtering, fuzzy matching, and keyboard navigation.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unified Cross-Content Search (Priority: P1)

As a user, I want to search across all my content (notes, tasks, journal, inbox) from a single search bar so that I can quickly find information without knowing which type of content contains it.

**Why this priority**: This is the core value proposition of the feature. Without unified search, users must manually browse through each content type to find information, which is time-consuming and frustrating.

**Independent Test**: Can be fully tested by opening the search modal, typing a query that matches content in multiple types, and verifying results from all content types appear in grouped sections.

**Acceptance Scenarios**:

1. **Given** the user has content across notes, tasks, journal, and inbox, **When** they press Cmd+K, **Then** a search modal opens with an auto-focused input field
2. **Given** the search modal is open, **When** the user types a search term, **Then** results from all matching content types appear within 200ms
3. **Given** search results are displayed, **When** results exist in multiple content types, **Then** results are grouped by type with section headers showing result counts

---

### User Story 2 - Instant Search Results (Priority: P1)

As a user, I want to see search results as I type so that I can quickly refine my search and find content without waiting.

**Why this priority**: Real-time feedback is essential for a good search experience. Users expect instant results in modern applications.

**Independent Test**: Can be fully tested by typing progressively longer queries and verifying results update smoothly after each keystroke (with appropriate debouncing).

**Acceptance Scenarios**:

1. **Given** the search modal is open, **When** the user types a character, **Then** results begin appearing within 100ms
2. **Given** results are displayed, **When** the user continues typing, **Then** results update without flickering or layout jumps
3. **Given** the user is typing quickly, **When** multiple keystrokes occur within 150ms, **Then** the system debounces to avoid excessive searches

---

### User Story 3 - Navigate to Search Result (Priority: P1)

As a user, I want to click a search result and go directly to that item so that I can immediately access the content I found.

**Why this priority**: Search is only useful if users can act on results. Direct navigation completes the search workflow and delivers value.

**Independent Test**: Can be fully tested by searching for known content, clicking a result, and verifying the correct item opens in the appropriate view/tab.

**Acceptance Scenarios**:

1. **Given** search results are displayed, **When** the user clicks a note result, **Then** the note opens in a new tab
2. **Given** search results are displayed, **When** the user clicks a task result, **Then** the task detail view opens with the task selected
3. **Given** search results are displayed, **When** the user clicks a journal result, **Then** the journal view opens navigated to that entry's date
4. **Given** search results are displayed, **When** the user clicks an inbox item, **Then** the inbox view opens with that item highlighted

---

### User Story 4 - Filter Results by Content Type (Priority: P1)

As a user, I want to filter search results by type (notes, tasks, journal, inbox) so that I can narrow down results when I know what kind of content I'm looking for.

**Why this priority**: Type filtering dramatically improves search efficiency when users have a specific content type in mind.

**Independent Test**: Can be fully tested by searching for a term with results in multiple types, applying a type filter, and verifying only results of that type remain visible.

**Acceptance Scenarios**:

1. **Given** search results include multiple types, **When** the user selects "Notes" filter, **Then** only note results are displayed
2. **Given** a type filter is active, **When** the user clears the filter, **Then** all result types are displayed again
3. **Given** the search modal is open, **When** the user presses Cmd+1, **Then** results filter to Notes only (Cmd+2=Tasks, Cmd+3=Journal, Cmd+4=Inbox)

---

### User Story 5 - Fuzzy Search with Typo Tolerance (Priority: P1)

As a user, I want search to find results even when I make typos so that I don't miss relevant content due to spelling mistakes.

**Why this priority**: Users frequently mistype search terms. Fuzzy matching prevents frustration and ensures users find what they need.

**Independent Test**: Can be fully tested by intentionally misspelling search terms and verifying correct results still appear.

**Acceptance Scenarios**:

1. **Given** a note titled "Team Meeting Notes", **When** the user searches "meetng", **Then** the note appears in results (typo tolerance)
2. **Given** a task with description "quarterly report", **When** the user searches "quaterly", **Then** the task appears in results
3. **Given** fuzzy matching is applied, **When** results are ranked, **Then** exact matches appear before fuzzy matches

---

### User Story 6 - Keyboard Navigation (Priority: P2)

As a user, I want to navigate search results using my keyboard so that I can efficiently select results without using a mouse.

**Why this priority**: Power users expect keyboard-driven workflows. This significantly improves productivity for frequent searchers.

**Independent Test**: Can be fully tested by opening search, typing a query, and navigating/selecting results using only keyboard.

**Acceptance Scenarios**:

1. **Given** search results are displayed, **When** the user presses Arrow Down, **Then** the next result is highlighted
2. **Given** a result is highlighted, **When** the user presses Enter, **Then** that result opens (same as clicking)
3. **Given** multiple result sections exist, **When** the user presses Tab, **Then** focus moves to the next section
4. **Given** the search modal is open, **When** the user presses Escape, **Then** the modal closes
5. **Given** the last result is selected, **When** the user presses Arrow Down, **Then** selection wraps to the first result

---

### User Story 7 - Highlighted Matches in Results (Priority: P2)

As a user, I want to see where my search terms match in results so that I can quickly verify relevance and understand context.

**Why this priority**: Visual highlighting helps users understand why a result matched and quickly scan for relevance.

**Independent Test**: Can be fully tested by searching for a term and verifying the matching text is visually highlighted in result snippets.

**Acceptance Scenarios**:

1. **Given** a search matches content, **When** results are displayed, **Then** matching text is visually highlighted in the snippet
2. **Given** a result has multiple matches, **When** the snippet is displayed, **Then** context around matches is shown with "..." separators
3. **Given** a match occurs, **When** the snippet is generated, **Then** approximately 50 characters of context appear before and after the match

---

### User Story 8 - Recent Searches (Priority: P2)

As a user, I want my recent searches saved so that I can quickly repeat previous searches without retyping.

**Why this priority**: Users often search for similar things. Recent search history improves efficiency for repeated workflows.

**Independent Test**: Can be fully tested by performing searches, closing the modal, reopening it, and verifying recent searches appear for quick selection.

**Acceptance Scenarios**:

1. **Given** the search modal opens with empty input, **When** the user has previous searches, **Then** recent searches are displayed
2. **Given** recent searches are displayed, **When** the user clicks one, **Then** that search executes immediately
3. **Given** the user performs searches, **When** more than 20 unique searches exist, **Then** only the 20 most recent are retained
4. **Given** recent searches exist, **When** the user clicks "Clear history", **Then** all recent searches are removed
5. **Given** the user closes and reopens the application, **When** the search modal opens, **Then** recent searches persist

---

### User Story 9 - Search by Tags (Priority: P2)

As a user, I want to search by tags so that I can find all content with specific categorizations.

**Why this priority**: Tags are a primary organizational mechanism. Searching by tag is a natural and efficient way to find related content.

**Independent Test**: Can be fully tested by filtering results to a specific tag and verifying only tagged content appears.

**Acceptance Scenarios**:

1. **Given** the filter panel is open, **When** the user selects a tag from the tag filter, **Then** only results with that tag are displayed
2. **Given** multiple tags are selected, **When** results are filtered, **Then** results matching ANY selected tag appear (OR logic)
3. **Given** the tag filter is open, **When** the user types, **Then** tags are filtered with autocomplete suggestions

---

### User Story 10 - Date Range Filtering (Priority: P2)

As a user, I want to search within specific date ranges so that I can find content from particular time periods.

**Why this priority**: Time-based filtering helps users locate content when they remember approximately when they created it.

**Independent Test**: Can be fully tested by applying a date range filter and verifying only content from that period appears.

**Acceptance Scenarios**:

1. **Given** the filter panel is open, **When** the user selects "This Week" preset, **Then** only results from the current week are displayed
2. **Given** the filter panel is open, **When** the user selects custom date range, **Then** results are filtered to that exact range
3. **Given** date presets are available, **When** displayed, **Then** options include: Today, This Week, This Month, Custom
4. **Given** a date filter is active, **When** combined with text search, **Then** both filters apply (AND logic)

---

### User Story 11 - Prefix and Phrase Search (Priority: P3)

As a user, I want to search using partial words and exact phrases so that I have flexible search options.

**Why this priority**: Advanced users benefit from precise search control. Prefix search helps when unsure of full terms.

**Independent Test**: Can be fully tested by searching with wildcard prefixes and quoted phrases, verifying correct results.

**Acceptance Scenarios**:

1. **Given** a note contains "meeting", **When** the user searches "meet", **Then** the note appears in results (prefix match)
2. **Given** notes contain "project alpha" and "alpha project", **When** the user searches "project alpha" in quotes, **Then** only exact phrase matches appear
3. **Given** case-insensitive search is enabled, **When** the user searches "MEETING", **Then** results with "meeting", "Meeting", "MEETING" all appear

---

### User Story 12 - Filter by Project/Folder (Priority: P3)

As a user, I want to search within specific projects or folders so that I can narrow results to particular areas of my workspace.

**Why this priority**: Users with many projects/folders benefit from scoped search to reduce noise.

**Independent Test**: Can be fully tested by selecting a project/folder filter and verifying only content from that location appears.

**Acceptance Scenarios**:

1. **Given** the filter panel is open, **When** the user selects a project, **Then** only tasks from that project appear
2. **Given** the filter panel is open, **When** the user selects a folder, **Then** only notes from that folder appear
3. **Given** project/folder filters are active, **When** combined with other filters, **Then** all filters apply together (AND logic)

---

### Edge Cases

- **Empty query**: When search input is empty, recent searches are displayed instead of results
- **No results**: When no content matches, a helpful message with suggestions is displayed
- **Very long query**: Queries exceeding 500 characters are truncated with user notification
- **Special characters**: Search handles special characters (quotes, brackets, symbols) without breaking
- **Large dataset**: Search remains responsive with 10,000+ items across all content types
- **Offline mode**: Search works fully offline since all data is local
- **Concurrent edits**: Search index updates when content is modified without blocking the UI

## Requirements *(mandatory)*

### Functional Requirements

#### Search Invocation
- **FR-001**: System MUST provide a global keyboard shortcut (Cmd+K on macOS, Ctrl+K on Windows/Linux) to open the search modal from anywhere in the application
- **FR-002**: System MUST auto-focus the search input when the modal opens
- **FR-003**: System MUST close the search modal when the user presses Escape or clicks outside

#### Search Execution
- **FR-004**: System MUST search across all content types: notes (title and content), tasks (title and description), journal entries (content), and inbox items (title and content)
- **FR-005**: System MUST support case-insensitive text matching
- **FR-006**: System MUST support prefix matching (partial word matches at the beginning)
- **FR-007**: System MUST support fuzzy matching with 70% similarity threshold for typo tolerance
- **FR-008**: System MUST support exact phrase matching when query is enclosed in quotes
- **FR-009**: System MUST debounce search execution by 150ms while the user types

#### Results Display
- **FR-010**: System MUST group search results by content type with section headers
- **FR-011**: System MUST display result count for each content type section
- **FR-012**: System MUST display a maximum of 10 results per section initially
- **FR-013**: System MUST provide a "View all" link to expand sections with more results
- **FR-014**: System MUST highlight matching text in result snippets
- **FR-015**: System MUST display contextual information for each result type:
  - Notes: title, snippet, modification date
  - Tasks: title, project name, due date, completion status
  - Journal: date, snippet
  - Inbox: title, item type, snippet

#### Filtering
- **FR-016**: System MUST provide type filter checkboxes (Notes, Tasks, Journal, Inbox)
- **FR-017**: System MUST provide tag filter with autocomplete
- **FR-018**: System MUST provide date range filter with presets (Today, This Week, This Month, Custom)
- **FR-019**: System MUST provide project filter for task results
- **FR-020**: System MUST provide folder filter for note results
- **FR-021**: System MUST support combining multiple filters using AND logic
- **FR-022**: System MUST provide a "Clear all filters" action

#### Navigation & Interaction
- **FR-023**: System MUST navigate to the source content when a result is clicked or selected with Enter
- **FR-024**: System MUST support keyboard navigation with Arrow Up/Down for result selection
- **FR-025**: System MUST support Tab key to move focus between result sections
- **FR-026**: System MUST provide keyboard shortcuts Cmd+1 through Cmd+4 for quick type filtering
- **FR-027**: System MUST wrap selection at list boundaries (last to first, first to last)
- **FR-028**: System MUST maintain visible focus indicator on selected result

#### Recent Searches
- **FR-029**: System MUST store the 20 most recent unique search queries
- **FR-030**: System MUST display recent searches when the search input is empty
- **FR-031**: System MUST execute the search when a recent search item is clicked
- **FR-032**: System MUST persist recent searches across application sessions
- **FR-033**: System MUST provide ability to clear search history

#### Results Ranking
- **FR-034**: System MUST rank results by relevance score
- **FR-035**: System MUST prioritize exact matches over fuzzy matches
- **FR-036**: System MUST support sorting by relevance (default), date, or title

### Key Entities

- **SearchResult**: Represents a single search match containing: unique identifier, content type, title, snippet with highlighted matches, relevance score, match positions, type-specific metadata (path, project, due date, etc.), and timestamps
- **SearchQuery**: Represents a search request containing: query text, type filters, tag filters, date range, project/folder filters, pagination options, and sort preferences
- **RecentSearch**: Represents a saved search containing: query text, execution timestamp, and result count
- **SearchIndex**: The indexed representation of searchable content, maintained in sync with source data

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can find any content item within 3 interactions (open search, type query, click result)
- **SC-002**: First search results appear within 100ms of user stopping typing
- **SC-003**: Complete search results load within 200ms for datasets up to 10,000 items
- **SC-004**: 95% of intended searches return the target content in the top 5 results
- **SC-005**: Users can complete a search-and-navigate workflow in under 5 seconds
- **SC-006**: Search modal opens within 50ms of keyboard shortcut activation
- **SC-007**: Fuzzy matching correctly identifies 90% of single-character typos
- **SC-008**: Users can filter results to a specific type with a single keyboard shortcut
- **SC-009**: Recent searches reduce repeat query typing by surfacing 80% of recurring searches
- **SC-010**: Search works offline with 100% feature parity (no network dependency)

## Assumptions

- All content (notes, tasks, journal, inbox) is stored locally and accessible for indexing
- The existing tab system can receive navigation requests to open specific content items
- Tags are already implemented and associated with content across types
- Projects and folders are existing organizational structures that can be queried
- The application already has an established keyboard shortcut system that can be extended
- Content modification events can trigger index updates
