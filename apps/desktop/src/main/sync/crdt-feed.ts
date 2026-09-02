/**
 * Shared CRDT body-replace: swap an open note's editor body for new markdown.
 * Used by the vault watcher (external file edits) and template-apply.
 *
 * @module sync/crdt-feed
 */

import { getCrdtProvider, ORIGIN_LOCAL } from './crdt-provider'
import {
  prepareFragmentSeed,
  applyFragmentSeed,
  recordMarkdownSourceInYDoc
} from './blocknote-converter'
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

  // Shares its parse (task-block upgrade included) and both side-channel
  // writes with the initial markdown seed (markdownToYFragment), so an
  // external edit refreshes link-reference definitions/usages (#1909) and
  // CriticMarkup marks the same way a freshly seeded note does, instead of
  // leaving the previous body's copies in place (#1959).
  const prepared = await prepareFragmentSeed(markdown, noteCachePath(noteId))
  if (!prepared) return false

  const fragment = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    applyFragmentSeed(prepared, fragment)
  }, ORIGIN_LOCAL)

  // The file's new bytes are the source from here on: whatever the write-back
  // does not change comes back spelled the way this edit spelled it (#1915).
  await recordMarkdownSourceInYDoc(doc, markdown, 'prosemirror')

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
