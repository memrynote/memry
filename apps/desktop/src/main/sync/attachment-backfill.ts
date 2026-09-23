import fs from 'fs'
import path from 'path'
import { getNoteMetadataById } from '@memry/storage-data'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { getCurrentVaultPath } from '../store'
import { enqueueUpload } from './attachment-outbox'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('AttachmentBackfill')

export interface AttachmentBackfillDeps {
  db: DrizzleDb
  vaultPath: string
}

/**
 * Queue attachments that are on disk but were never offered to the server.
 *
 * The upload path is event-driven: saving an attachment emits, the emit writes
 * an outbox row, the outbox uploads. When the emit itself failed — it did, for
 * every attachment written from the editor between #1606 and this fix — nothing
 * downstream ever learned the file existed. Fixing the emit only helps the next
 * attachment; the ones already written stay on the single device that made
 * them, referenced by a note that every other device can see. This closes that
 * gap on startup so those files are not lost to a window of bad builds.
 *
 * Only notes with NO recorded attachment references are considered. An
 * attachment id is minted randomly per upload, not derived from the bytes, so
 * there is no way to ask "is this particular file already up there?" — a note
 * that has some references would have to re-upload all of its files to be sure,
 * duplicating in R2 whatever was already there. Skipping those notes trades a
 * partial mixed-era note (rare: it needs attachments from both sides of a
 * two-day window) for never wasting a user's storage.
 *
 * Idempotent by construction: once a queued file uploads, the note gains a
 * reference and is skipped from then on. Re-enqueuing an already-queued row is
 * an upsert, so a repeated run before a successful drain costs nothing.
 */
export function backfillUnsyncedAttachmentsWith(deps: AttachmentBackfillDeps): {
  scanned: number
  queued: number
} {
  const attachmentsRoot = path.join(deps.vaultPath, 'attachments')
  let scanned = 0
  let queued = 0

  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(attachmentsRoot, { withFileTypes: true })
  } catch {
    // No attachments folder yet is the normal state of a fresh vault. The
    // bodies can still embed files from elsewhere, so the scan goes on.
  }

  for (const entry of entries) {
    // Each subdirectory is named for the note that owns it. `inbox`, `images`
    // and other non-note folders live here too; they fail the metadata lookup
    // below and drop out on their own.
    if (!entry.isDirectory()) continue

    const noteId = entry.name
    let metadata: ReturnType<typeof getNoteMetadataById>
    try {
      metadata = getNoteMetadataById(deps.db, noteId)
    } catch (error) {
      log.warn('Note metadata lookup failed during backfill', { noteId, error })
      continue
    }
    if (!metadata) continue
    // A local-only note is deliberately not on the server; uploading its
    // attachments would leak exactly what the flag exists to hold back.
    if (metadata.localOnly) continue
    if ((metadata.attachmentReferences ?? []).length > 0) continue

    scanned++

    const noteDir = path.join(attachmentsRoot, noteId)
    let files: fs.Dirent[]
    try {
      files = fs.readdirSync(noteDir, { withFileTypes: true })
    } catch (error) {
      log.warn('Attachment folder unreadable during backfill', { noteId, error })
      continue
    }

    for (const file of files) {
      if (!file.isFile()) continue
      // .DS_Store and friends are not the user's attachments.
      if (file.name.startsWith('.')) continue
      try {
        enqueueUpload(deps.db, noteId, path.join(noteDir, file.name))
        queued++
      } catch (error) {
        log.warn('Failed to queue backfilled attachment', { noteId, error })
      }
    }
  }

  const referenced = backfillReferencedFilesWith(deps)
  scanned += referenced.scanned
  queued += referenced.queued

  if (queued > 0) {
    log.info('Queued attachments that never reached the server', { notes: scanned, files: queued })
  }
  return { scanned, queued }
}

/** `![alt](url)` — an image or media embed. */
const EMBED_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
/** `<!-- file:{"url":…} -->` — the file block marker. */
const FILE_MARKER_RE = /<!--\s*file:(\{.*?\})\s*-->/g
/** `http:`, `data:`, `memry-file:` — anything with a scheme is not a vault path. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * The vault-relative files a note body embeds, as absolute paths.
 *
 * The same two url shapes `resolveAttachment` reads: note-relative, and the
 * root-relative `attachments/<noteId>/…` form. A url with a scheme or a leading
 * slash is not a vault file, and a path that climbs out of the vault is dropped
 * rather than resolved.
 */
export function referencedVaultFiles(
  markdown: string,
  vaultPath: string,
  notePath: string,
  noteId: string
): string[] {
  const urls: string[] = []
  for (const match of markdown.matchAll(EMBED_RE)) urls.push(match[1])
  for (const match of markdown.matchAll(FILE_MARKER_RE)) {
    try {
      const marker = JSON.parse(match[1]) as { url?: unknown }
      if (typeof marker.url === 'string') urls.push(marker.url)
    } catch {
      // A marker that is not JSON is not a file block; leave it alone.
    }
  }

  const root = path.resolve(vaultPath)
  const noteDir = path.dirname(notePath)
  const found = new Set<string>()
  for (const raw of urls) {
    if (HAS_SCHEME.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) continue
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // Not percent-encoded after all; the raw spelling is the path.
    }
    const normalized = decoded.replace(/\\/g, '/')
    const rootRelative =
      normalized === `attachments/${noteId}` || normalized.startsWith(`attachments/${noteId}/`)
    const absolute = path.resolve(root, rootRelative ? '' : noteDir, normalized)
    const relative = path.relative(root, absolute)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    found.add(absolute)
  }
  return [...found]
}

/**
 * Queue the files a note's body embeds from anywhere in the vault.
 *
 * The folder scan above only sees `attachments/<noteId>/`, which is where
 * desktop's own editor stores a file. A note written elsewhere — imported from
 * another app, or a markdown file that points at `images/photo.png` — embeds
 * files that live anywhere, and none of them was ever offered to the server,
 * so every other device drew a placeholder for a picture it could never
 * fetch. Same rule as the folder scan and for the same reason: only a note
 * with no recorded references is considered, because an attachment id is
 * random per upload and there is no asking whether a given file is already
 * up there.
 */
function backfillReferencedFilesWith(deps: AttachmentBackfillDeps): {
  scanned: number
  queued: number
} {
  let scanned = 0
  let queued = 0
  let notes: Array<typeof noteMetadata.$inferSelect>
  try {
    notes = deps.db.select().from(noteMetadata).all()
  } catch (error) {
    log.warn('Note metadata unreadable during referenced-file backfill', { error })
    return { scanned, queued }
  }

  const ownFolderRoot = path.join(path.resolve(deps.vaultPath), 'attachments')
  for (const note of notes) {
    if (note.localOnly) continue
    if ((note.attachmentReferences ?? []).length > 0) continue
    // A binary note's file IS the attachment; it has no body to scan.
    if (!note.path.endsWith('.md')) continue
    let markdown: string
    try {
      markdown = fs.readFileSync(path.join(deps.vaultPath, note.path), 'utf8')
    } catch {
      continue
    }
    const files = referencedVaultFiles(markdown, deps.vaultPath, note.path, note.id).filter(
      // The folder scan owns this note's own folder; queuing it twice is
      // harmless (an upsert) but says the same thing twice.
      (file) => !file.startsWith(path.join(ownFolderRoot, note.id) + path.sep)
    )
    if (files.length === 0) continue
    scanned++
    for (const file of files) {
      try {
        if (!fs.statSync(file).isFile()) continue
      } catch {
        // Referenced and not on this device: nothing to upload.
        continue
      }
      try {
        enqueueUpload(deps.db, note.id, file)
        queued++
      } catch (error) {
        log.warn('Failed to queue a referenced file', { noteId: note.id, error })
      }
    }
  }
  return { scanned, queued }
}

/** The sync runtime's entry point: resolve this vault, then scan it. */
export function backfillUnsyncedAttachments(): { scanned: number; queued: number } {
  const vaultPath = getCurrentVaultPath()
  if (!vaultPath) return { scanned: 0, queued: 0 }
  return backfillUnsyncedAttachmentsWith({ db: getDatabase(), vaultPath })
}
