# Memry Spec-Kit Core Prompts

This document contains the three foundational spec-kit prompts for building Memry's infrastructure. These prompts are designed to work with GitHub's spec-kit framework and establish a solid foundation for your local-first, E2EE, AI-driven note-taking application.

---

## 1. /constitution Prompt

The constitution establishes non-negotiable principles that guide all subsequent development decisions. Copy this prompt into your spec-kit environment after running `specify init`:

```
/speckit.constitution

Memry is a local-first, end-to-end encrypted (E2EE), AI-driven all-in-one productivity application. Establish the following non-negotiable principles:

## Architecture Principles

1. **Local-First Architecture**: All user data MUST reside on the user's local machine in a vault folder structure (similar to Obsidian). The application MUST function fully offline. Sync is optional and peer-to-peer only—never through centralized servers for user content.

2. **End-to-End Encryption (E2EE)**: All user data at rest MUST be encrypted using industry-standard cryptographic protocols. Encryption keys MUST be derived from user credentials and NEVER leave the user's device. Even when syncing between devices, data MUST remain encrypted in transit with zero-knowledge architecture.

3. **Data Sovereignty**: Users MUST own their data completely. Export functionality MUST be available in standard, portable formats. No vendor lock-in—users can migrate away with their data intact at any time.

4. **Privacy by Default**: No telemetry or analytics without explicit opt-in consent. No AI processing on remote servers without explicit user permission. AI features MUST support local/on-device inference as the default option.

5. **File System as Source of Truth**: The vault folder on disk is the canonical source of truth. Users MAY edit, create, move, rename, or delete files and folders directly via Finder, Explorer, or any external tool—Memry MUST detect and reconcile these external changes seamlessly using file system watching (chokidar). The application is a view into the file system, not a replacement for it.

6. **Format Agnostic Storage**: The vault MUST accept ANY file type. Users can dump any file into their vault folder tree and Memry will index and display it appropriately. The vault is not restricted to specific formats—it is a general-purpose encrypted file store with enhanced support for knowledge work formats.

## Supported File Formats (First-Class Citizens)

7. **Document Formats**: Markdown files (`.md`) with YAML frontmatter (parsed via gray-matter) are the primary note format. JSON Canvas files (`.canvas`) following the Obsidian JSON Canvas specification are supported for visual canvas documents.

8. **Media Formats**: Images (`.avif`, `.bmp`, `.gif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.webp`), audio (`.flac`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.webm`, `.3gp`), video (`.mkv`, `.mov`, `.mp4`, `.ogv`, `.webm`), and PDF documents (`.pdf`) receive first-class rendering and preview support.

9. **Arbitrary Files**: Any other file type placed in the vault MUST be indexed, searchable by filename, and accessible through the UI. Memry does not reject or hide unsupported formats—it gracefully handles them as generic files.

## Development Standards

10. **Electron Application**: The desktop application MUST be built with Electron for cross-platform compatibility (Windows, macOS, Linux). Mobile apps (iOS, Android) will follow but are secondary to the desktop experience.

11. **File-Based Storage with Metadata Cache**: Note and canvas files MUST be stored as individual files within the vault folder. SQLite database is used ONLY for metadata caching, full-text search indexes, and application state—never as the primary store for user content. If the database is deleted, it MUST be fully reconstructable from the vault files.

12. **External Edit Reconciliation**: File system changes made outside Memry MUST be detected within 1 second via chokidar file watching and reconciled into the application state. This includes file creation, modification, deletion, renaming, and moving. No restart should be required to see external changes.

13. **Modular Feature Architecture**: Each major feature (notes, tasks, calendar, canvas, etc.) MUST be implemented as a standalone module with clear interfaces. Features MUST be independently testable and potentially disableable.

14. **API-First Design**: All features MUST expose their functionality through a well-documented internal API before building UI components. This ensures consistency between CLI, GUI, and potential plugin systems.

## Code Quality Standards

15. **Test Coverage**: All new features MUST include unit tests with minimum 80% coverage. Integration tests MUST cover all critical user flows. E2E tests required for encryption/decryption, sync workflows, and external file change detection.

16. **Type Safety**: TypeScript MUST be used throughout the codebase. Strict mode enabled. No `any` types except in clearly documented edge cases with justification.

17. **Documentation**: Every module MUST include README with purpose, API documentation, and usage examples. Code comments required for complex logic. Architecture Decision Records (ADRs) for significant technical choices.

## Performance Requirements

18. **Startup Performance**: Application MUST be usable within 3 seconds of launch on standard hardware. Use lazy loading and progressive hydration for large vaults.

19. **File Watch Performance**: Chokidar MUST be configured for optimal performance with large vaults (10,000+ files). Use appropriate ignore patterns, polling intervals, and atomic write detection.

20. **Responsiveness**: UI interactions MUST feel instant (<100ms response time). Heavy operations (search, AI processing, sync, vault scan) MUST be performed asynchronously with clear progress indicators.

21. **Scalability**: Application MUST handle vaults with 10,000+ files without degradation. Indexing and search MUST remain performant at scale.

## Security Standards

22. **Dependency Audit**: All dependencies MUST be audited for security vulnerabilities before inclusion. Regular dependency updates with security patches applied within 7 days of disclosure.

23. **Secure Defaults**: All security-related configurations MUST default to the most secure option. Users can opt for convenience, but security is never silently compromised.

24. **Memory Security**: Sensitive data (encryption keys, decrypted content) MUST be cleared from memory when no longer needed. No logging of sensitive data.
```

---

## 2. /specify Prompt

The specification defines WHAT you're building and WHY, focusing on features and user stories without technical implementation details. Use this after establishing your constitution:

```
/speckit.specify

Build Memry, an all-in-one local-first productivity platform that combines note-taking, visual canvases, task management, and knowledge organization. The application treats the local file system as the source of truth, storing all data in a vault folder on the user's machine with end-to-end encryption and optional AI assistance.

## Core Features to Implement

### 1. Vault & File Management (Priority: Critical)
Users create and manage a "vault" which is a designated folder on their local filesystem. The vault is an open folder that users can interact with directly through Finder, Explorer, or any file manager.

**Vault Behavior:**
- **Open Folder Philosophy**: The vault is just a regular folder. Users can create, edit, rename, move, or delete files using ANY tool—text editors, image editors, Finder, Explorer, terminal commands. Memry watches for these changes and updates its view accordingly.
- **File System Watching**: Memry uses chokidar to monitor the vault folder recursively. Any external change (create, modify, delete, rename, move) is detected and reflected in the UI within 1 second without requiring restart or manual refresh.
- **Nested Structure**: Hierarchical folder structure for organizing content. Folders act as notebooks. Users can organize via drag-and-drop in Memry OR directly in the file system.
- **Any File Welcome**: Users can place ANY file type in their vault. PDFs, spreadsheets, archives, executables—everything is indexed by filename and accessible through Memry's file browser.

**First-Class File Format Support:**

- **Markdown Notes (`.md`)**: Rich notes with YAML frontmatter for metadata (title, tags, aliases, created, modified, custom fields). Frontmatter parsed using gray-matter library. Body supports full Markdown with extensions (wikilinks, task checkboxes, callouts, etc.).

- **JSON Canvas (`.canvas`)**: Visual canvas documents following the Obsidian JSON Canvas specification (jsoncanvas). Canvases contain nodes (text, files, links, groups) and edges (connections between nodes) in a JSON structure. Full editing support with visual canvas editor.

- **Images**: Formats `.avif`, `.bmp`, `.gif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.webp`. Displayed inline in notes, viewable in gallery mode, basic metadata extraction (EXIF for photos).

- **Audio**: Formats `.flac`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.webm`, `.3gp`. Playable within Memry with waveform visualization. Support for embedding in notes with timestamps.

- **Video**: Formats `.mkv`, `.mov`, `.mp4`, `.ogv`, `.webm`. Playable within Memry with standard video controls. Thumbnail generation for previews.

- **PDF Documents (`.pdf`)**: Rendered inline with page navigation. Text extraction for search. Annotation support (highlights, notes) stored as sidecar files.

**Additional Capabilities:**
- **Handwriting & OCR**: Optional handwriting input (for tablet/stylus users) with OCR capabilities to make handwritten content searchable.
- **Version History**: Git-based or custom versioning for tracking changes to text files. View diffs and restore previous versions.
- **Conflict Resolution**: When external changes conflict with unsaved internal changes, present clear merge UI.

### 2. Linking & Knowledge Graph (Priority: Critical)
- **Backlinks**: Automatic bidirectional linking between notes. When Note A links to Note B, Note B shows it's referenced by Note A. Works across Markdown notes and canvas nodes.
- **Tags**: Hierarchical tagging system in frontmatter. Tags can have sub-tags (e.g., `#project/memry/backend`). Tag cloud and tag-based navigation.
- **Graph View**: Visual representation of note and canvas connections. Interactive—zoom, pan, filter by tags/folders, click to navigate. Shows both explicit links and implicit connections.
- **Quick Links**: Double-bracket `[[notation]]` for creating links in Markdown. Autocomplete suggestions while typing. Support for aliases `[[actual-note|Display Text]]`.
- **Embeds**: Transclusion support `![[note]]` to embed content from one note into another.

### 3. Canvas & Visual Thinking (Priority: High)
- **JSON Canvas Support**: Full implementation of the JSON Canvas specification for `.canvas` files.
- **Canvas Nodes**: Support for text nodes (rich text content), file nodes (embed any vault file), link nodes (embed web URLs), and group nodes (visual grouping).
- **Canvas Edges**: Connections between nodes with optional labels, colors, and arrow styles.
- **Infinite Canvas**: Freeform spatial arrangement with pan and zoom. No fixed boundaries.
- **Canvas-Note Bridge**: Convert canvas nodes to full notes. Embed canvases in notes. Bidirectional navigation.
- **Whiteboard Mode**: Quick sketching with drawing tools layered over canvas.

### 4. Task Management (Priority: High)
- **Inline Tasks**: Create tasks directly within Markdown notes using checkbox syntax `- [ ] Task`. Tasks extracted and aggregated into unified views.
- **Task Properties**: Due dates, reminders, priority levels (P1-P4), status, and custom fields stored in task syntax or note frontmatter.
- **Views**: Multiple view types for aggregated tasks—List view, Kanban board, Calendar view, Gantt timeline.
- **Goals Dashboard**: High-level goals that tasks link to. Track progress with aggregated metrics.
- **Recurring Tasks**: Daily, weekly, monthly, and custom recurrence patterns.

### 5. Calendar Integration (Priority: High)
- **Built-in Calendar**: Native calendar view showing tasks with due dates, events, and scheduled items.
- **External Sync**: Bidirectional sync with Google Calendar, Outlook Calendar, and Apple Calendar.
- **Daily Notes**: Auto-generated daily note pages linked to calendar dates. Customizable templates.
- **Time Blocking**: Schedule focus time integrated with tasks.

### 6. AI Assistant (Priority: High)
- **Local-First AI**: Default to local inference via Ollama integration. Cloud AI (OpenAI, Anthropic, etc.) available as explicit opt-in.
- **AI Features**:
  - Summarization of notes, PDFs, and long documents
  - Writing assistance (grammar, style, continuation)
  - Semantic search across all text content
  - Automatic tagging suggestions based on content
  - Q&A over your vault (RAG-based retrieval)
  - Audio/video transcription to notes
  - Image description and OCR
- **Privacy Controls**: Per-feature choice of local vs. cloud processing. Clear visual indicators when data would leave device.

### 7. Quick Capture (Inbox) (Priority: High)
- **Global Hotkey**: System-wide shortcut to capture thoughts instantly. Works even when Memry is minimized or closed.
- **Inbox Folder**: Captured items saved as notes in a designated inbox folder for later processing.
- **Web Clipper**: Browser extension to clip pages, articles, and selections into vault.
- **Share Sheet Integration**: On mobile, share content from other apps directly to Memry.

### 8. End-to-End Encryption (Priority: Critical)
- **Vault Encryption**: Entire vault encrypted at rest. AES-256-GCM minimum. All file types encrypted, not just notes.
- **Key Derivation**: Master key derived from user passphrase using Argon2id. Optional hardware key (YubiKey) support.
- **Transparent Encryption**: Files appear decrypted when vault is unlocked. Actual files on disk are always encrypted. External editors see encrypted blobs unless using Memry's decryption layer.
- **Secure Sync**: When syncing, data remains encrypted end-to-end. Sync servers see only encrypted blobs.

### 9. Search (Priority: Critical)
- **Full-Text Search**: Fast search across all text content (Markdown, canvas text nodes, PDF text, etc.).
- **Filename Search**: Find any file in vault by name, including non-text files.
- **Semantic Search**: AI-powered conceptual search using embeddings.
- **Filters**: Filter by file type, folder, tags, date ranges, and custom metadata.
- **Quick Switcher**: Keyboard-driven file launcher (Cmd/Ctrl+O style).

### 10. Sync & Collaboration (Priority: Medium)
- **Device Sync**: Sync vault across user's devices (desktop, mobile). P2P preferred, relay for NAT traversal.
- **Real-Time Collaboration**: Multi-user editing with CRDT-based conflict resolution (future team tier).
- **Sharing**: Share individual notes or folders with granular permissions.

### 11. Integration Hub (Priority: Medium)
- **Built-in Integrations**: Google Calendar, Slack, Microsoft Teams, Google Drive, OneDrive, GitHub, Jira.
- **Automation**: Zapier/IFTTT webhooks for custom workflows.
- **API**: REST API for power users and custom integrations.

## User Experience Requirements

- **External Editing Friendly**: Users should feel confident editing vault files in external tools (VS Code, Typora, etc.) knowing Memry will pick up changes instantly.
- **Cross-Platform Consistency**: UI/UX consistent across Windows, macOS, Linux.
- **Keyboard-First**: Complete operation possible via keyboard. Comprehensive shortcuts.
- **Accessibility**: WCAG 2.1 AA compliance. Screen reader support, high contrast themes.
- **Theming**: Light/dark mode, custom themes, synced preferences.
```

---

## 3. /plan Prompt

The plan defines HOW you'll build Memry technically. Use this after your specification is finalized and clarified:

```
/speckit.plan

Implement Memry using the following technology stack and architecture:

## Technology Stack

### Desktop Application
- **Framework**: Electron 30+ with context isolation and sandbox enabled
- **Frontend**: React 18+ with TypeScript for the renderer process
- **State Management**: Zustand for global state, React Query for async data
- **UI Components**: Radix UI primitives + Tailwind CSS for styling
- **Markdown Editor**: TipTap (ProseMirror-based) with custom extensions for wikilinks, tasks, callouts
- **Canvas Editor**: Custom React canvas component implementing JSON Canvas spec, or integration with existing library

### Backend/Main Process
- **Language**: TypeScript (Node.js) in Electron main process
- **Database**: SQLite via better-sqlite3 for metadata cache, indexes, and app state (NOT primary storage)
- **File System Watching**: chokidar (https://github.com/paulmillr/chokidar) for real-time vault monitoring
- **Frontmatter Parsing**: gray-matter (https://github.com/jonschlinkert/gray-matter) for YAML frontmatter in Markdown files
- **Encryption**: libsodium-wrappers for cryptographic operations

### AI Integration
- **Local Inference**: Ollama integration via REST API for local LLM support
- **Embeddings**: Local embedding models (all-MiniLM-L6-v2) for semantic search
- **Vector Store**: LanceDB (embedded) for vector similarity search
- **Cloud AI (Optional)**: OpenAI/Anthropic SDK for opt-in cloud features
- **Transcription**: Whisper.cpp for local audio/video transcription

### Media Handling
- **PDF**: pdf.js for rendering, pdf-parse for text extraction
- **Images**: sharp for processing, resizing, thumbnail generation
- **Audio/Video**: Native HTML5 media elements, ffmpeg for transcoding/thumbnails
- **EXIF**: exif-js or sharp for metadata extraction

### Data & Sync
- **File Format**: Markdown with gray-matter frontmatter, JSON Canvas for `.canvas` files
- **Sync Protocol**: Automerge or Yjs for CRDT-based conflict resolution
- **P2P Layer**: libp2p or Hyperswarm for peer-to-peer sync

## Application Architecture

### Layered Architecture

┌─────────────────────────────────────────────────────────┐
│                   Renderer Process                       │
│  ┌───────────────────────────────────────────────────┐  │
│  │              React UI Components                   │  │
│  │   (Notes, Canvas, Tasks, Calendar, Gallery, etc.) │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │          State & Data Layer (Zustand)              │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │            IPC Bridge (Type-safe)                  │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│                    Main Process                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │               Service Layer                        │  │
│  │    VaultService, FileWatcherService, NoteService, │  │
│  │    CanvasService, TaskService, SearchService,     │  │
│  │    AIService, SyncService, MediaService           │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │             Core Domain Layer                      │  │
│  │   Encryption, FileSystem, Database, Index,        │  │
│  │   FileWatcher (chokidar), Frontmatter (gray-matter)│  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
        │
        │ File System Events (chokidar)
        ▼
┌─────────────────────────────────────────────────────────┐
│                    Vault Folder                          │
│  (User's local encrypted files - source of truth)       │
└─────────────────────────────────────────────────────────┘


### Module Structure

memry/
├── packages/
│   ├── core/                      # Shared types, utilities, domain logic
│   │   ├── encryption/            # Crypto operations, key management
│   │   ├── vault/                 # Vault operations, file types
│   │   ├── file-watcher/          # chokidar wrapper, event normalization
│   │   ├── frontmatter/           # gray-matter wrapper, schema validation
│   │   ├── note/                  # Note model, Markdown processing
│   │   ├── canvas/                # JSON Canvas parsing, validation
│   │   ├── task/                  # Task extraction, recurrence
│   │   ├── search/                # FTS and semantic search
│   │   └── media/                 # Media type detection, processing
│   │
│   ├── electron-main/             # Main process services
│   │   ├── services/
│   │   │   ├── vault.service.ts   # Vault open/close/create
│   │   │   ├── watcher.service.ts # chokidar integration
│   │   │   ├── note.service.ts    # Note CRUD, frontmatter
│   │   │   ├── canvas.service.ts  # Canvas CRUD
│   │   │   ├── search.service.ts  # Search operations
│   │   │   ├── media.service.ts   # Media processing
│   │   │   └── ai.service.ts      # AI operations
│   │   ├── ipc/                   # IPC handlers
│   │   └── database/              # SQLite operations, migrations
│   │
│   ├── electron-renderer/         # React frontend
│   │   ├── components/
│   │   │   ├── editor/            # TipTap Markdown editor
│   │   │   ├── canvas/            # JSON Canvas renderer/editor
│   │   │   ├── media/             # Image, audio, video, PDF viewers
│   │   │   ├── file-tree/         # Vault file browser
│   │   │   └── search/            # Search UI
│   │   ├── features/              # Feature modules
│   │   │   ├── notes/
│   │   │   ├── canvas/
│   │   │   ├── tasks/
│   │   │   ├── calendar/
│   │   │   └── graph/
│   │   ├── hooks/                 # Custom React hooks
│   │   └── store/                 # Zustand stores
│   │
│   └── ai/                        # AI integration package
│       ├── local/                 # Ollama, Whisper.cpp
│       ├── cloud/                 # OpenAI, Anthropic
│       └── embeddings/            # Vector embeddings
│
├── apps/
│   └── desktop/                   # Electron app entry point
│
└── tools/                         # Build tools, scripts


### Key Technical Decisions

**1. File Watching with chokidar**
```typescript
// Core file watcher configuration
import chokidar from 'chokidar';

const watcher = chokidar.watch(vaultPath, {
  ignored: [
    /(^|[\/\\])\../,           // Hidden files
    '**/node_modules/**',
    '**/.git/**',
    '**/.memry/**'              // Internal app folder
  ],
  persistent: true,
  ignoreInitial: false,         // Emit 'add' on startup for indexing
  awaitWriteFinish: {           // Handle atomic saves
    stabilityThreshold: 300,
    pollInterval: 100
  },
  usePolling: false,            // Native events preferred
  alwaysStat: true,             // Get file stats with events
  depth: 99                     // Deep recursion
});

// Event handling
watcher
  .on('add', (path, stats) => handleFileAdd(path, stats))
  .on('change', (path, stats) => handleFileChange(path, stats))
  .on('unlink', (path) => handleFileDelete(path))
  .on('addDir', (path) => handleDirAdd(path))
  .on('unlinkDir', (path) => handleDirDelete(path))
  .on('error', (error) => handleWatchError(error));


**2. Frontmatter Parsing with gray-matter**
```typescript
import matter from 'gray-matter';

// Parse Markdown file with frontmatter
const content = await fs.readFile(filePath, 'utf-8');
const { data: frontmatter, content: body } = matter(content);

// Frontmatter schema for notes
interface NoteFrontmatter {
  title?: string;
  aliases?: string[];
  tags?: string[];
  created?: string;        // ISO date
  modified?: string;       // ISO date
  [key: string]: unknown;  // Custom fields
}

// Stringify back to file
const output = matter.stringify(body, frontmatter);
await fs.writeFile(filePath, output);
```

**3. Supported File Types Registry**
```typescript
const FILE_TYPES = {
  // First-class document formats
  markdown: { extensions: ['.md'], parser: 'gray-matter', editor: 'tiptap' },
  canvas: { extensions: ['.canvas'], parser: 'json', editor: 'canvas-editor' },

  // Media formats with preview support
  image: {
    extensions: ['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'],
    preview: 'image-viewer'
  },
  audio: {
    extensions: ['.flac', '.m4a', '.mp3', '.ogg', '.wav', '.webm', '.3gp'],
    preview: 'audio-player'
  },
  video: {
    extensions: ['.mkv', '.mov', '.mp4', '.ogv', '.webm'],
    preview: 'video-player'
  },
  pdf: { extensions: ['.pdf'], preview: 'pdf-viewer' },

  // Generic file (catch-all)
  generic: { extensions: ['*'], preview: 'file-info' }
};
```

**4. JSON Canvas Implementation**
```typescript
// Following jsoncanvas spec: https://jsoncanvas.org/spec/1.0/
interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface CanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  // Type-specific properties
  text?: string;           // For text nodes
  file?: string;           // For file nodes (vault path)
  url?: string;            // For link nodes
  label?: string;          // For group nodes
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: 'top' | 'right' | 'bottom' | 'left';
  toSide?: 'top' | 'right' | 'bottom' | 'left';
  color?: string;
  label?: string;
}
```

**5. Database Schema (SQLite - Metadata Cache Only)**
```sql
-- Reconstructable from vault files if deleted
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL,        -- 'markdown', 'canvas', 'image', etc.
  title TEXT,                -- From frontmatter or filename
  created_at INTEGER,
  modified_at INTEGER,
  size INTEGER,
  hash TEXT                  -- For change detection
);

CREATE TABLE frontmatter (
  path TEXT PRIMARY KEY REFERENCES files(path),
  data JSON                  -- Full frontmatter as JSON
);

CREATE TABLE tags (
  path TEXT REFERENCES files(path),
  tag TEXT,
  PRIMARY KEY (path, tag)
);

CREATE TABLE links (
  source_path TEXT REFERENCES files(path),
  target_path TEXT,          -- May not exist yet (broken link)
  link_text TEXT,
  PRIMARY KEY (source_path, target_path, link_text)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  path TEXT REFERENCES files(path),
  line_number INTEGER,
  text TEXT,
  completed INTEGER,
  due_date TEXT,
  priority INTEGER
);

-- Full-text search
CREATE VIRTUAL TABLE fts USING fts5(
  path, title, content, tags,
  tokenize='porter unicode61'
);

-- Vector embeddings (or use LanceDB separately)
CREATE TABLE embeddings (
  path TEXT PRIMARY KEY,
  chunk_index INTEGER,
  embedding BLOB
);
```

**6. External Edit Reconciliation Flow**
```
File change detected by chokidar
           │
           ▼
┌──────────────────────┐
│  Debounce (300ms)    │  ← Batch rapid changes
└──────────────────────┘
           │
           ▼
┌──────────────────────┐
│  Check file hash     │  ← Skip if no actual change
└──────────────────────┘
           │
           ▼
┌──────────────────────┐
│  Is file open in UI? │
└──────────────────────┘
        │         │
       Yes        No
        │         │
        ▼         ▼
┌─────────────┐  ┌─────────────────┐
│Check unsaved│  │ Update index    │
│  changes    │  │ & refresh UI    │
└─────────────┘  └─────────────────┘
     │    │
     No   Yes
     │    │
     ▼    ▼
┌──────┐ ┌──────────────┐
│Reload│ │ Show merge   │
│ file │ │ conflict UI  │
└──────┘ └──────────────┘
```

**7. Encryption Architecture**
- User passphrase → Argon2id → Master Key
- Master Key encrypts Vault Key (stored in vault/.memry/keys)
- Individual files encrypted with file-specific derived keys
- Chokidar watches encrypted files; decryption happens on read

## Implementation Phases

**Phase 1: Foundation (Weeks 1-4)**
- Monorepo setup with pnpm workspaces
- Core encryption module with tests
- Vault creation/opening with encryption
- chokidar integration with event normalization
- gray-matter integration for Markdown files
- Basic file browser UI

**Phase 2: Core Notes (Weeks 5-8)**
- TipTap editor with Markdown support
- Frontmatter editing UI
- Wikilinks and backlinks
- Tags in frontmatter
- Full-text search (FTS5)

**Phase 3: Multi-Format Support (Weeks 9-12)**
- JSON Canvas parser and renderer
- Canvas editor with nodes and edges
- Image, audio, video viewers
- PDF viewer with text extraction
- Generic file handling

**Phase 4: Organization (Weeks 13-16)**
- Graph view of connections
- Version history (git-based)
- Quick capture / inbox
- External edit conflict resolution UI

**Phase 5: Tasks & Calendar (Weeks 17-20)**
- Task extraction from Markdown
- Multiple views (list, Kanban)
- Calendar integration
- Recurring tasks

**Phase 6: AI Features (Weeks 21-24)**
- Ollama integration
- Semantic search with embeddings
- Summarization and Q&A
- Audio/video transcription

**Phase 7: Sync & Polish (Weeks 25-28)**
- P2P sync with CRDTs
- Device pairing
- Performance optimization
- Cross-platform testing

## Development Guidelines

- Write tests first for core domain logic (encryption, parsing, file watching)
- Test external edit scenarios extensively (simulate Finder/Explorer changes)
- Use feature flags for experimental features
- Performance benchmarks for vaults with 10k+ files
- Security review for all crypto code
- Accessibility audit each component
```

---

## Usage Instructions

1. Initialize your project with spec-kit:
   ```bash
   uvx --from git+https://github.com/github/spec-kit.git specify init memry --ai claude
   ```

2. Navigate to the project and launch Claude Code (or your preferred agent):
   ```bash
   cd memry
   claude
   ```

3. Run the commands in order:
   - First: Copy the `/speckit.constitution` prompt above
   - Second: Copy the `/speckit.specify` prompt
   - Third: Run `/speckit.clarify` to refine requirements
   - Fourth: Copy the `/speckit.plan` prompt
   - Fifth: Run `/speckit.tasks` to generate task breakdown
   - Finally: Run `/speckit.implement` to execute

## Key Dependencies Summary

| Library | Purpose | Why This Choice |
|---------|---------|-----------------|
| chokidar | File system watching | Most reliable cross-platform file watcher, handles atomic saves, supports recursive watching |
| gray-matter | Frontmatter parsing | De facto standard for YAML frontmatter in Markdown, used by Jekyll, Gatsby, Obsidian ecosystem |
| better-sqlite3 | Metadata cache | Synchronous API for Electron, fast, reconstructable cache |
| libsodium-wrappers | Encryption | Audited crypto library, supports all needed primitives |
| TipTap | Markdown editor | ProseMirror-based, highly extensible for custom syntax |

## Notes on Customization

These prompts are comprehensive starting points. Adjust based on your priorities and MVP scope. The key principles that should remain stable are the local-first architecture, E2EE approach, file-system-as-truth philosophy, and support for external editing via chokidar watching.
