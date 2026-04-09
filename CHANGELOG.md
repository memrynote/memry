# Changelog

All notable changes to memry are documented here.
Format: weekly entries grouped by feature area.

---

## 2026-04-09 — Inbox Domain Extraction (Phase 3)

### Added
- Add `@memry/domain-inbox` package with canonical inbox entities, commands, queries, events, and job record types
- Add `domain.ts` desktop adapter layer for inbox domain commands with transactional item+tag insertion

### Changed
- Move capture, filing, snooze, retry, and suggestion logic from IPC handlers into inbox domain surface
- Reduce `inbox-handlers.ts` from 850+ LOC to transport-only adapter with Zod validation and error handling
- Simplify `TasksProvider` to pure context shell receiving data via props
- Inline `TasksAppBoundary` render-prop logic directly into `App.tsx`
- Restore proxy forwarder traps (has, ownKeys, getOwnPropertyDescriptor) removed in prior refactor

### Fixed
- Re-add Zod schema validation at IPC trust boundary dropped during domain extraction
- Re-add `withErrorHandler` wrapper on all inbox IPC handlers to prevent unhandled rejections
- Add missing `setProjects` to `handleDragEnd` useCallback dependency array
- Add missing `void` prefix on floating `tasksService.reorder()` promise

---

## 2026-04-08 — Marquee Selection Indent/Outdent

### Added
- Add Tab/Shift+Tab indent/outdent support to marquee selections

---

## 2026-04-07 — Security Fixes

### Fixed
- Patch 4 critical Electron RCE CVEs and HIGH transitive CVEs
- Narrow refresh token rotation grace window to 10s
- Harden /recovery against account enumeration timing leak

---

## 2026-04-07 — Inline Subtasks in Notes

### Added
- Support inline subtasks within notes: add parentTaskId, indented rendering, serialization, and recursive normalization
- Auto-detect indented checkboxes under task blocks as subtasks
- Promote subtask to standalone task when un-indented (Shift+Tab)
- Task intent analysis utility to detect checkbox and task-block operations
- Debounced auto-promote and auto-demote handlers for keyboard navigation

### Fixed
- Delete taskBlock on Backspace in empty title; prevent cascade deletion
- Preserve nested children when converting checkListItem to taskBlock
- Sanitize theme values to prevent corruption
- Fix type narrowing for taskBlock check in normalizeTaskBlocks

---

## 2026-04-07 — Tasks Tab State Persistence

### Added
- Persist tasks tab view state (active view, internal tab, selected project, detail drawer) across tab navigation using the existing tab viewState mechanism

---

## 2026-04-07 — Remove Home Tab

### Removed
- Remove unused Home tab from sidebar navigation, tab types, content routing, and icon mappings
- Remove SidebarHome SVG icon component
- Renumber sidebar keyboard shortcuts (Journal → ⌘⌥2, Tasks → ⌘⌥3)

---

## 2026-04-07 — Inline Task Blocks

### Added
- Add custom task block for BlockNote editor with live DB sync and inline editing
- Add `[] ` bracket shortcut and `/task` slash command to create task blocks
- Add right-click context menu to promote checkboxes to linked tasks
- Add quick-add syntax parsing in task blocks (project, priority, due date)
- Add Enter key continuation: create new task block after typing title
- Add Enter on empty task block to exit to paragraph with cursor focus
- Add Escape key to exit task editing without creating new block
- Add draft task block detection in editor onChange for DB task creation
- Add task block markdown serialization with `{task:id}` suffix round-trip

### Fixed
- Fix focus jumping to previous task block when pressing Enter before async task creation completes
- Fix sync effect reverting title to stale DB value during save (hold syncingRef across async boundary)
- Fix paragraph conversion from task block not receiving browser focus (add editor.focus() after cursor placement)
- Fix task deletion scan race condition with debounced block scanning

### Changed
- Add `renderTitle` prop to TaskRow for inline title editing in task blocks

---

## 2026-04-06 — Vertical Sidebar Navigation

### Changed
- Replace horizontal nav with vertical sidebar nav using shadcn SidebarMenu primitives
- Move navigation (Inbox, Journal, Tasks) from sidebar header to sidebar content area
- Simplify SidebarHeaderContent to only render traffic lights and vault switcher

---

## 2026-04-06 — Split View Polish

### Fixed
- Hide sidebar collapse icon in split view panes (only show in primary/leftmost pane)

---

## 2026-04-06 — Linked Task Navigation Fix

### Fixed
- Fix linked task click in note page to open task page with project filter, "all" section, detail panel, and row highlight

---

## 2026-04-05 — Inbox Detail Panel Polish

### Added
- Show folder emoji/icon in filing dropdown and selected folder display
- Show note emoji/icon for AI-suggested notes in filing section
- Surface `emoji` field from note cache through suggestions pipeline

### Fixed
- Fix checkbox and text vertical misalignment in note task lists

### Changed
- Stack "File to" and "Tags" vertically instead of side by side
- Narrow inbox detail panel from 460px to 380px to match task detail drawer
- Align inbox and task detail panels to tab bar bottom edge (top-[37px])
- Simplify folder dropdown: remove confidence percentages and navigation hints
- Simplify link preview layout with extracted PreviewImage component
- Remove tag usage count from tag autocomplete suggestions

---

## 2026-04-04 — Inbox Create Folder

### Added
- Add inline folder creation to inbox filing dropdown with search-to-create flow
- Add subfolder hint in folder search input for nested path creation

---

## 2026-04-04 — Link Embeds and Mentions

### Added
- Add YouTube embed block with inline player and markdown round-trip
- Add link mention inline content for BlockNote editor
- Add paste link menu with URL, mention, and embed options
- Add YouTube player to inbox link preview
- Add Reddit JSON API metadata extraction with bot detection bypass

### Changed
- Use mention and embed format for inbox link filing
- Update Content Security Policy for YouTube iframe embeds

---

## 2026-04-04 — Voice Transcription

### Added
- Add local Whisper Small transcription via whisper-node worker thread
- Add OpenAI BYOK voice transcription with OS keychain storage
- Add voice provider selector (local / OpenAI) in AI settings
- Add voice model download UI with progress bar and status badges
- Add WebM-to-WAV conversion for local transcription compatibility
- Add voice recording readiness check before mic activation
- Add quick-capture-to-settings deep link for unconfigured providers
- Add `settings:openSection` event for cross-window settings navigation

### Changed
- Replace env-var OpenAI key with per-user keychain secret for voice
- Refactor transcription module to route by provider setting
- Extract failure-result helper to reduce duplication in transcription error paths

---

## 2026-04-03 — Dead Code Cleanup

### Changed
- Remove 6 unused files and 11 unused exports across monorepo (~762 lines)
- Remove superseded per-type reminder schemas in favor of unified `CreateReminderSchema`
- Un-export internal-only `ReminderTargetTypeSchema` and `ReminderStatusSchema`

---

## 2026-04-03 — Clean Code Audit

### Changed
- Split task-utils.ts (1,349 LOC, 60 functions) into 5 focused modules: date-utils, formatting, status-helpers, view-helpers, filters
- Split queries/notes.ts (1,595 LOC, 78 functions) into 7 sub-modules: CRUD, tags, journal, properties, snapshots, links, helpers
- Decompose ContentArea.tsx (1,482 → 331 lines) into 6 single-responsibility hooks
- Decompose use-journal.ts (1,081 lines) into 8 focused modules with shared IPC invalidation hook
- Split use-inbox.ts (993 lines) into query, mutation, and operation modules
- Decompose notes-tree.tsx (2,089 → 542 lines) into 7 modules with shared utilities across both tree variants
- Add withDb/withErrorHandler HOFs to eliminate 112 repetitive try/catch blocks across 14 IPC handler files
- Replace raw console.* calls in sync-server with structured createLogger utility
- Add type-safe DB mock factories to reduce as-any casts in sync test files

---

## 2026-04-03 — Sidebar Chevron Always Visible

### Added
- Add always-visible expand/collapse chevron to folder rows in sidebar tree

### Changed
- Remove hover-dependent show/hide pattern for folder chevrons
- Simplify tree node expand animation by removing slide transition

---

## 2026-04-03 — Tag Sort Picker

### Changed
- Replace DropdownMenu with Picker component for sidebar tag sort control
- Shorten sort labels to compact single-line names (Most used, Least used, A → Z, Z → A)
- Add leading icons to all sort options for visual clarity

---

## 2026-04-02 — Journal Redesign and Task Improvements

### Added
- Add resizable journal page with sidebar, day panel, calendar, and task list
- Add hierarchical `#parent/child` tags with prefix queries, cascade operations, tree sidebar, and autocomplete
- Add task deletion from drawer and deep-link from journal
- Add focusAtEnd click-to-focus behavior and auto-open for select-type property pickers

### Fixed
- Fix find-in-page to scroll to match on search and navigation
- Fix task status rollback from completed state
- Fix graph panel overflow and settings shortcut capture in input fields
- Fix Today button visibility regardless of current calendar month
- Fix vault indexer and editor plugins for hierarchical tags

### Changed
- Redesign journal day view with ghost affordance layout and tab bar toggle
- Convert right panels to fixed overlays with dynamic day panel width
- Remove AI Agent panel and all related code
- Wire auto-focus into note and info-section layout

---

## 2026-03-29 — Settings Config.json Migration

### Changed
- Move portable user preferences (theme, font, editor width) from SQLite to config.json as source of truth
- Propagate synced remote settings to config.json and broadcast CHANGED events to renderer (fixes sync gap)
- Populate SQLite settings cache from config.json on vault open with one-time migration for old vaults

---

## 2026-03-29 — Note Page

### Added
- Redesign note page header with compact Paper-inspired layout
- Add full-width toggle for note pages
- Add hover preview cards for wiki-links and note tabs
- Reorganize nav with horizontal sidebar icons and new-tab menu
- Add context-aware note/folder creation with tree expand/collapse persistence
- Add callout block with Obsidian-style markdown serialization
- Add code block syntax highlighting with language support
- Preserve empty lines across markdown round-trips
- Add select, multiselect, and status property editors with settings management
- Add backlinks section to journal page with collapsible multi-context cards
- Add inline hash-tag editing plugin with digit-starting tag support
- Add Picker compound component
- Add ghost affordance row for note metadata

### Fixed
- Persist emoji in tab state for icon restoration on reopen
- Omit current year in compact inbox date format
- Quit app on all windows closed regardless of platform

### Changed
- Migrate popups, menus, and form controls to Picker primitive (tags, properties, tasks, reminders, inbox filter, vault switcher, overflow menu)
- Simplify NoteTitle to display-only emoji
- Remove Instrument Serif font
- Widen note layout with active heading tracking and viewState merge on tab reopen

---

## 2026-03-25 — Settings Modal & Sidebar Polish

### Added
- Add settings modal dialog with `SettingsModalProvider` context, replacing settings-as-tab pattern

### Changed
- Remove `settings` tab type from TabType union and singleton list
- Replace tint-mixed sidebar accent with neutral background tones across all themes
- Switch active sidebar indicators from `bg-sidebar-accent-foreground` to `bg-tint`
- Tone dark mode foreground from `#e8e6e1` to `#bcbab6` for reduced glare
- Unify sidebar icon color with `text-sidebar-foreground` on menu buttons
- Restyle settings nav items with `bg-sidebar-accent` instead of `bg-accent`

---

## 2026-03-25 — Desktop Polish

### Added
- Add inbox redesign with toolbar, filters, triage mode, link previews, and waveform visualizer
- Add embedded tweet rendering with TweetCard component
- Add reminder detail view with content routing
- Add live URL title extraction and bot-page-title detection
- Auto-title voice memos from first transcribed sentence
- Add folder icon picker and NoteIconDisplay across tree and sidebar
- Add HugeIcons rendering infrastructure
- Sync accent color across devices with tint CSS variables
- Add compact capture mode
- Add PageToolbar and Pill UI primitives
- Add Cmd+Z undo for all task CRUD and bulk operations
- Add WCAG 2.1 AA accessibility pass — keyboard nav, ARIA, focus indicators
- Add account section, recovery key dialog, shortcuts section, and capture shortcut to settings
- Add Gelasio, Geist, and Inter font families

### Fixed
- Fix inbox filing auto-link and metascraper field mapping
- Fix graph crash on null node data
- Fix tag count casting and prune orphaned definitions
- Fix project ID resolution before creating onboarding task

### Changed
- Extract shared settings primitives and redesign all settings pages
- Replace custom toast notifications with Sonner
- Remove non-Twitter platform support and simplify social URL parsing
- Simplify sidebar with NoteIconDisplay and compact task count
- Extract DetailHeader and simplify reminder TypeIcon
- Migrate task design tokens and wire undoable task actions

### Performance
- Parallelize vault open with window creation to reduce cold-start time
- Optimize startup I/O and large-vault indexing speed

---

## 2026-03-19 — Tasks Refinement

### Added
- Add kanban board view with priority and status column drops
- Add cross-section parent task reordering via drag-drop
- Add inline status and priority popover editors in task rows
- Add first-run onboarding wizard
- Add tags, linkedNoteIds, and junction data to task sync payloads
- Add status-based grouping and sort field for tasks
- Add inline done sections with group-by (replace Done tab)
- Add starred saved filters with Cmd+S shortcut
- Add day-first date parsing and project names in quick-add input
- Add repeat indicator to task row variants
- Add shared task icon library (StatusIcon, PriorityIcon, StatusCircle, SectionDivider)
- Add shared UI primitives and extended badge variants
- Migrate icon library from lucide-react to Hugeicons
- Add social inbox filing and tweet syndication
- Hide project badge in single-project view

### Fixed
- Fix kanban cross-column detection to use pointer position
- Exclude subtasks from completed-task lists and preserve subtaskIds on complete
- Fix subtask visibility in Today, Week, and Upcoming views

### Changed
- Redesign task rows with Linear-style status indicators and compact layout
- Replace task detail panel with slide-out drawer
- Redesign kanban cards with updated badge layout
- Redesign date picker calendar with extracted DatePickerContent
- Redesign sidebar with custom nav icons and user profile
- Redesign tab bar from browser-style to underline indicators
- Extract filter panels and interactive badges into standalone components
- Simplify virtual list rendering for flat and grouped modes
- Remove calendar heatmap from journal
- Migrate hardcoded task colors to CSS custom properties
- Overhaul seed data with richer demo projects
- Separate filter and sort persistence keys
- Extract applyTaskUpdate for simplified derived state

---

## 2026-03-14 — White Theme, Tag Sync Fixes, Sidebar Polish

### Added
- Add tag search and sort (by count/name) to sidebar tag section with localStorage persistence
- Add `--graph-label-color` semantic token for theme-aware graph labels
- Add `tagsOverride` parameter to `syncNoteToCache` for authoritative tag syncing
- Add pasted text tag extraction to `extractInlineTags` (not just hashTag nodes)

### Fixed
- Fix tag removal from editor not updating frontmatter and UI
- Fix pasted tags not being highlighted or synced to frontmatter
- Fix graph colors not updating on theme switch (dimmed nodes, edges, labels)
- Fix graph labels defaulting to invisible color in dark mode

### Changed
- Redesign sidebar quick actions as horizontal search bar + compact new-note button
- Replace sidebar accordion mount/unmount with CSS grid-rows transition (no remount)
- Remove tree provider entry animation (opacity/translate) for instant render
- Neutralize dark mode palette from warm (#1c1b19) to neutral (#191919)
- Refine white theme sidebar background (#fbfbfa → #f9f8f7)
- Default graph labels to hidden (`showLabels: false`)

---

## 2026-03-13 — Inline AI Editing, Editor Polish, Domain Migration

### Added
- Add BlockNote xl-ai inline editing with local HTTP chat server (Ollama, OpenAI, Anthropic)
- Add AI commands: rewrite, summarize, expand, simplify, fix grammar, continue writing, translate
- Add custom AI menu with selection-aware command sets and Cmd+J shortcut
- Add AI inline settings UI with provider/model selection, API key management, and connection test
- Add graceful SIGINT/SIGTERM shutdown with EIO-safe console transport

### Fixed
- Fix Cmd+W to close window when only inbox tab remains (matching native macOS behavior)

### Changed
- Migrate CSP connect-src domain from memry.app to memrynote.com
- Upgrade BlockNote from 0.45.0 to 0.47.1
- Increase editor bottom padding to 30vh for scroll breathing room
- Allow http://127.0.0.1:* in CSP for local AI chat server

---

## 2026-03-09 → 2026-03-12 — Graph View, Editor Tags, Design System

### Added
- Add interactive knowledge graph view with Sigma.js and Graphology
- Add tags as first-class graph nodes with entity-tag edges
- Add inline hash-tag system in editor with space-to-complete
- Add clickable hash-tag pills with live color sync
- Add Instrument Serif and JetBrains Mono font families
- Add sticky outline panel with pin-on-click and smooth fade-out
- Add synchronous theme preload to eliminate flash on startup

### Fixed
- Fix graph node overlapping by spreading nodes and reducing sizes
- Fix pre-compute force layout so graph opens without animation jitter
- Fix UI state reset when switching vaults

### Changed
- Redesign sidebar with warm editorial palette
- Redesign note title with editorial typography
- Redesign backlinks as horizontal compact cards
- Convert graph controls to collapsible gear-icon drawer
- Move action icons to layout top-right with hover outline
- Aggregate task tags in sidebar tag counts
- Compact sidebar header and vault switcher spacing

---

## 2026-03-02 → 2026-03-08 — Global Search, Inbox Redesign, Monorepo (#97, #98, #99)

### Added
- Add FTS5 search backend with fuzzy fallback and Cmd+K command palette (#97)
- Add settings system with decomposed sections, tag management, and preferences (#98)
- Add triage mode with AI note suggestions for inbox (#99)
- Add inbox health metrics with ArcGauge and AgeStrata visualizations (#99)
- Add duplicate detection for text and URL captures (#99)
- Add undo toasts, processing streak badge, and triage celebration (#99)
- Add captureSource tracking to inbox items (#99)
- Add overdue tier styling and collapsible sections to tasks view
- Add This Week accordion to Today view
- Add token highlight overlay to quick-add input
- Add convert-to-task IPC and note suggestion types

### Fixed
- Fix voice recorder autoStart and inbox transcription refresh
- Fix link filing for folder, note, and multi-note targets
- Fix date serialization to use local-time and prevent off-by-one day shift
- Fix async CRDT close destroying reopened docs

### Changed
- Migrate to turborepo monorepo structure
- Bump Node to 24
- Remove Upcoming tab from task navigation
- Replace project sidebar with dropdown selector
- Replace shadcn Calendar with custom DatePickerCalendar
- Split inbox.tsx monolith into focused modules
- Move appearance settings to dedicated Appearance section
- Remove internal docs, specs, and agent config from tracking

---

## 2026-02-23 → 2026-03-01 — Sync E2EE Phases 8–15, Security Hardening (#95)

### Added
- Add field-level merge logic for tasks and projects with per-field vector clocks
- Add offline clock management for deviceless editing
- Add attachment upload/download service with chunked transfer and thumbnails
- Add file drop handling in sidebar via getFileDropPaths API
- Add sync status UI to sidebar and settings panel
- Add sync activity history panel
- Add local-only flag to exclude notes from sync
- Add worker thread for off-main-thread crypto
- Add device management endpoints and device list UI
- Add key rotation wizard with vault key re-wrapping
- Add graceful sync shutdown with drain-before-quit
- Add CryptoError class with diagnostic error codes
- Add corrupt data detection and re-fetch recovery
- Add CRDT doc compaction and payload size guard
- Add device revocation warning dialog
- Add storage quota handling and StorageUsageBar component
- Add SAS verification codes for device linking
- Add TLS certificate pinning and CSP headers
- Add HMAC-SHA256 for OTP hashing (replacing unsalted SHA-256)
- Add tombstone GC and orphaned blob cleanup on server
- Add X-App-Version header for outdated client rejection
- Add alarm-cycle revocation fallback for WebSocket connections

### Fixed
- Fix queue dequeue to atomically mark items in-flight
- Fix binary file handling in applyUpsert (no .md writes for binaries)
- Fix token rotation UNIQUE collision with retry
- Fix timing oracle in /recovery endpoint
- Fix body size limit enforcement on chunked transfer requests
- Fix async close preventing reopened CRDT doc destruction
- Zero newVaultKey and newMasterKey after key rotation

### Changed
- Extract SyncEngine God Object (2086 LOC) into focused modules
- Harden engine with mutex, key cleanup, bounded retry, and pull validation
- Streamline session management and logout process
- Decouple auth from sync for instant post-auth redirect

### Performance
- Parallelize CRDT snapshots and prefetch pull pages
- Cache device public keys during pull cycle
- Skip push when sync queue is empty

---

## 2026-02-16 → 2026-02-22 — Sync E2EE Phases 3–7, CRDT Architecture

### Added
- Add hybrid CRDT sync architecture with Yjs for notes and journals
- Add CRDT incremental update endpoints on server
- Add Yjs collaboration to BlockNote editor with initial sync progress
- Add text-based ping/pong keepalive to WebSocket
- Add project sync handler, service, and schema
- Add X25519 ECDH, linking key derivation, and master key encryption
- Add device linking service with QR code, approval dialog, and setup wizard
- Add recovery endpoint with anti-enumeration protection
- Add recovery phrase input with stepped progress UI
- Add tag definition sync type and pin state helpers
- Add flush-on-quit protocol to prevent data loss on shutdown
- Add CRDT snapshot creation during writeback

### Fixed
- Fix server security: remove DELETE bypass, rate-limit endpoints, check device revocation
- Fix dead contentHash removal, crypto version validation
- Fix sync engine decryption error handling and manifest integrity checks
- Fix signingPublicKey NOT NULL constraint on sync_devices
- Fix deletedAt inclusion in signature verification payload
- Fix WebSocket alarm send+close error handling
- Fix signing key mismatch with self-heal instead of state wipe
- Fix sidebar note list invalidation on notes:updated event

### Changed
- Extract per-type item handler strategy pattern for sync
- Extract ContentSyncService base class from note/journal sync
- Add periodic pull interval with skip logging
- Streamline pull and push coordination logic

---

## 2026-02-09 → 2026-02-15 — Sync E2EE Phases 1–2, Foundation (#95)

### Added
- Add sync/E2EE dependencies (libsodium, cborg, keytar)
- Scaffold sync and crypto directory structure
- Add D1 database schema with 14 tables for sync infrastructure
- Add local Drizzle sync tables for device state and queue tracking
- Add shared Zod contracts for auth, blob, linking, and CBOR ordering
- Add crypto module with XChaCha20, Ed25519, BIP39, and keychain
- Scaffold Cloudflare Workers sync server with D1 and R2 bindings
- Wire sync/crypto IPC handlers, preload bridge, and deep link protocol
- Add email/password auth with OTP verification
- Add sign-in/sign-up forms with account setup wizard
- Add settings panel integration for sync configuration
- Add sync engine with push/pull loop, retry, and WebSocket
- Add CSRF protection to OAuth deep link callback
- Add contract sync automation to prevent client/server drift

### Fixed
- Fix server security: rate limiter schema, cleanup timestamps, JWT type validation
- Fix crypto security: proper KDF derivation, buffer zeroing on exceptions
- Fix 4xx client error retry (skip all except 429)
- Fix clipboard promise rejection in recovery phrase cleanup

### Changed
- Split ipc-sync.ts omnibus into domain-specific contract files
- Replace preload duplicate type declarations with shared contract imports

---

## 2026-01-26 → 2026-02-08 — Planning & Specification

_Sync E2EE specification and architecture planning. No code changes._

---

## 2026-01-19 → 2026-01-25 — Sync Specification

### Added
- Add passwordless email OTP authentication specification
- Add Ed25519 device-level signing specification
- Add CRDT architecture plan (Yjs, IPC-backed provider, y-leveldb)
- Add token refresh and secure memory cleanup specifications
- Add Google OAuth integration specification

### Changed
- Transition sync spec from y-indexeddb to y-leveldb
- Refine OAuth integration to support only Google authentication

---

## 2026-01-12 → 2026-01-18 — Journal Polish, Properties, Sync Spec

### Added
- Add journal settings for sidebar visibility and stats footer
- Add settings keyboard shortcut
- Add property renaming functionality
- Add property drag-and-drop reordering
- Add tag definitions table in database schema
- Add binary file sync architecture specification
- Add sync specification with key derivation, encryption, and rate limiting

### Fixed
- Fix journal entry handling for serialized frontmatter properties

### Changed
- Unify properties API for notes and journal entries
- Integrate SidebarDrillDownProvider for folder view components

---

## 2026-01-05 → 2026-01-11 — Folder View PR, Platform Polish (#94)

### Added
- Add FTS and embedding queue systems for batched updates
- Add WikiLink resolution for note and file navigation
- Add inbox video file support
- Add note reordering and position management
- Add archived items and filing history features
- Add advanced search with operators and filters

### Fixed
- Fix tab component re-renders with memoization and useCallback
- Fix FTS queue update error handling

### Changed
- Merge PR #94: Folder View
- Consolidate notes hooks into use-notes-query
- Replace useTabs with useTabActions across components
- Upgrade sharp to 0.34.5
- Remove electron-devtools-installer (use session.extensions API)

### Performance
- Optimize TabContent and sidebar navigation rendering
- Add batch tag queries for note retrieval

---

## 2025-12-29 → 2026-01-04 — Inbox Completion, Folder View, Test Infrastructure

### Added
- Add social media post extraction with dedicated social card component
- Add AI filing suggestions with feedback tracking
- Add sqlite-vec for local embedding vector similarity search
- Add reminder system for notes, journals, and highlights
- Add native context menu support for tab actions
- Add reveal-in-sidebar functionality for notes
- Add folder view with table layout, column management, and named views
- Add column resizing, reordering, drag-and-drop, and highlighting
- Add advanced filtering with filter builder and evaluator
- Add formula columns and summary configurations
- Add row grouping by property value
- Add keyboard navigation in folder view (arrow keys, Enter, Escape, Cmd+A)
- Add AI-powered folder suggestions for moving notes
- Add Vitest and Playwright test infrastructure
- Add unit tests for task filtering, sorting, grouping, and date utilities
- Add database seeding for tests

### Fixed
- Fix inbox archive to use soft deletion instead of hard delete
- Fix note deletion to clean up links and refresh backlinks
- Fix TitleInput to trigger onChange only on blur (not every keystroke)

### Changed
- Replace delete operations with archive actions in inbox
- Remove CardView and InboxCard components
- Remove RemindersPanel from sidebar
- Unify inbox detail panel (replace separate filing/preview panels)

### Performance
- Memoize property cells and group header rows in folder view
- Add AST caching for formula expression evaluator
- Virtualize folder view rows for large datasets

---

## 2025-12-22 → 2025-12-28 — Task Data Layer, Notes Features, Journal System, Inbox Capture

### Added
- Add task data layer with RepeatConfig, priority levels 0-4, project management
- Add task persistence for kanban drag-drop and status changes
- Add TanStack virtual scrolling for task lists
- Add note properties with database schema and IPC channels
- Add wiki-link rendering in note editor
- Add attachment system (upload, list, delete) for notes
- Add template management with folder default templates
- Add version history and snapshot creation for notes
- Add export functionality for notes
- Add virtualized rendering and error boundaries for note editor
- Add journal system with day cards, auto-save, word/character count
- Add journal focus mode, year view, and AI suggestions
- Add journal calendar with heatmap
- Add bookmarks and tags functionality for journal
- Add external change detection for journal entries
- Add inbox capture phases 1-9 (text, URL, image, voice)
- Add quick capture window with global shortcut
- Add custom protocol for audio/video streaming
- Add voice memo transcription
- Add inline tag editing in inbox preview panel

### Fixed
- Fix note titles to fetch asynchronously in task detail and note page

### Changed
- Migrate rich text editor from Tiptap to BlockNote

---

## 2025-12-15 → 2025-12-21 — Core Data Layer, Specifications

### Added
- Add core data layer with Drizzle ORM and SQLite (tasks T001-T093)
- Add database migrations and schema for notes, tasks, projects, settings
- Add vault management system
- Add shared IPC contracts between main and renderer
- Add full-text search infrastructure
- Add quick search with recent search history
- Add folder management (rename, delete, multi-select operations)
- Add link cleanup on note deletion
- Add isDeleted state handling for tabs
- Add feature specifications for tasks, notes, journal, inbox, sync, and search

### Fixed
- Fix shift+click selection to include folders

### Changed
- Move action icons to COLLECTIONS section header
- Remove virtual folder concept
- Initialize speckit tooling and constitution documents
- Remove obsolete agent and command files

---

## 2025-12-08 → 2025-12-14 — Tab System, Journal, Note Page, AI Composer

### Added
- Add split view tab system with drag-and-drop between panes
- Add keyboard shortcuts for tab and split view management
- Add browser-like tab styling with rounded active tabs
- Add journal page with two-column layout and infinite scroll
- Add journal calendar with heatmap view
- Add journal collapsible sections with animations
- Add journal focus mode with keyboard shortcuts
- Add wiki-link and tag extensions with fuzzy search autocomplete
- Add note page with layout, right sidebar, and outline components
- Add note title component with emoji picker
- Add tag management UI with color picker
- Add note InfoSection with property management
- Add rich text editor with floating toolbar, slash commands, and callouts
- Add AI agent composer with message input, model selection, and mode toggles
- Add related notes tab with AI-discovered connections
- Add note backlinks with snippet previews
- Add unified Tasks tab with internal views
- Add global AI agent panel

### Changed
- Extract tab drag-and-drop logic into dedicated provider
- Remove Inbox 2 page and consolidate navigation
- Derive task selection from active tab instead of props

---

## 2025-12-01 → 2025-12-07 — Initial UI Scaffold, Task Management

### Added
- Add sidebar with navigation, dropdown menus, and icon management
- Add file tree component with drag-and-drop
- Add IconPicker component for selecting icons
- Add Inbox page with font and color scheme
- Add keyboard shortcuts for navigation and folder selection
- Add task list, creation, and detail panel
- Add DueDatePicker and PrioritySelect with keyboard shortcuts
- Add kanban board with quick edit and compact mode
- Add repeating task functionality
- Add task filtering, sorting, and bulk actions
- Add drag-and-drop for task management and status changes
- Add subtask management with tree lines and reordering
- Add subtask progress dots and badge components
- Add autocomplete in QuickAddInput
- Add custom scrollbar styles

### Changed
- Lift drag-and-drop context from TasksPage to App.tsx
- Remove FileTree component after redesign

### Performance
- Replace React state focus with direct DOM focus in TreeNodeTrigger
