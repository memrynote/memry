import fs from 'fs'
import path from 'path'
import { and, eq } from 'drizzle-orm'
import { getNoteMetadataById } from '@memry/storage-data'
import { attachmentFiles } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { STORED_PREFIX_RE } from '../vault/attachment-heal'

/**
 * Which note-attachment files this device knows the server has (#2651).
 *
 * Attachment ids are random per upload, so a note that holds references cannot
 * say by itself whether a file on disk is one of them. Uploads and downloads
 * record each file by its vault-relative path. A note seen with references and
 * no record yet is from before the record existed: its files are counted as
 * known instead of uploaded again, which is how the backfill treated such a
 * note before.
 */

/** The `path` of the row that marks a note counted while it had no file on disk. */
const COUNTED_EMPTY = ''

/** `![alt](url)` — an image or media embed. */
const EMBED_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
/** `<!-- file:{"url":…} -->` — the file block marker. */
const FILE_MARKER_RE = /<!--\s*file:(\{.*?\})\s*-->/g
/** `http:`, `data:`, `memry-file:` — anything with a scheme is not a vault path. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

export interface AttachmentNote {
  id: string
  path: string
  attachmentReferences: string[] | null
}

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
 * The vault files a body embeds outside every note's attachments folder. The
 * folder scan owns this note's own folder, and a file in another note's folder
 * is that note's attachment already: queuing it here would upload a second copy
 * under a second id. Folders under `attachments/` that are not named for a note
 * hold ordinary vault files and stay in.
 */
export function embeddedFilesOutsideNoteFolders(
  db: DrizzleDb,
  markdown: string,
  vaultPath: string,
  notePath: string,
  noteId: string
): string[] {
  const attachmentsRoot = path.join(path.resolve(vaultPath), 'attachments') + path.sep
  return referencedVaultFiles(markdown, vaultPath, notePath, noteId).filter((file) => {
    if (!file.startsWith(attachmentsRoot)) return true
    const folder = file.slice(attachmentsRoot.length).split(path.sep)[0]
    return folder !== noteId && !getNoteMetadataById(db, folder)
  })
}

function ownFolderOf(vaultPath: string, noteId: string): string {
  return path.join(path.resolve(vaultPath), 'attachments', noteId)
}

/** The files in a note's own attachments folder. Dotfiles (and partial downloads) are not attachments. */
export function ownFolderFiles(vaultPath: string, noteId: string): string[] {
  const dir = ownFolderOf(vaultPath, noteId)
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

export function existingFiles(files: string[]): string[] {
  return files.filter((file) => {
    try {
      return fs.statSync(file).isFile()
    } catch {
      return false
    }
  })
}

/** Every file a note owns or embeds that is on this disk. */
function noteFilesOnDisk(db: DrizzleDb, vaultPath: string, note: AttachmentNote): string[] {
  const files = ownFolderFiles(vaultPath, note.id)
  if (!note.path.endsWith('.md')) return files
  try {
    const markdown = fs.readFileSync(path.join(vaultPath, note.path), 'utf8')
    return [
      ...files,
      ...existingFiles(embeddedFilesOutsideNoteFolders(db, markdown, vaultPath, note.path, note.id))
    ]
  } catch {
    return files
  }
}

function recordPathOf(vaultPath: string, file: string): string | null {
  const relative = path.relative(path.resolve(vaultPath), path.resolve(file))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

function recordedPaths(db: DrizzleDb, noteId: string): Set<string> {
  return new Set(
    db
      .select({ path: attachmentFiles.path })
      .from(attachmentFiles)
      .where(eq(attachmentFiles.noteId, noteId))
      .all()
      .map((row) => row.path)
  )
}

/** Notes with at least one row: recorded uploads, downloads, or a count. */
export function notesWithRecords(db: DrizzleDb): Set<string> {
  return new Set(
    db
      .selectDistinct({ noteId: attachmentFiles.noteId })
      .from(attachmentFiles)
      .all()
      .map((row) => row.noteId)
  )
}

function insertRecord(
  db: DrizzleDb,
  noteId: string,
  recordPath: string,
  attachmentId: string | null
): void {
  db.insert(attachmentFiles)
    .values({ noteId, path: recordPath, attachmentId, recordedAt: Date.now() })
    .onConflictDoUpdate({
      target: [attachmentFiles.noteId, attachmentFiles.path],
      set: { attachmentId, recordedAt: Date.now() }
    })
    .run()
}

/** Count an older note's files as known. A note with none still gets a row. */
export function countNoteFiles(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  files: string[]
): void {
  const paths = files.flatMap((file) => recordPathOf(vaultPath, file) ?? [])
  if (paths.length === 0) paths.push(COUNTED_EMPTY)
  for (const recordPath of paths) {
    db.insert(attachmentFiles)
      .values({ noteId, path: recordPath, attachmentId: null, recordedAt: Date.now() })
      .onConflictDoNothing()
      .run()
  }
}

/**
 * A file the user or sync renamed inside the note's own folder keeps its
 * stored prefix. A recorded file with the same prefix that is gone from disk
 * is this file under its old name: move the row instead of uploading again.
 */
function takeOverRenamedRecord(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  recordPath: string,
  recorded: Set<string>
): boolean {
  const folder = `attachments/${noteId}/`
  if (!recordPath.startsWith(folder)) return false
  const name = recordPath.slice(folder.length)
  if (!STORED_PREFIX_RE.test(name)) return false
  const prefix = name.slice(0, 7)
  for (const candidate of recorded) {
    if (!candidate.startsWith(folder + prefix)) continue
    if (fs.existsSync(path.join(vaultPath, candidate))) continue
    db.update(attachmentFiles)
      .set({ path: recordPath, recordedAt: Date.now() })
      .where(and(eq(attachmentFiles.noteId, noteId), eq(attachmentFiles.path, candidate)))
      .run()
    recorded.delete(candidate)
    recorded.add(recordPath)
    return true
  }
  return false
}

/**
 * The files among `files` that no record knows, which are the ones to upload.
 * A note with references and no record yet is counted instead, and nothing of
 * it is returned.
 */
export function unrecordedFiles(
  db: DrizzleDb,
  vaultPath: string,
  note: AttachmentNote,
  files: string[]
): string[] {
  const recorded = recordedPaths(db, note.id)
  if (recorded.size === 0 && (note.attachmentReferences ?? []).length > 0) {
    countNoteFiles(db, vaultPath, note.id, files)
    return []
  }
  return files.filter((file) => {
    const recordPath = recordPathOf(vaultPath, file)
    if (recordPath === null || recorded.has(recordPath)) return false
    return !takeOverRenamedRecord(db, vaultPath, note.id, recordPath, recorded)
  })
}

/**
 * The file this device recorded for an attachment of a note, if it is still on
 * disk. An embed from outside the note's folder was uploaded from where it
 * lives, so a download into the note's folder would put a second copy there.
 */
export function recordedFileOf(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  attachmentId: string
): string | null {
  const row = db
    .select({ path: attachmentFiles.path })
    .from(attachmentFiles)
    .where(and(eq(attachmentFiles.noteId, noteId), eq(attachmentFiles.attachmentId, attachmentId)))
    .get()
  if (!row?.path) return null
  const file = path.join(vaultPath, ...row.path.split('/'))
  return fs.existsSync(file) ? file : null
}

/**
 * Record a file the server has: an upload of it succeeded or a download put it
 * here. The first record of an older note counts its other files first, or the
 * next backfill would read every one of them as new.
 */
export function recordAttachmentFile(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  diskPath: string,
  attachmentId: string
): void {
  const recordPath = recordPathOf(vaultPath, diskPath)
  if (recordPath === null) return
  if (recordedPaths(db, noteId).size === 0) {
    const note = getNoteMetadataById(db, noteId)
    const others = (note?.attachmentReferences ?? []).filter((id) => id !== attachmentId)
    if (note && others.length > 0) {
      countNoteFiles(db, vaultPath, noteId, noteFilesOnDisk(db, vaultPath, note))
    }
  }
  insertRecord(db, noteId, recordPath, attachmentId)
}
