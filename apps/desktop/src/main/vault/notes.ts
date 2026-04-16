/**
 * Facade re-exporting CRUD, rename, versioning, and IO utilities for vault notes.
 * Source split per .claude/plans/tech-debt-remediation.md Phase 3.1.
 *
 * @module vault/notes
 */

export * from './notes-io'
export * from './notes-crud'
export * from './notes-queries'
export * from './notes-rename'
export * from './notes-versions'
