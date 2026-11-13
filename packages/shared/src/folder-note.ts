import type { FileType } from './file-types.ts'

/**
 * The folder a note belongs to as that folder's own page: note `X.md` pairs
 * with its sibling folder `X/`. The sidebar draws the two as one row, and the
 * folder view of `X/` lists `X.md` with the folder's contents. A view rule
 * only: nothing on disk, in sync, or in the databases records the pair.
 *
 * The note's path without its extension, so names match exactly, case
 * included. Null for a note that never pairs: a non-markdown file or a
 * journal entry is not a page a folder can belong to.
 */
export function pairedFolderPath(
  notePath: string,
  fileType: FileType | null | undefined,
  isJournal: boolean
): string | null {
  if ((fileType ?? 'markdown') !== 'markdown' || isJournal) return null
  const dot = notePath.lastIndexOf('.')
  return dot > notePath.lastIndexOf('/') + 1 ? notePath.slice(0, dot) : notePath
}
