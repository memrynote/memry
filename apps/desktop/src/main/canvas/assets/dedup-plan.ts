import type { CanvasAssetRow } from '@memry/db-schema'

export interface DereferencePlan {
  /** contentHashes no longer referenced by this canvas — prune their canvas_assets rows. */
  removedContentHashes: string[]
  /**
   * Removed contentHashes referenced by NO other canvas — the ones actually reaped on the server.
   * A superset relationship holds: these ⊆ removedContentHashes; the difference is shared assets
   * whose local row is pruned but whose server chunks stay (another canvas still references them).
   */
  dereferencedContentHashes: string[]
  /** chunk hashes to dereference on the server — the chunks of `dereferencedContentHashes`. */
  dereferenceChunkHashes: string[]
}

/**
 * Diff a canvas's previously-recorded asset rows against the assets still present in its
 * just-saved scene, and against the union of assets referenced by every OTHER canvas.
 * @param prevRows        canvas_assets rows for THIS canvas (before this save).
 * @param currentContentHashes  contentHashes still present in the saved scene.
 * @param otherCanvasHashes     contentHashes referenced by any OTHER canvas in the vault (the GC union).
 */
export function planDereference(
  prevRows: CanvasAssetRow[],
  currentContentHashes: Set<string>,
  otherCanvasHashes: Set<string>
): DereferencePlan {
  const removed = prevRows.filter((row) => !currentContentHashes.has(row.contentHash))
  const removedContentHashes = removed.map((row) => row.contentHash)
  const orphaned = removed.filter((row) => !otherCanvasHashes.has(row.contentHash))
  const dereferencedContentHashes = orphaned.map((row) => row.contentHash)
  const dereferenceChunkHashes = orphaned.flatMap((row) => row.chunkHashes)
  return { removedContentHashes, dereferencedContentHashes, dereferenceChunkHashes }
}
