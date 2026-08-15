/**
 * Shared CRDT body-replace: swap an open note's editor body for new markdown.
 * Used by the vault watcher (external file edits) and template-apply.
 *
 * @module sync/crdt-feed
 */

import { getCrdtProvider, ORIGIN_LOCAL } from './crdt-provider'
import { markdownToBlocks, blocksToYFragment } from './blocknote-converter'
import { normalizeTaskBlocks } from '@memry/shared/task-block'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'
import { getIndexDatabase } from '../database'
import { getNoteCacheById } from '@main/database/queries/notes'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtFeed')

/**
 * The note's vault-relative path, so embed targets are rewritten relative to it
 * rather than as this machine's absolute paths. Unknown notes resolve to
 * undefined, which keeps the previous absolute-URL behaviour.
 */
function noteCachePath(noteId: string): string | undefined {
  try {
    return getNoteCacheById(getIndexDatabase(), noteId)?.path
  } catch {
    return undefined
  }
}

/**
 * Full XML-fragment replace of a note's body inside its live Y.Doc.
 * No-op (returns false) when the doc is not open, the markdown is large-file
 * class, or the markdown is unparseable.
 * Lossy re: Yjs history, but round-tripping through markdown discards it anyway.
 */
export async function replaceNoteBodyInCrdt(noteId: string, markdown: string): Promise<boolean> {
  const provider = getCrdtProvider()
  const doc = provider.getDoc(noteId)
  if (!doc) return false

  // The other markdown → Y.Doc door, alongside the seed in `crdt-provider`, and
  // the one a receiver walks through: an oversized note arriving over sync gets
  // written back to disk, the watcher sees that write and feeds the file
  // straight back in here. `markdownToBlocks` below is the parse that froze the
  // sending device, so the receiver must refuse it for the same reason.
  const classification = classifyMarkdownContent(markdown)
  if (classification.sizeClass === 'large-file') {
    log.warn('Refusing to replace a note body with large-file-class markdown', {
      noteId,
      reason: classification.reason,
      fileBytes: classification.fileBytes,
      largestBlockBytes: classification.largestBlockBytes
    })
    return false
  }

  const blocks = await markdownToBlocks(markdown, noteCachePath(noteId))
  if (!blocks) return false

  // Same upgrade the initial markdown seed does (markdownToYFragment): without
  // it a `- [ ] … {task:id}` line lands in the fragment as a raw checkbox and
  // the open note paints a checkbox with the id suffix showing, instead of the
  // task row. In CRDT mode the renderer trusts the fragment and never
  // re-normalizes, so this is the only place it can happen.
  const normalized = normalizeTaskBlocks(blocks).blocks

  const fragment = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(normalized, fragment)
  }, ORIGIN_LOCAL)

  return true
}

/**
 * Replace a note's Y.Doc tag array to match a given tag list.
 * No-op (returns false) when the doc is not open.
 * Used after a FULL-mode template apply so the CRDT writeback (which treats
 * the Y.Doc tag array as authoritative) doesn't revert file tags.
 */
export function replaceNoteTagsInCrdt(noteId: string, tags: string[]): boolean {
  const provider = getCrdtProvider()
  const doc = provider.getDoc(noteId)
  if (!doc) return false

  const tagArray = doc.getArray('tags')
  doc.transact(() => {
    tagArray.delete(0, tagArray.length)
    if (tags.length > 0) tagArray.push(tags)
  }, ORIGIN_LOCAL)

  return true
}
