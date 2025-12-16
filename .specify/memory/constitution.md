<!--
================================================================================
SYNC IMPACT REPORT
================================================================================
Version Change: N/A → 1.0.0 (Initial Ratification)

Added Sections:
- Architecture Principles (6 principles)
- Supported File Formats (3 principles)
- Development Standards (5 principles)
- Code Quality Standards (3 principles)
- Performance Requirements (4 principles)
- Security Standards (3 principles)
- Governance

Templates Requiring Updates:
- .specify/templates/plan-template.md ✅ (Constitution Check section compatible)
- .specify/templates/spec-template.md ✅ (Requirements align with principles)
- .specify/templates/tasks-template.md ✅ (Phase structure supports test-first approach)

Follow-up TODOs: None
================================================================================
-->

# Memry Constitution

## Project Identity

Memry is a local-first, end-to-end encrypted (E2EE), AI-driven all-in-one productivity application. It is a desktop application built with Electron for cross-platform compatibility (Windows, macOS, Linux), combining task management, journaling, note-taking, and visual canvas capabilities with optional AI augmentation.

---

## Architecture Principles

### I. Local-First Architecture (NON-NEGOTIABLE)

All user data MUST reside on the user's local machine in a vault folder structure (similar to Obsidian). The application MUST function fully offline without any internet connectivity required for core features.

**Requirements**:
- User data stored locally in a human-readable vault folder
- Application functions fully offline for all core features
- Sync is optional and peer-to-peer only—never through centralized servers for user content
- Vault location is user-configurable
- No proprietary binary formats for user content

### II. End-to-End Encryption (NON-NEGOTIABLE)

All user data at rest MUST be encrypted using industry-standard cryptographic protocols. Even when syncing between devices, data MUST remain encrypted in transit with zero-knowledge architecture.

**Requirements**:
- All sensitive data at rest encrypted with user-controlled keys
- Encryption keys derived from user credentials
- Keys NEVER leave the user's device
- Zero-knowledge architecture: application cannot read content without user action
- No plaintext secrets in application state, logs, or temporary files
- Support for hardware key integration (YubiKey, etc.) as optional enhancement

### III. Data Sovereignty (NON-NEGOTIABLE)

Users MUST own their data completely with no vendor lock-in. Migration away from Memry MUST be possible at any time with data intact.

**Requirements**:
- Export functionality available in standard, portable formats (Markdown, JSON)
- Import/export compatibility with Obsidian, Logseq, Bear
- No telemetry or phone-home without explicit consent
- GDPR/privacy-first design
- Users can migrate away with their data intact at any time

### IV. Privacy by Default (NON-NEGOTIABLE)

Privacy is the default state. Any data sharing or external processing requires explicit user action.

**Requirements**:
- No telemetry or analytics without explicit opt-in consent
- No AI processing on remote servers without explicit user permission
- AI features MUST support local/on-device inference as the default option
- All AI suggestions are transparent, explainable, and reversible
- Graceful degradation: app fully functional without AI features

### V. File System as Source of Truth

The vault folder on disk is the canonical source of truth. The application is a view into the file system, not a replacement for it.

**Requirements**:
- Users MAY edit, create, move, rename, or delete files and folders directly via Finder, Explorer, or any external tool
- Memry MUST detect and reconcile external changes seamlessly using file system watching (chokidar)
- External changes detected within 1 second via file watching
- No restart required to see external changes
- Reconciliation includes: file creation, modification, deletion, renaming, and moving

### VI. Format Agnostic Storage

The vault MUST accept ANY file type. The vault is a general-purpose encrypted file store with enhanced support for knowledge work formats.

**Requirements**:
- Users can place any file type in their vault folder tree
- Memry will index and display all files appropriately
- Unsupported formats gracefully handled as generic files
- No file type rejection or hiding

---

## Supported File Formats

### VII. Document Formats (First-Class Citizens)

Primary document formats receive full editing and rendering support.

**Supported Formats**:
- **Markdown** (`.md`): Primary note format with YAML frontmatter parsed via gray-matter
- **JSON Canvas** (`.canvas`): Visual canvas documents following the Obsidian JSON Canvas specification
- Wiki-links `[[note-name]]` for bidirectional linking
- Tags stored inline (`#tag`) and indexed for search
- Attachments stored in vault with relative path references
- Metadata in frontmatter or companion `.json` sidecar files

### VIII. Media Formats (First-Class Citizens)

Media files receive full preview and rendering support within the application.

**Supported Formats**:
- **Images**: `.avif`, `.bmp`, `.gif`, `.jpeg`, `.jpg`, `.png`, `.svg`, `.webp`
- **Audio**: `.flac`, `.m4a`, `.mp3`, `.ogg`, `.wav`, `.webm`, `.3gp`
- **Video**: `.mkv`, `.mov`, `.mp4`, `.ogv`, `.webm`
- **Documents**: `.pdf`

### IX. Arbitrary File Support

Any file type not explicitly listed above MUST still be handled gracefully.

**Requirements**:
- All files indexed and searchable by filename
- Files accessible through the UI
- Memry does not reject or hide unsupported formats
- Generic file icon/representation for unknown types

---

## Development Standards

### X. Electron Application Architecture

The desktop application MUST be built with Electron for cross-platform compatibility.

**Requirements**:
- Support for Windows, macOS, and Linux
- Mobile apps (iOS, Android) are secondary to the desktop experience
- Context isolation enforced—renderer has zero direct Node.js access
- All system operations through explicit IPC preload API
- No remote code execution or dynamic script loading
- Content Security Policy restricts external resources
- Sandboxed renderer process

### XI. File-Based Storage with Metadata Cache

User content is stored as files; databases are for caching and indexing only.

**Requirements**:
- Notes and canvas files stored as individual files within the vault folder
- SQLite database used ONLY for metadata caching, full-text search indexes, and application state
- Database is NEVER the primary store for user content
- If the database is deleted, it MUST be fully reconstructable from the vault files
- Atomic file operations (write-temp-then-rename pattern)

### XII. External Edit Reconciliation

File system changes made outside Memry MUST be detected and reconciled automatically.

**Requirements**:
- Changes detected within 1 second via chokidar file watching
- Supported change types: creation, modification, deletion, renaming, moving
- No restart required to see external changes
- Chokidar configured with appropriate ignore patterns, polling intervals, and atomic write detection

### XIII. Modular Feature Architecture

Each major feature MUST be implemented as a standalone module with clear interfaces.

**Requirements**:
- Features independently testable
- Features potentially disableable
- Clear interfaces between modules
- Major features include: notes, tasks, calendar, canvas, journal, search, AI assistant

### XIV. API-First Design

All features MUST expose their functionality through a well-documented internal API before building UI components.

**Requirements**:
- Internal API documentation for each feature module
- Consistency between CLI, GUI, and potential plugin systems
- API contracts defined before UI implementation

---

## Code Quality Standards

### XV. Test Coverage Requirements

All new features MUST include comprehensive tests.

**Requirements**:
- Unit tests with minimum 80% coverage for core modules
- Integration tests covering all critical user flows
- E2E tests required for:
  - Encryption/decryption workflows
  - Sync workflows
  - External file change detection
- TDD approach: tests written before implementation where practical

### XVI. Type Safety

TypeScript MUST be used throughout the codebase with maximum type safety.

**Requirements**:
- TypeScript strict mode enabled
- No `any` types except in clearly documented edge cases with justification
- All functions and methods properly typed
- Interface definitions for all data structures

### XVII. Documentation Requirements

Every module MUST be properly documented.

**Requirements**:
- Module README with purpose, API documentation, and usage examples
- Code comments required for complex logic
- Architecture Decision Records (ADRs) for significant technical choices
- All user operations MUST be undoable
- WCAG 2.1 AA accessibility compliance

---

## Performance Requirements

### XVIII. Startup Performance

Application MUST be usable quickly after launch.

**Requirements**:
- Usable within 3 seconds of launch on standard hardware
- Lazy loading for non-critical components
- Progressive hydration for large vaults
- Deferred initialization for background services

### XIX. File Watch Performance

File watching MUST perform well at scale.

**Requirements**:
- Chokidar configured for optimal performance with large vaults (10,000+ files)
- Appropriate ignore patterns (node_modules, .git, etc.)
- Optimal polling intervals
- Atomic write detection to prevent duplicate events

### XX. UI Responsiveness

User interface interactions MUST feel instant.

**Requirements**:
- UI responses within 100ms
- Heavy operations (search, AI processing, sync, vault scan) performed asynchronously
- Clear progress indicators for long-running operations
- Non-blocking UI for all user actions

### XXI. Scalability

Application MUST handle large vaults without degradation.

**Requirements**:
- Support for vaults with 10,000+ files
- Indexing remains performant at scale
- Search results returned quickly regardless of vault size
- Memory usage remains reasonable with large vaults

---

## Security Standards

### XXII. Dependency Audit

All dependencies MUST be vetted for security.

**Requirements**:
- Dependencies audited for security vulnerabilities before inclusion
- Regular dependency updates
- Security patches applied within 7 days of disclosure
- Minimal dependency footprint

### XXIII. Secure Defaults

All security-related configurations MUST default to the most secure option.

**Requirements**:
- Security-first default settings
- Users can opt for convenience, but security is never silently compromised
- Security-impacting changes require user notification
- Clear documentation of security implications for user choices

### XXIV. Memory Security

Sensitive data MUST be protected in memory.

**Requirements**:
- Encryption keys cleared from memory when no longer needed
- Decrypted content cleared from memory when no longer displayed
- No logging of sensitive data (keys, passwords, decrypted content)
- Secure memory handling for cryptographic operations

---

## Governance

### Amendment Process

1. **Proposal**: Amendments require documented rationale explaining the change and its impact
2. **Review**: Breaking changes require migration plans
3. **Notification**: Privacy-impacting changes require user notification
4. **Versioning**: Constitution follows semantic versioning:
   - MAJOR: Backward-incompatible governance/principle removals or redefinitions
   - MINOR: New principle/section added or materially expanded guidance
   - PATCH: Clarifications, wording, typo fixes, non-semantic refinements

### Compliance

- Constitution supersedes all other development practices
- All PRs/reviews MUST verify compliance with relevant principles
- Complexity MUST be justified against simplicity principles
- Non-negotiable principles (I, II, III, IV) cannot be violated under any circumstances

### Runtime Guidance

For day-to-day development guidance, refer to `CLAUDE.md` at the repository root.

---

**Version**: 1.0.0 | **Ratified**: 2025-12-16 | **Last Amended**: 2025-12-16
