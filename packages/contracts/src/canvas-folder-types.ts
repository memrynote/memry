/**
 * Canonical canvas-folder identity, shared by contracts, db-schema and SQL.
 *
 * Deliberately Zod-free and dependency-free so db-schema and SQL-adjacent code
 * can import it without pulling the validation surface along.
 *
 * @module contracts/canvas-folder-types
 */

/**
 * Deterministic canvas folder id.
 *
 * Two devices that create `Work/` while offline would otherwise mint two rows
 * for one logical folder and collide on the `(vault_id, path)` unique index at
 * pull time. Deriving the id from the path makes both produce the identical
 * row, so LWW merges it — the same trick `bookmarkSyncId` uses.
 *
 * NFC + lowercase because macOS stores filenames decomposed and both macOS and
 * Windows are case-insensitive: `Work` and `work` are one directory there, and
 * a vault must stay portable across all three platforms.
 *
 * MUST stay character-identical to the SQL in migration 0048.
 */
export function canvasFolderSyncId(path: string): string {
  return `cvf_${path.normalize('NFC').toLowerCase()}`
}
