# Memry Constitution Prompt

Run this first to establish governing principles for the entire project.

```
/speckit.constitution

Create governing principles for Memry, a local-first personal knowledge management (PKM) desktop application with mobile sync. The constitution must establish:

## Core Philosophy

### LOCAL-FIRST ARCHITECTURE
User data lives primarily on their device in a vault folder (like Obsidian). The app must work fully offline. Files are plain markdown with YAML frontmatter - editable in any text editor (VS Code, vim, etc.). The app is a window into user's files, not a prison for their data.

### END-TO-END ENCRYPTION (E2EE)
All data synced to servers must be encrypted client-side before transmission. Server stores only encrypted blobs and cannot read user content. Encryption keys never leave user devices. Zero-knowledge architecture - we cannot help recover data if user loses their key.

### NO VENDOR LOCK-IN
Users own their data completely. Notes are .md files, not proprietary formats. Tasks exportable to standard formats. Migration to other tools must be trivial. If Memry disappears tomorrow, users still have all their data.

### PRIVACY BY DESIGN
Minimal metadata exposure. Even sync server knows only: user ID, blob sizes, timestamps - never content, filenames, or structure. No analytics that could identify user behavior patterns. No telemetry without explicit opt-in.

## Technical Principles

### OFFLINE-FIRST
All features must work without internet connection. Sync is an enhancement, not a requirement. Network failures must never cause data loss or corrupt state.

### FILE SYSTEM AS SOURCE OF TRUTH
For notes and journal entries, markdown files are authoritative. SQLite database is cache/index only and must be rebuildable from files at any time. If database corrupts, rebuild from files.

### DATABASE FOR STRUCTURED DATA
Tasks, projects, inbox items, and settings stored in SQLite (synced as encrypted blob). These are inherently structured and don't benefit from plain-text file format.

### EXTERNAL EDIT DETECTION
Must detect changes made outside app (VS Code, Finder rename, git pull) via file watching. User should never have to "refresh" or "reload" - changes appear automatically.

### RENAME TRACKING
Use frontmatter UUIDs to track file identity across renames. File path is display name, UUID is true identity. Renames should never break internal links or references.

### SINGLE SOURCE OF TRUTH
Every piece of data has exactly one authoritative location. No data duplication that could lead to inconsistency. Derived data (search index, caches) clearly marked as rebuildable.

## Quality Standards

### TYPE SAFETY
Full TypeScript with strict mode enabled. No `any` types except when interfacing with untyped external libraries, and those must be wrapped with proper types. Runtime validation at system boundaries (IPC, API responses).

### PERFORMANCE
- UI interactions must feel instant (<100ms response)
- Search results within 50ms for 10,000 items
- App startup to usable state in <3 seconds
- Background sync must never block UI thread
- Smooth 60fps scrolling with 1000+ items (virtualization required)

### ACCESSIBILITY
WCAG 2.1 AA compliance minimum. Full keyboard navigation for all features. Screen reader support with proper ARIA labels. Respect reduced-motion preferences. High contrast mode support.

### ERROR HANDLING
- Graceful degradation over crashes
- Never lose user data under any circumstance
- Clear, actionable error messages (not technical jargon)
- Automatic recovery where possible
- Manual recovery instructions where automatic fails

### DEFENSIVE CODING
- Validate all external input (IPC messages, file content, API responses)
- Sanitize file paths to prevent directory traversal
- Rate limit operations that could overwhelm system
- Timeouts on all async operations

## Security Requirements

### ENCRYPTION STANDARDS
- Content encryption: AES-256-GCM (authenticated encryption)
- Key derivation: Argon2id with secure parameters
- Random generation: Cryptographically secure (crypto.getRandomValues)
- No custom cryptography - use audited libraries (libsodium)

### KEY MANAGEMENT
- Master key generated randomly on first device setup
- Recovery key (BIP39 mnemonic) shown once, user must save
- Device keys derived from master key
- Keys stored in OS secure storage (Keychain, Credential Manager)
- Keys never written to disk unencrypted, never logged

### SECURE COMMUNICATION
- All network requests over HTTPS/TLS 1.3
- Certificate pinning for sync server
- No sensitive data in URLs or query parameters

### AUDIT REQUIREMENTS
- No plaintext secrets in logs (mask recovery keys, tokens)
- No sensitive data in error reports
- Security-relevant actions logged (device linking, key rotation)

## Testing Requirements

### UNIT TESTS
- All utility functions must have unit tests
- All data transformations must have unit tests
- Aim for >80% code coverage on business logic
- Test edge cases: empty inputs, large inputs, unicode, special characters

### INTEGRATION TESTS
- Sync logic: conflict resolution, offline queue, retry behavior
- File watching: create, modify, delete, rename detection
- Database operations: CRUD, migrations, corruption recovery
- IPC communication: main <-> renderer message passing

### END-TO-END TESTS
- Critical user flows: create note, edit, sync to second device
- Offline scenarios: edit offline, come online, verify sync
- Error recovery: network failure mid-sync, app crash during save

### ENCRYPTION TESTS
- Verify server cannot decrypt content (integration test with mock server)
- Verify same content encrypts to different ciphertext (IV uniqueness)
- Verify key derivation produces consistent results
- Verify recovery key restores access on new device

## Code Style

### COMPONENT ARCHITECTURE
- Functional components with hooks (no class components)
- Single responsibility principle - one component, one job
- Composition over inheritance
- Container/presenter pattern for complex features

### NAMING CONVENTIONS
- Event handlers prefixed with "handle" (handleClick, handleSave)
- Custom hooks prefixed with "use" (useFileWatcher, useSyncEngine)
- Boolean variables prefixed with "is/has/should" (isLoading, hasError)
- Constants in UPPER_SNAKE_CASE
- Types/Interfaces in PascalCase

### CODE ORGANIZATION
- Colocation: component + hook + types in same directory for features
- Shared utilities in lib/ directory
- Shared types in types/ directory
- Feature-specific code in feature directories

### DOCUMENTATION
- JSDoc comments for public APIs and complex functions
- README in each major directory explaining purpose
- Inline comments only for "why", not "what"
- Keep documentation close to code (not separate wiki)
```
