/**
 * The write-back's take of a file edited outside the app (#5292, #5319,
 * #5605): before a pass writes over it, and at a doc's first open in a
 * session (`ingestOfflineEdit`). A file written from a doc its store may never
 * have held is checked at every open while it carries the mark, and taken in
 * when it holds what the store lacks (#5698, `takesUnstoredFile`).
 *
 * @module sync/crdt-writeback-ingest
 */

import type * as Y from 'yjs'
import { writingFrontmatterOf } from '@memry/shared'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'
import { isBinaryNoteRow } from '@memry/shared/file-types'
import { SnapshotReasons } from '@memry/db-schema/schema/notes-cache'
import { getNoteCacheById } from '@main/database/queries/notes'
import { createLogger } from '../lib/logger'
import { readVaultFile } from '../lib/paths'
import { restoreLockedNoteFile } from '../vault-locks/service'
import { parseNote, serializeNote, type ParsedNote } from '../vault/frontmatter'
import { getVaultRoot, toAbsolutePath } from '../vault/notes-io'
import { createSnapshot } from '../vault/notes-versions'
import { syncNoteToCache, refusesCaseTwinFile } from '../vault/note-sync'
import { flushProjectionEvents } from '../projections'
import { getIndexDatabase } from '../database/client'
import { feedExternalEditToCrdt } from './crdt-external-feed'
import { readyWritebackConverter } from './converter-worker-bridge'
import {
  holdsUnstoredFile,
  isOutsideEdit,
  recordBaseline,
  takesUnstoredFile
} from './writeback-baseline'

const log = createLogger('CrdtWriteback')

/**
 * Keeps the file a pass would have written as a version before an outside
 * edit replaces the doc's body, when the doc's body differs from the file's:
 * the rule `takeOwedFile` keeps the server body by (#2646). The pass was armed
 * by typing or a peer's edit that the file lacks, and the feed erases it (#5605).
 * False when the version could not be saved; the ingest then waits for a later
 * pass, and the doc and the file both keep what they hold.
 */
function keepDocVersionBeforeIngest(
  noteId: string,
  title: string,
  fileBody: string,
  pass: { body: string; file: string }
): boolean {
  const docBody = pass.body.trim()
  if (
    docBody === '' ||
    docBody === fileBody.trim() ||
    classifyMarkdownContent(fileBody).sizeClass === 'large-file'
  ) {
    return true
  }
  try {
    const snap = createSnapshot(noteId, pass.file, title, SnapshotReasons.SIGNIFICANT)
    if (snap)
      log.info('Version kept before taking an outside edit', { noteId, snapshotId: snap.id })
    return true
  } catch (err) {
    log.error('Could not keep a version of the doc; the outside edit waits', { noteId, error: err })
    return false
  }
}

/**
 * Takes in a file that changed outside the app before a write-back writes
 * over it (`writebackExisting` explains why). Resolves true when the
 * write-back must stop: a locked note's file was restored, or the doc was fed
 * (or refused) the edit, so the next pass writes from a doc that holds it.
 * `pass` is the body the pass serialized and the file it would have written.
 * `unstored`: the open found the file holds bytes the stored doc lacks
 * (`takesUnstoredFile`), so it is taken in although its hash is the baseline.
 */
export async function ingestOutsideEditFirst(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  cached: NonNullable<ReturnType<typeof getNoteCacheById>>,
  existingRaw: string,
  parsed: ParsedNote,
  pass?: { body: string; file: string },
  unstored = false
): Promise<boolean> {
  if (!cached.contentHash) return false
  if (!unstored && !isOutsideEdit(indexDb, noteId, cached, existingRaw)) return false
  // A locked note's outside edit is never taken in: its locked text goes
  // back on disk and the edit is kept as a version (#2606).
  if (await restoreLockedNoteFile(noteId, existingRaw)) return true
  // A file shared with a case twin is never taken in by either note (#5297).
  if (refusesCaseTwinFile(getVaultRoot(), cached.path, noteId)) return true
  if (pass && !keepDocVersionBeforeIngest(noteId, cached.title, parsed.content, pass)) return true
  const ingested = await feedExternalEditToCrdt(
    noteId,
    parsed.content,
    writingFrontmatterOf(parsed.frontmatter)
  )
  // The index row moves to the new bytes only once the doc holds them.
  // Moved first, the next pass would write a doc that never saw them. The
  // feed waited for the store, so the bytes are the baseline.
  if (ingested) {
    recordBaseline(indexDb, noteId, existingRaw)
    syncNoteToCache(
      indexDb,
      {
        id: noteId,
        path: cached.path,
        fileContent: existingRaw,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content,
        title: cached.title,
        createdAt: cached.createdAt,
        modifiedAt: cached.modifiedAt,
        localOnly: cached.localOnly ?? false,
        emoji: cached.emoji ?? null
      },
      { isNew: false }
    )
    void flushProjectionEvents()
  }
  log.warn(
    ingested
      ? 'Write-back deferred: ingested the file that changed outside the app'
      : 'Write-back skipped: the file changed outside the app',
    { noteId, path: cached.path }
  )
  return true
}

/**
 * The doc's body, and the file a pass would write from it under `parsed`'s
 * header: the version an unstored ingest keeps first. Null when the doc cannot
 * be written as markdown.
 */
async function docVersionOf(
  doc: Y.Doc,
  notePath: string,
  parsed: ParsedNote
): Promise<{ body: string; file: string } | null> {
  const convert = await readyWritebackConverter()
  const conversion = await convert(doc, notePath, async () => parsed.content)
  if (conversion.kind === 'unrepresentable' || conversion.body === null) return null
  const { markdown } = conversion.body
  return { body: markdown, file: serializeNote(parsed.frontmatter, markdown) }
}

/**
 * The write-back's outside-edit ingest, run at a doc's first open in a session
 * and at every open while the file is marked unstored (#5319, #5698,
 * `takeOfflineEdit`, `takesUnstoredFile`). Resolves true, taking nothing, for
 * a marked file the doc lacks when `waitsForServer` answers that the server
 * may hold its text: the caller decides it after the merge.
 */
export async function ingestOfflineEdit(
  noteId: string,
  doc: Y.Doc,
  waitsForServer: () => boolean
): Promise<boolean> {
  const indexDb = getIndexDatabase()
  const cached = getNoteCacheById(indexDb, noteId)
  // A binary note's file is its blob, never an outside edit of the body (#5412).
  if (!cached || isBinaryNoteRow(cached)) return false
  const raw = cached.contentHash ? await readVaultFile(getVaultRoot(), cached.path) : null
  if (raw === null) return false
  // A file written from a doc its store may never have held is taken in only
  // when it holds something the store lacks (`takesUnstoredFile`, #5698).
  const unstored = holdsUnstoredFile(cached)
  const takes = unstored
    ? takesUnstoredFile(indexDb, noteId, cached, raw, doc)
    : isOutsideEdit(indexDb, noteId, cached, raw)
  if (!takes) return false
  if (unstored && waitsForServer()) return true
  const parsed = parseNote(raw, toAbsolutePath(cached.path))
  // The doc may hold edits the file lacks: it is kept as a version before
  // the file replaces its body (#5698).
  let pass: { body: string; file: string } | undefined
  if (unstored) {
    const version = await docVersionOf(doc, cached.path, parsed)
    if (!version) {
      // The write-back keeps the file too: it never writes a doc it cannot convert.
      log.warn('Could not keep the doc as a version; the doc and the file keep what they hold', {
        noteId
      })
      return false
    }
    pass = version
  }
  await ingestOutsideEditFirst(indexDb, noteId, cached, raw, parsed, pass, unstored)
  return false
}
