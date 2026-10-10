import fs from 'fs'
import path from 'path'
import { and, eq } from 'drizzle-orm'
import { getNoteMetadataById, getNoteMetadataByPath } from '@memry/storage-data'
import { attachmentFiles } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { getFileType } from '@memry/shared/file-types'
import { hasPendingUpload } from './attachment-outbox'
import { STORED_PREFIX_RE } from '../vault/attachment-heal'
import { readVaultFile, readVaultFileSync, resolveVaultFile } from '../lib/paths'
import { OutsideVaultError } from '../lib/errors'
import { createLogger } from '../lib/logger'

const logger = createLogger('AttachmentFiles')

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
 * hold ordinary vault files and stay in. A file note that has uploaded or queued
 * its own bytes stays out (#2812).
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
    if (!file.startsWith(attachmentsRoot)) {
      const recordPath = recordPathOf(vaultPath, file)
      const fileNote = recordPath === null ? undefined : getNoteMetadataByPath(db, recordPath)
      return !fileNote?.attachmentId && !(fileNote && hasPendingUpload(db, fileNote.id, file))
    }
    const folder = file.slice(attachmentsRoot.length).split(path.sep)[0]
    return folder !== noteId && !getNoteMetadataById(db, folder)
  })
}

function ownFolderOf(vaultPath: string, noteId: string): string {
  return path.join(path.resolve(vaultPath), 'attachments', noteId)
}

/**
 * The attachments of a note that may already hold a file's bytes (#2755). A
 * file outside the note's own folder can be a copy of one of them: a download
 * kept where it landed, or the same file a second device holds outside Memry.
 * The note's own folder holds editor saves and downloads, so it gets none.
 */
export function reusableAttachmentIds(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  filePath: string
): string[] {
  if (path.resolve(filePath).startsWith(ownFolderOf(vaultPath, noteId) + path.sep)) return []
  return getNoteMetadataById(db, noteId)?.attachmentReferences ?? []
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
    const markdown = readVaultFileSync(vaultPath, note.path)
    if (markdown === null) return files
    return [
      ...files,
      ...existingFiles(embeddedFilesOutsideNoteFolders(db, markdown, vaultPath, note.path, note.id))
    ]
  } catch (err) {
    if (err instanceof OutsideVaultError) {
      logger.warn('Note file points outside the vault; its embeds are not counted', {
        noteId: note.id
      })
    }
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

function moveRecord(db: DrizzleDb, noteId: string, from: string, to: string): void {
  db.delete(attachmentFiles)
    .where(and(eq(attachmentFiles.noteId, noteId), eq(attachmentFiles.path, to)))
    .run()
  db.update(attachmentFiles)
    .set({ path: to, recordedAt: Date.now() })
    .where(and(eq(attachmentFiles.noteId, noteId), eq(attachmentFiles.path, from)))
    .run()
}

async function pathExists(file: string): Promise<boolean> {
  return fs.promises.lstat(file).then(
    () => true,
    () => false
  )
}

/** Nothing is at `target`, and the nearest folder of it that exists is really inside the vault. */
async function isFreeInsideVault(vaultPath: string, target: string): Promise<boolean> {
  if (await pathExists(target)) return false
  let dir = path.dirname(target)
  while (!(await pathExists(dir))) dir = path.dirname(dir)
  const relative = path.relative(path.resolve(vaultPath), dir)
  return (await resolveVaultFile(vaultPath, relative)).kind === 'inside'
}

/**
 * The vault path the body links a file in the note's own folder under, when
 * that is the one embed outside the note folders with its name, nothing is
 * there and it is inside the vault. A file the body also links where it is
 * stays, and so does a type the vault lists as a note of its own: that one
 * reaches its path through its own sync, and a copy there first would be
 * listed as a second note.
 */
async function linkedPathOf(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  file: string
): Promise<string | null> {
  const name = path.basename(file)
  if (getFileType(path.extname(name)) !== null) return null
  const note = getNoteMetadataById(db, noteId)
  if (!note?.path.endsWith('.md')) return null
  const markdown = await readVaultFile(vaultPath, note.path)
  if (markdown === null) return null
  if (referencedVaultFiles(markdown, vaultPath, note.path, noteId).includes(path.resolve(file))) {
    return null
  }
  const linked = embeddedFilesOutsideNoteFolders(db, markdown, vaultPath, note.path, noteId).filter(
    (embed) => path.basename(embed) === name
  )
  if (linked.length !== 1) return null
  return (await isFreeInsideVault(vaultPath, linked[0])) ? linked[0] : null
}

/**
 * Move a file an embed download put in the note's own folder to where the body
 * links it (#2755), and its record with it. The manifest names the file by the
 * basename it was uploaded from, so a body linking `sources/x.txt` got
 * `attachments/<noteId>/x.txt` and a broken link. The body is never rewritten.
 * Returns where the file is.
 */
export async function placeDownloadedFile(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  downloadedPath: string
): Promise<string> {
  const from = recordPathOf(vaultPath, downloadedPath)
  let target: string | null
  let to: string | null
  try {
    target = await linkedPathOf(db, vaultPath, noteId, downloadedPath)
    to = target && recordPathOf(vaultPath, target)
    if (!from || !target || !to) return downloadedPath
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    // A link fails on a name that is taken, where a rename would replace it.
    await fs.promises.link(downloadedPath, target)
    try {
      await fs.promises.unlink(downloadedPath)
    } catch (error) {
      await fs.promises.unlink(target)
      throw error
    }
  } catch (error) {
    logger.warn('Could not move a downloaded attachment to its linked path', { noteId, error })
    return downloadedPath
  }
  try {
    moveRecord(db, noteId, from, to)
  } catch (error) {
    logger.warn('Could not move the record of a placed attachment', { noteId, error })
  }
  return target
}

/**
 * Place the files sync downloaded into a note's own folder, once its body is
 * on disk. A download can land before the body that links it arrives.
 */
export async function placeLinkedDownloads(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string
): Promise<void> {
  const folder = `attachments/${noteId}/`
  const downloads = db
    .select({ path: attachmentFiles.path })
    .from(attachmentFiles)
    .where(eq(attachmentFiles.noteId, noteId))
    .all()
    .filter((row) => row.path.startsWith(folder) && getFileType(path.extname(row.path)) === null)
  for (const row of downloads) {
    await placeDownloadedFile(db, vaultPath, noteId, path.join(vaultPath, ...row.path.split('/')))
  }
}
