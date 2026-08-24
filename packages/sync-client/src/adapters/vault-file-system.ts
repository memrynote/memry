/**
 * Seam 6 — the vault on disk: where it lives, and what is inside it.
 *
 * Widened from the decision record's `VaultDirectory` (owner decision,
 * 2026-08-23). The record's version resolved and provisioned vault ROOTS only,
 * which left the ~20 files that read and write note markdown, journals,
 * large-note overflow and CRDT write-back with no legal way to express
 * themselves in platform-free code — `AttachmentStore` is keyed by attachment
 * id, and `CrdtStorePath` is the CRDT store's location. Roots and contents are
 * the same concern at the same boundary, so they became one seam rather than
 * an eleventh.
 *
 * The content half is deliberately the shape of the existing
 * `NoteContentStore` (`packages/storage-vault/src/note-content-store.ts`):
 * relative paths, async, atomic writes. Desktop already implements it over
 * `node:fs`, and spec task T033/T034 already commits mobile to implementing the
 * same interface, so this seam formalises a contract both shells were heading
 * for anyway.
 *
 * Every path is **relative to the vault root** and uses `/` separators.
 * Absolute paths never cross this interface: they are the one thing that cannot
 * mean the same thing on both shells.
 */
export interface LocalVault {
  vaultId: string
  root: string
}

export interface VaultDirEntry {
  /** Path relative to the vault root, `/`-separated. */
  path: string
  kind: 'file' | 'directory'
}

export interface VaultFileSystemAdapter {
  // --- roots (the original VaultDirectory surface) ---

  resolveVaultRoot(vaultId: string): Promise<string>
  listLocalVaults(): Promise<LocalVault[]>
  /**
   * New-device path. Must not dead-end: the vault picker's "primary folder was
   * never provisioned" failure is exactly what this contract exists to forbid.
   */
  provision(vaultId: string): Promise<string>

  // --- contents ---

  readFile(vaultId: string, relPath: string): Promise<string | null>
  readBytes(vaultId: string, relPath: string): Promise<Uint8Array | null>
  /**
   * Atomic: the implementation writes a temp file and renames it into place, so
   * a crash mid-write can never leave a half-written note. Parent directories
   * are created as needed — callers do not get a separate `mkdir`, because a
   * write that has to be preceded by one is a write that can be interrupted
   * between the two.
   */
  writeFile(vaultId: string, relPath: string, content: string): Promise<void>
  writeBytes(vaultId: string, relPath: string, bytes: Uint8Array): Promise<void>
  exists(vaultId: string, relPath: string): Promise<boolean>
  /** Resolves `false` when there was nothing to remove. Never throws for absence. */
  remove(vaultId: string, relPath: string): Promise<boolean>
  /**
   * Rename or move within the vault. Creates the destination's parents.
   * This is the note-rename path, so it must be atomic where the platform
   * allows it.
   */
  rename(vaultId: string, fromRelPath: string, toRelPath: string): Promise<void>
  /** Non-recursive. Missing directory resolves to `[]` rather than throwing. */
  list(vaultId: string, relDir: string): Promise<VaultDirEntry[]>
  /**
   * Remove a directory only if it holds nothing but the caller-supplied junk
   * names (`.DS_Store` and friends). Used by the empty-folder cleanup after a
   * note move; a plain recursive delete here would be a data-loss bug.
   */
  removeDirIfEmpty(
    vaultId: string,
    relDir: string,
    ignoring: ReadonlyArray<string>
  ): Promise<boolean>
}
