<!--
  SYNC IMPACT REPORT
  ==================
  Version change: (new) -> 1.0.0

  Added sections:
  - Core Philosophy (4 principles): Local-First Architecture, E2EE, No Vendor Lock-In, Privacy by Design
  - Technical Principles (6 principles): Offline-First, File System as Source of Truth, Database for Structured Data, External Edit Detection, Rename Tracking, Single Source of Truth
  - Quality Standards (5 subsections): Type Safety, Performance, Accessibility, Error Handling, Defensive Coding
  - Security Requirements (4 subsections): Encryption Standards, Key Management, Secure Communication, Audit Requirements
  - Testing Requirements (4 subsections): Unit Tests, Integration Tests, E2E Tests, Encryption Tests
  - Code Style (4 subsections): Component Architecture, Naming Conventions, Code Organization, Documentation
  - Governance

  Templates requiring updates:
  - .specify/templates/plan-template.md: ✅ Compatible (Constitution Check section exists, no update needed)
  - .specify/templates/spec-template.md: ✅ Compatible (no constitution-specific references)
  - .specify/templates/tasks-template.md: ✅ Compatible (no constitution-specific references)
  - .specify/templates/checklist-template.md: ✅ Compatible (no constitution-specific references)
  - .specify/templates/agent-file-template.md: ✅ Compatible (no constitution-specific references)

  Follow-up TODOs: None
-->

# Memry Constitution

## Core Philosophy

### I. Local-First Architecture

User data MUST live primarily on their device in a vault folder. The app MUST work fully offline without any
internet dependency. All note and journal files MUST be plain markdown with YAML frontmatter, editable in any
text editor (VS Code, vim, Obsidian, etc.). The app is a window into the user's files, not a prison for their data.

**Rationale**: Users maintain full ownership and control of their data. No service dependency means no service
shutdown risk.

### II. End-to-End Encryption (E2EE)

All data synced to servers MUST be encrypted client-side before transmission. The server MUST store only
encrypted blobs and MUST NOT be able to read user content. Encryption keys MUST NEVER leave user devices.
Zero-knowledge architecture means we cannot help recover data if the user loses their key.

**Rationale**: Privacy is non-negotiable. Users trust us with their personal thoughts; we MUST be technically
incapable of betraying that trust.

### III. No Vendor Lock-In

Users MUST own their data completely. Notes are .md files, not proprietary formats. Tasks MUST be exportable
to standard formats (JSON, CSV, or similar). Migration to other tools MUST be trivial. If Memry disappears
tomorrow, users MUST still have all their data in usable formats.

**Rationale**: Respecting user autonomy builds trust and ensures the product succeeds on merit, not lock-in.

### IV. Privacy by Design

Metadata exposure MUST be minimized. Even the sync server knows only: user ID, blob sizes, timestamps - never
content, filenames, or structure. No analytics that could identify user behavior patterns. No telemetry
without explicit opt-in from the user.

**Rationale**: Privacy is achieved through architecture, not policy. If we don't collect it, we can't leak it.

## Technical Principles

### V. Offline-First

All features MUST work without internet connection. Sync is an enhancement, not a requirement. Network
failures MUST NEVER cause data loss or corrupt state. The app MUST degrade gracefully when connectivity
is unavailable.

**Rationale**: Users work anywhere - planes, remote areas, spotty connections. The app MUST be reliable
regardless of network state.

### VI. File System as Source of Truth

For notes and journal entries, markdown files are authoritative. SQLite database is cache/index only and
MUST be rebuildable from files at any time. If the database corrupts, recovery MUST rebuild from files.
No data loss is acceptable.

**Rationale**: Plain files are durable, inspectable, version-controllable, and independent of our software.

### VII. Database for Structured Data

Tasks, projects, inbox items, and settings are stored in SQLite (synced as encrypted blob). These are
inherently structured and don't benefit from plain-text file format. The database is the source of truth
for these entities.

**Rationale**: Structured data benefits from database features: transactions, queries, indexes.
Forcing it into files adds complexity without user benefit.

### VIII. External Edit Detection

The app MUST detect changes made outside the app (VS Code, Finder rename, git pull) via file watching.
Users MUST NEVER have to "refresh" or "reload" - changes MUST appear automatically. File system events
MUST be debounced and batched appropriately.

**Rationale**: Users use multiple tools. Memry MUST coexist gracefully with their workflow.

### IX. Rename Tracking

Use frontmatter UUIDs to track file identity across renames. File path is display name, UUID is true
identity. Renames MUST NEVER break internal links or references. UUID MUST be generated on file
creation and preserved through all operations.

**Rationale**: Users rename files frequently. Breaking links on rename destroys trust in the tool.

### X. Single Source of Truth

Every piece of data MUST have exactly one authoritative location. No data duplication that could lead
to inconsistency. Derived data (search index, caches) MUST be clearly marked as rebuildable and
MUST be automatically invalidated when source data changes.

**Rationale**: Duplicate data inevitably diverges. Single source prevents "which one is right?"
confusion.

## Quality Standards

### Type Safety

Full TypeScript with strict mode enabled. No `any` types except when interfacing with untyped external
libraries, and those MUST be wrapped with proper types at the boundary. Runtime validation MUST occur
at all system boundaries (IPC messages, API responses, file content).

### Performance

- UI interactions MUST feel instant (<100ms response)
- Search results MUST return within 50ms for 10,000 items
- App startup to usable state MUST complete in <3 seconds
- Background sync MUST NEVER block UI thread (use workers or async patterns)
- Smooth 60fps scrolling MUST be maintained with 1000+ items (virtualization required)

### Accessibility

WCAG 2.1 AA compliance minimum. Full keyboard navigation for all features. Screen reader support with
proper ARIA labels. Respect `prefers-reduced-motion` preference. High contrast mode support.

### Error Handling

- Graceful degradation over crashes
- NEVER lose user data under any circumstance
- Clear, actionable error messages (not technical jargon)
- Automatic recovery where possible
- Manual recovery instructions provided where automatic fails

### Defensive Coding

- Validate all external input (IPC messages, file content, API responses)
- Sanitize file paths to prevent directory traversal attacks
- Rate limit operations that could overwhelm system resources
- Timeouts on all async operations to prevent hanging

## Security Requirements

### Encryption Standards

- Content encryption: AES-256-GCM (authenticated encryption)
- Key derivation: Argon2id with secure parameters
- Random generation: Cryptographically secure (crypto.getRandomValues or equivalent)
- No custom cryptography - MUST use audited libraries (libsodium or equivalent)

### Key Management

- Master key MUST be generated randomly on first device setup
- Recovery key (BIP39 mnemonic) shown once; user MUST be instructed to save it
- Device keys derived from master key
- Keys MUST be stored in OS secure storage (Keychain, Credential Manager)
- Keys MUST NEVER be written to disk unencrypted or logged in any form

### Secure Communication

- All network requests MUST use HTTPS/TLS 1.3 or later
- Certificate pinning MUST be implemented for sync server
- No sensitive data in URLs or query parameters

### Audit Requirements

- No plaintext secrets in logs (mask recovery keys, tokens)
- No sensitive data in error reports
- Security-relevant actions MUST be logged (device linking, key rotation)

## Testing Requirements

### Unit Tests

- All utility functions MUST have unit tests
- All data transformations MUST have unit tests
- Aim for >80% code coverage on business logic
- Test edge cases: empty inputs, large inputs, unicode, special characters

### Integration Tests

- Sync logic: conflict resolution, offline queue, retry behavior
- File watching: create, modify, delete, rename detection
- Database operations: CRUD, migrations, corruption recovery
- IPC communication: main <-> renderer message passing

### End-to-End Tests

- Critical user flows: create note, edit, sync to second device
- Offline scenarios: edit offline, come online, verify sync
- Error recovery: network failure mid-sync, app crash during save

### Encryption Tests

- Verify server cannot decrypt content (integration test with mock server)
- Verify same content encrypts to different ciphertext (IV uniqueness)
- Verify key derivation produces consistent results
- Verify recovery key restores access on new device

## Code Style

### Component Architecture

- Functional components with hooks (no class components)
- Single responsibility principle - one component, one job
- Composition over inheritance
- Container/presenter pattern for complex features

### Naming Conventions

- Event handlers prefixed with "handle" (handleClick, handleSave)
- Custom hooks prefixed with "use" (useFileWatcher, useSyncEngine)
- Boolean variables prefixed with "is/has/should" (isLoading, hasError)
- Constants in UPPER_SNAKE_CASE
- Types/Interfaces in PascalCase

### Code Organization

- Colocation: component + hook + types in same directory for features
- Shared utilities in lib/ directory
- Shared types in types/ directory
- Feature-specific code in feature directories

### Documentation

- JSDoc comments for public APIs and complex functions
- README in each major directory explaining purpose
- Inline comments only for "why", not "what"
- Keep documentation close to code (not separate wiki)

## Governance

### Amendment Procedure

1. Propose changes via pull request with rationale
2. All changes MUST be documented with reasoning
3. Major changes (principle removal/redefinition) require explicit stakeholder approval
4. Minor changes (additions, expansions) require code review
5. Patch changes (clarifications, typos) can be merged with single approval

### Compliance Review

- All PRs MUST verify compliance with applicable constitutional principles
- Constitution Check section in plan.md MUST pass before implementation begins
- Complexity violations MUST be documented and justified in Complexity Tracking
- Security-relevant changes MUST undergo additional security review

### Versioning Policy

This constitution follows semantic versioning:
- MAJOR: Backward incompatible governance/principle removals or redefinitions
- MINOR: New principle/section added or materially expanded guidance
- PATCH: Clarifications, wording, typo fixes, non-semantic refinements

**Version**: 1.0.0 | **Ratified**: 2025-12-17 | **Last Amended**: 2025-12-17
