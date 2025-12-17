Excellent! I now have a complete picture of:
  1. Memry's architecture - React/Electron frontend with extensive dummy data
  2. Speckit's commands - constitution, specify, plan workflow
  3. Our sync/backend discussions - local-first, E2EE, vault-based, central server sync

  Let me create comprehensive speckit prompts for Memry.

  ---
  Memry Feature Analysis Summary

  Based on the codebase exploration, here are the features currently implemented with dummy data that need backend support:

  | Feature Area | Components                                      | Dummy Data Location                                 |
  |--------------|-------------------------------------------------|-----------------------------------------------------|
  | Notes        | note.tsx, ContentArea, BacklinksSection         | Mock content, tags, properties, backlinks           |
  | Tasks        | tasks.tsx, TaskList, KanbanBoard, CalendarView  | sample-tasks.ts (20+ tasks, 3 projects)             |
  | Inbox        | inbox.tsx, ListView, CardView, FilingPanel      | sample-inbox-items.ts (links, notes, voice, images) |
  | Journal      | journal.tsx, JournalCalendar, DayContextSidebar | Dummy heatmap, events, tasks, AI connections        |
  | Projects     | Project management, status workflows            | tasks-data.ts (3 sample projects)                   |
  | Tab System   | Tab persistence, split views                    | localStorage only                                   |
  | Search       | Fuzzy search, filters                           | In-memory filtering                                 |

  ---
  Speckit Slash Command Prompts for Memry

  1. /speckit.constitution Prompt

  /speckit.constitution

  Create governing principles for Memry, a local-first personal knowledge management (PKM) desktop application with mobile sync. The constitution must establish:

  ## Core Philosophy
  - LOCAL-FIRST ARCHITECTURE: User data lives primarily on their device in a vault folder (like Obsidian). The app must work fully offline. Files are plain markdown with YAML frontmatter - editable in any text editor (VS Code, vim, etc.).
  - END-TO-END ENCRYPTION (E2EE): All data synced to servers must be encrypted client-side. Server stores only encrypted blobs and cannot read user content. Encryption keys never leave user devices.
  - NO VENDOR LOCK-IN: Users own their data completely. Notes are .md files, not proprietary formats. Export is automatic (it's already files). Migration to other tools must be trivial.
  - PRIVACY BY DESIGN: Minimal metadata exposure. Even sync server knows only: user ID, blob sizes, timestamps - never content, filenames, or structure.

  ## Technical Principles
  - OFFLINE-FIRST: All features must work without internet. Sync is enhancement, not requirement.
  - FILE SYSTEM AS SOURCE OF TRUTH: For notes/journal, markdown files are authoritative. SQLite is cache/index only (rebuildable from files).
  - DATABASE FOR STRUCTURED DATA: Tasks, projects, settings stored in SQLite (synced as encrypted blob).
  - EXTERNAL EDIT DETECTION: Must detect changes made outside app (VS Code, Finder rename) via file watching with chokidar or @parcel/watcher.
  - RENAME TRACKING: Use frontmatter IDs to track file identity across renames.

  ## Quality Standards
  - TYPE SAFETY: Full TypeScript with strict mode. No `any` types except when interfacing with external libraries.
  - PERFORMANCE: UI interactions must feel instant (<100ms). Background sync must not block UI.
  - ACCESSIBILITY: WCAG 2.1 AA compliance. Full keyboard navigation. Screen reader support.
  - ERROR HANDLING: Graceful degradation. Never lose user data. Clear error messages.

  ## Security Requirements
  - ENCRYPTION: AES-256-GCM for content, Argon2id for key derivation.
  - KEY MANAGEMENT: Recovery key shown once at setup. Device linking via QR code or recovery phrase.
  - AUDIT: No plaintext secrets in logs. Secure credential storage (Keychain/Credential Manager).

  ## Testing Requirements
  - Unit tests for all utility functions and data transformations
  - Integration tests for sync logic and conflict resolution
  - E2E tests for critical user flows (create note, sync, edit on second device)

  ## Code Style
  - Functional components with hooks (no class components)
  - Event handlers prefixed with "handle" (handleClick, handleSave)
  - Custom hooks prefixed with "use" (useFileWatcher, useSyncEngine)
  - Early returns for readability
  - Colocation of related code (component + hook + types in same directory for features)

  ---
  2. /speckit.specify Prompts

  I recommend creating multiple feature specifications in sequence. Here are prompts for each major feature:

  2a. Core Data Layer & File System

  /speckit.specify

  Build the core data layer for Memry that manages local storage with file system integration:

  USER STORIES:
  1. As a user, I want my notes stored as markdown files in a vault folder so I can edit them with any text editor
  2. As a user, I want Memry to detect when I edit files externally (VS Code, Finder) and reflect changes immediately
  3. As a user, I want file renames to be tracked properly so my links and references don't break
  4. As a user, I want fast search and filtering without reading every file on each query

  REQUIREMENTS:
  - Vault folder selection on first launch (user chooses location)
  - File structure: vault/notes/*.md, vault/journal/*.md, vault/attachments/*, vault/.memry/ (hidden data)
  - Note files with YAML frontmatter: id (UUID), title, created, modified, tags, custom properties
  - SQLite database in .memry/index.db as searchable cache (rebuildable from files)
  - Full-text search index using SQLite FTS5
  - File watcher (chokidar) detecting: create, modify, delete, rename
  - Rename detection using frontmatter ID correlation (delete + create with same ID = rename)
  - Debounced file watching to handle rapid saves
  - Ignore patterns: .git, node_modules, .DS_Store

  ACCEPTANCE CRITERIA:
  - Opening vault indexes all existing markdown files within 5 seconds for <1000 files
  - External file edits appear in app within 500ms
  - File rename in Finder correctly updates database path without data loss
  - Search returns results in <50ms for vaults with 10,000 notes
  - Closing and reopening app restores full state from files

  2b. Task Management Backend

  /speckit.specify

  Build the task management data layer that persists tasks, projects, and statuses:

  USER STORIES:
  1. As a user, I want my tasks persisted locally so they survive app restarts
  2. As a user, I want to organize tasks into projects with custom status workflows
  3. As a user, I want repeating tasks that automatically create next occurrence when completed
  4. As a user, I want subtasks to break down complex tasks
  5. As a user, I want to link tasks to notes for context

  REQUIREMENTS:
  - Tasks stored in SQLite: .memry/data.db (not as files - too structured for markdown)
  - Task schema: id, title, description, projectId, statusId, priority, dueDate, dueTime, isRepeating, repeatConfig, parentId, linkedNoteIds, createdAt, completedAt, archivedAt
  - Project schema: id, name, description, icon, color, statuses[], isDefault, isArchived
  - Status schema: id, name, color, type (todo|in_progress|done), order
  - Subtask support via parentId relationship
  - Repeating task logic: on completion, create next occurrence based on repeatConfig
  - Task ordering persistence (user-defined sort order within status/project)
  - Soft delete with archive support
  - Undo support for destructive operations (delete, complete)

  ACCEPTANCE CRITERIA:
  - Creating 100 tasks completes in <1 second
  - Task list renders 500 tasks with smooth scrolling (virtualization)
  - Completing repeating task creates next occurrence atomically
  - Reordering tasks persists across app restart
  - Bulk operations (select 50 tasks, change priority) complete in <500ms

  2c. Sync Engine & E2E Encryption

  /speckit.specify

  Build the sync engine that synchronizes encrypted data between devices via a central server:

  USER STORIES:
  1. As a user, I want my data synced across my desktop and mobile so I see the same content everywhere
  2. As a user, I want my data encrypted before it leaves my device so even the server can't read it
  3. As a user, I want sync to work when I come back online after being offline
  4. As a user, I want to link new devices securely using a QR code or recovery phrase
  5. As a user, I want to see sync status (syncing, synced, conflict) clearly

  REQUIREMENTS:
  - Encryption: AES-256-GCM for content, unique file key per item, master key encrypts file keys
  - Key derivation: Master key generated randomly on first device, stored in OS keychain
  - Recovery key: BIP39-style mnemonic (24 words) shown once, derives same master key
  - Device linking: QR code containing encrypted master key OR enter recovery phrase
  - Sync protocol:
    - Track local changes with version numbers
    - Push: encrypt changed items, upload to server with version
    - Pull: fetch items with newer server version, decrypt locally
    - Conflict detection: local and server both modified same item
  - Conflict resolution: Last-write-wins with conflict copy preservation
  - Delta sync for large files (only changed chunks)
  - Sync queue with retry logic for network failures
  - Background sync that doesn't block UI

  ACCEPTANCE CRITERIA:
  - New note syncs to server within 5 seconds of save
  - Second device receives update within 10 seconds of server receiving it
  - Offline edits queue properly and sync when connection restored
  - Device linking via QR code completes in <30 seconds
  - Server cannot decrypt any content (verify with integration test)
  - Conflict creates both versions with clear naming (note.md, note.conflict-2024-01-15.md)

  2d. Inbox & Quick Capture

  /speckit.specify

  Build the inbox system for quick capture of links, notes, voice memos, and images:

  USER STORIES:
  1. As a user, I want to quickly capture a link and have it fetched with preview (title, excerpt, image)
  2. As a user, I want to record voice memos that get transcribed automatically
  3. As a user, I want to capture images (screenshots, photos) into my inbox
  4. As a user, I want to file inbox items to folders/projects or convert to notes
  5. As a user, I want stale items (>7 days old) highlighted for cleanup

  REQUIREMENTS:
  - Inbox items stored in SQLite with type discrimination: link, note, voice, image
  - Link capture: fetch URL, extract metadata (Open Graph, meta tags), store preview
  - Voice capture: record audio, store as .webm/.m4a in vault/attachments/, transcription via Whisper API or local model
  - Image capture: store in vault/attachments/, extract EXIF metadata
  - Filing actions: move to folder, convert to note, link to existing note, delete
  - Bulk operations: select multiple, file all to folder, delete all
  - Stale detection: items older than configurable threshold (default 7 days)
  - Quick capture global shortcut (Cmd+Shift+Space) even when app not focused

  ACCEPTANCE CRITERIA:
  - Link capture with preview completes in <3 seconds for most URLs
  - Voice recording starts instantly, transcription completes within 30 seconds of recording end
  - Filing item removes from inbox and creates/links appropriately
  - Bulk filing 20 items completes in <2 seconds
  - Global shortcut works when app is in background (Electron global shortcut)

  2e. Journal System

  /speckit.specify

  Build the journal system for daily entries with calendar navigation and AI connections:

  USER STORIES:
  1. As a user, I want one journal entry per day stored as a markdown file (YYYY-MM-DD.md)
  2. As a user, I want to navigate between days using a calendar with activity heatmap
  3. As a user, I want to see today's schedule and tasks alongside my journal
  4. As a user, I want AI to suggest connections between today's entry and past entries/notes
  5. As a user, I want month and year views showing my journaling history

  REQUIREMENTS:
  - Journal files: vault/journal/YYYY-MM-DD.md with frontmatter (id, date, wordCount, mood?)
  - Calendar widget showing current month with heatmap (color intensity = character count)
  - Day context sidebar: today's calendar events (from system calendar), today's tasks
  - AI connections panel: semantic similarity search finding related entries and notes
  - Views: day (editor), month (list of entries), year (12 month cards with stats)
  - Focus mode: hide sidebars, center editor, distraction-free writing
  - Auto-save with debounce (save 1 second after typing stops)
  - Word count and character count display

  ACCEPTANCE CRITERIA:
  - Switching between days loads content in <100ms
  - Heatmap renders correctly for 365 days of data
  - AI connections update within 2 seconds of content change (debounced)
  - Focus mode toggle is instant with smooth animation
  - Journal entry auto-saves without user action

  ---
  3. /speckit.plan Prompt

  /speckit.plan

  Plan the implementation of Memry's backend with these technology decisions:

  ## Existing Frontend Stack (Keep)
  - Electron 28+ with electron-vite
  - React 19 with TypeScript 5.3+
  - Tailwind CSS + shadcn/ui components
  - @dnd-kit for drag-drop
  - BlockNote/TipTap for rich text editing

  ## Local Data Layer
  - SQLite via better-sqlite3 (synchronous, fast, native)
    - Runs in Electron main process
    - Exposed to renderer via IPC
    - Two databases: index.db (note cache, FTS), data.db (tasks, projects, settings)
  - File system operations via Node.js fs module
    - Used in main process only
    - chokidar for file watching
  - Frontmatter parsing via gray-matter library

  ## Encryption Layer
  - libsodium-wrappers for cryptography (AES-256-GCM, Argon2id)
  - keytar for OS keychain integration (store master key)
  - bip39 for recovery phrase generation

  ## Sync Server (Backend API)
  - Framework choice - evaluate:
    - Option A: Hono.js on Cloudflare Workers (edge, low latency, generous free tier)
    - Option B: Fastify on Railway/Fly.io (more control, WebSocket support)
    - Option C: Supabase Edge Functions + Realtime (managed, includes auth)
  - Database: PostgreSQL (Supabase or Neon for serverless)
  - Storage: Cloudflare R2 or Supabase Storage (S3-compatible, for encrypted blobs)
  - Auth: OAuth providers (Google, Apple, GitHub) via Supabase Auth or custom JWT
  - Real-time: WebSocket or Server-Sent Events for push notifications

  ## Mobile App (Future)
  - React Native with Expo (share logic with desktop)
  - expo-sqlite for local database
  - Same encryption library (libsodium has React Native bindings)

  ## Key Architecture Decisions
  1. IPC BOUNDARY: All file/database operations in main process, renderer only sends commands
  2. SYNC GRANULARITY: Sync individual items, not entire database dumps
  3. ENCRYPTION SCOPE: Encrypt content + metadata, expose only: userId, itemId, size, timestamp to server
  4. CONFLICT STRATEGY: Automatic last-write-wins with conflict copy preservation
  5. OFFLINE QUEUE: IndexedDB in renderer for pending sync operations (survives crashes)

  ## Implementation Order
  1. Core data layer (SQLite + file system) - enables persistence
  2. Task management backend - most complex, validates data layer
  3. Note/journal file management - simpler, builds on file watching
  4. Encryption layer - add before sync
  5. Sync server setup - API endpoints
  6. Sync engine client - connect to server
  7. Device linking - multi-device support
  8. Inbox capture - link fetching, voice transcription
  9. AI features - embeddings, semantic search

  ## Research Questions to Address
  - SQLite in Electron: better-sqlite3 vs sql.js (native vs WASM)
  - File watching: chokidar vs @parcel/watcher (reliability vs performance)
  - Sync protocol: custom REST vs existing (CRDTs? PowerSync? Replicache?)
  - Voice transcription: Whisper API vs local whisper.cpp
  - AI embeddings: OpenAI API vs local model (privacy vs quality)

  ---
  Summary

  Here's what I've prepared for you:

  | Command               | Purpose                                                   | File Created           |
  |-----------------------|-----------------------------------------------------------|------------------------|
  | /speckit.constitution | Establish local-first, E2EE, privacy principles           | memory/constitution.md |
  | /speckit.specify (x5) | Feature specs for data layer, tasks, sync, inbox, journal | specs/00X-*/spec.md    |
  | /speckit.plan         | Tech stack decisions, architecture, implementation order  | specs/00X-*/plan.md    |

  Recommended Execution Order

  1. Run constitution first - establishes rules all features must follow
  2. Run specify for core data layer - foundation everything else needs
  3. Run plan - lock in tech stack decisions
  4. Run specify for remaining features - in dependency order

  Would you like me to:
  1. Refine any of these prompts?
  2. Add more feature specifications (search, settings, AI assistant)?
  3. Dive deeper into the backend tech stack comparison (Hono vs Fastify vs Supabase)?