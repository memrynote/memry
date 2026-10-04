/**
 * Feed a main-originated markdown edit into a note's CRDT body — including a
 * note whose doc is NOT currently open.
 *
 * `replaceNoteBodyInCrdt` alone is only half the job for a closed note: the
 * Y.Doc persisted when the note was last closed still carries the OLD body,
 * `seedFromMarkdown` seeds an EMPTY fragment only, and nothing re-reads the
 * file afterwards — reopening the note would show the body from before the
 * edit while the vault file on disk holds the new one, and that stale body is
 * what syncs to every other device. So when no editor holds the note, the
 * persisted doc is opened (`skipSeed`), fed, and closed again.
 *
 * An empty doc is not fed. With a store, it means the note has no CRDT body
 * yet and its next open seeds from the file. With no store, every closed doc
 * opens empty, and so does an open one whose server merge has not landed yet;
 * a body fed into it shares no Yjs items with the server body and pushes a
 * second copy (#2536). The note then owes its file body (#2646): a marker, and
 * a full-state outbox row whose flush merges the server body and applies the
 * file on top of it (`takeOwedFile`). A large-file-class body is never owed,
 * since no doc can take it.
 *
 * Used by every main-process body writer: the note command (the agent note
 * tool, `notes.update`, template apply, inbox filing), version restore,
 * appended blocks, task-line removal, a rename's link and embed rewrites, the
 * vault watcher for out-of-app edits, and the write-back's ingest of a changed
 * file. Lives apart from `crdt-feed.ts` so `replaceNoteBodyInCrdt` stays a
 * cross-module call the watcher tests can observe.
 *
 * @module sync/crdt-external-feed
 */

import type * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writingFrontmatterOf, type WritingFrontmatter } from '@memry/shared'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { getCrdtProvider } from './crdt-provider'
import { replaceDocBody, replaceDocTags, replaceNoteBodyInCrdt } from './crdt-feed'
import { wasRecentNetworkUpdate } from './crdt-writeback'
import { clearOwedFileBody, recordOwedFileBody } from './crdt-owed-file-body'
import { serializeNoteBody } from './writing-markdown'
import { loadBlockNoteConverter } from './blocknote-converter-loader'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { createSnapshot } from '../vault/notes'
import { extractTags, parseNote, serializeNote } from '../vault/frontmatter'

const log = createLogger('CrdtExternalFeed')

// Full fragment replace: lossy re Yjs history, but these edits round-trip
// through markdown, which destroys that history anyway.
//
// Resolves true when the markdown is now the doc's body.
export async function feedExternalEditToCrdt(
  noteId: string,
  markdownContent: string,
  writing?: WritingFrontmatter
): Promise<boolean> {
  const provider = getCrdtProvider()
  const mergesServerFirst = !provider.hasPersistence() && !provider.isNoteLocalOnly(noteId)
  const isEmpty = (doc: Y.Doc): boolean => doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0

  const feed = async (): Promise<boolean> => {
    if (wasRecentNetworkUpdate(noteId)) {
      broadcastToAllWindows('sync:concurrent-edit', { noteId })
    }

    const fed = await replaceNoteBodyInCrdt(noteId, markdownContent, writing)
    if (fed) clearOwedFileBody(noteId)
    return fed
  }

  const held = provider.getDoc(noteId)
  if (held && !(mergesServerFirst && isEmpty(held))) {
    return feed()
  }

  const doc = held ?? (await provider.open(noteId, undefined, { skipSeed: true }))
  try {
    if (!isEmpty(doc)) return await feed()

    if (mergesServerFirst && classifyMarkdownContent(markdownContent).sizeClass !== 'large-file') {
      recordOwedFileBody(noteId)
      provider.recordOwedFullState(noteId)
    }
    return false
  } finally {
    // Only if it is still editor-less: the renderer may have opened the note
    // while the replace was in flight, and that doc belongs to the editor now.
    if (!held) await provider.closeIfInactive(noteId)
  }
}

/**
 * Apply the vault file of a note that owes it (#2646) to a doc that has merged
 * the server body, then clear the marker. Resolves true when the doc took the
 * file.
 *
 * There is no base to merge from, so the file wins whole, tags included. The
 * loser is never silent. A server body the file does not match, a peer's edit
 * the file never saw for instance, is kept as a version. A file the doc
 * refuses (large-file class, unparseable) is kept as a version and the server
 * body stays, so the note converges instead of staying apart.
 */
export async function takeOwedFile(
  noteId: string,
  doc: Y.Doc,
  file: { path: string; raw: string; title: string }
): Promise<boolean> {
  const parsed = parseNote(file.raw, file.path)
  const converter = await loadBlockNoteConverter()
  const serverBody =
    (await serializeNoteBody(doc, { notePath: file.path }, converter))?.markdown ?? ''
  const took = await replaceDocBody(
    doc,
    noteId,
    parsed.content,
    writingFrontmatterOf(parsed.frontmatter)
  )
  clearOwedFileBody(noteId)

  if (!took) {
    keepVersion(noteId, file.raw, file.title)
    log.warn('The doc refused the vault file it was owed; kept the file as a version', { noteId })
    return false
  }

  replaceDocTags(doc, extractTags(parsed.frontmatter))
  if (serverBody.trim() !== '' && serverBody.trim() !== parsed.content.trim()) {
    keepVersion(noteId, serializeNote(parsed.frontmatter, serverBody), file.title)
    log.warn('Applied the vault file over a server body it did not match; kept that as a version', {
      noteId
    })
    broadcastToAllWindows('sync:concurrent-edit', { noteId })
  }
  return true
}

function keepVersion(noteId: string, fileContent: string, title: string): void {
  try {
    createSnapshot(noteId, fileContent, title, SnapshotReasons.SIGNIFICANT)
  } catch (err) {
    log.error('Could not keep a version of the replaced body', { noteId, error: err })
  }
}
