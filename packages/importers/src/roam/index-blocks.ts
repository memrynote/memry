/**
 * Phase 1 — build the uid index.
 *
 * Walks every page and every block (recursively) and records, for each block
 * uid, the title of the page that contains it plus the block's raw text. This
 * index is what phase 3 uses to resolve `((uid))` block references.
 */

import type { BlockIndex, RoamBlock, RoamPage } from './types.ts'

function indexBlock(block: RoamBlock, pageTitle: string, index: BlockIndex): void {
  if (block.uid) {
    index.set(block.uid, { pageTitle, text: block.string ?? '' })
  }
  for (const child of block.children ?? []) {
    indexBlock(child, pageTitle, index)
  }
}

/** Build a `uid → { pageTitle, text }` index across all pages. */
export function indexBlocks(pages: RoamPage[]): BlockIndex {
  const index: BlockIndex = new Map()
  for (const page of pages) {
    for (const block of page.children ?? []) {
      indexBlock(block, page.title, index)
    }
  }
  return index
}
