import { and, asc, eq, gt, gte, inArray, ne, or, sql } from 'drizzle-orm'
import {
  extractedText,
  fileTextJobs,
  type ExtractedTextMethod,
  type FileTextJobRow,
  type FileTextJobStatus
} from '@memry/db-schema/schema/extracted-text'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { IndexDb } from '../types'

/** File types the background extractor reads text from. */
export const TEXT_BEARING_FILE_TYPES = ['pdf', 'image'] as const
export type TextBearingFileType = (typeof TEXT_BEARING_FILE_TYPES)[number]

/** The `source` of a filed PDF's or image's own text. */
export const OWN_FILE = ''

/** One file whose text is searchable under a note: its own file, or an attachment. */
export interface TextSourceRef {
  noteId: string
  source: string
}

/** A filed PDF or image, with the vault-relative path the index has for it. */
export interface FiledTextFile {
  noteId: string
  path: string
  fileType: TextBearingFileType
}

/** A job still owed work, with the note it belongs to. */
export interface PendingTextJob extends TextSourceRef {
  signature: string
  notePath: string
  noteFileType: string
}

interface ExtractedPage {
  page: number
  text: string
}

/** Rows read per query when walking a long document's parts. */
const PART_BATCH = 64

const isSource = (ref: TextSourceRef) =>
  and(eq(extractedText.noteId, ref.noteId), eq(extractedText.source, ref.source))

const isJob = (ref: TextSourceRef) =>
  and(eq(fileTextJobs.noteId, ref.noteId), eq(fileTextJobs.source, ref.source))

export function getFileTextJob(db: IndexDb, ref: TextSourceRef): FileTextJobRow | undefined {
  return db.select().from(fileTextJobs).where(isJob(ref)).get()
}

/** Every filed PDF and image in the index, or the ones among `ids`. */
export function listFiledTextFiles(db: IndexDb, ids?: readonly string[]): FiledTextFile[] {
  const byType = inArray(noteCache.fileType, [...TEXT_BEARING_FILE_TYPES])
  return db
    .select({ noteId: noteCache.id, path: noteCache.path, fileType: noteCache.fileType })
    .from(noteCache)
    .where(ids ? and(byType, inArray(noteCache.id, [...ids])) : byType)
    .all() as FiledTextFile[]
}

/** Ids per query, well under SQLite's bound-parameter limit. */
const ID_BATCH = 500

/**
 * The markdown notes among `ids`: the ones that can own an attachments folder.
 * `ids` can be every folder name under `attachments/`, so it is looked up in batches.
 */
export function listMarkdownNotes(
  db: IndexDb,
  ids: readonly string[]
): Array<{ id: string; path: string }> {
  const notes: Array<{ id: string; path: string }> = []
  for (let start = 0; start < ids.length; start += ID_BATCH) {
    const batch = ids.slice(start, start + ID_BATCH)
    notes.push(
      ...db
        .select({ id: noteCache.id, path: noteCache.path })
        .from(noteCache)
        .where(and(inArray(noteCache.id, batch), eq(noteCache.fileType, 'markdown')))
        .all()
    )
  }
  return notes
}

/** Attachment jobs of the given notes, or of every note. */
export function listAttachmentJobs(db: IndexDb, noteIds?: readonly string[]): TextSourceRef[] {
  const attachment = ne(fileTextJobs.source, OWN_FILE)
  return db
    .select({ noteId: fileTextJobs.noteId, source: fileTextJobs.source })
    .from(fileTextJobs)
    .where(noteIds ? and(attachment, inArray(fileTextJobs.noteId, [...noteIds])) : attachment)
    .all()
}

/** The oldest job still owed work. */
export function nextPendingTextJob(db: IndexDb): PendingTextJob | undefined {
  return db
    .select({
      noteId: fileTextJobs.noteId,
      source: fileTextJobs.source,
      signature: fileTextJobs.signature,
      notePath: noteCache.path,
      noteFileType: noteCache.fileType
    })
    .from(fileTextJobs)
    .innerJoin(noteCache, eq(noteCache.id, fileTextJobs.noteId))
    .where(eq(fileTextJobs.status, 'pending'))
    .orderBy(asc(fileTextJobs.updatedAt), asc(fileTextJobs.noteId), asc(fileTextJobs.source))
    .limit(1)
    .get()
}

/**
 * Start a file over: drop its stored text and queue it for the bytes that
 * `signature` describes. One transaction, so a crash never leaves text from
 * the old bytes under the new signature.
 */
export function startFileTextJob(
  db: IndexDb,
  ref: TextSourceRef,
  signature: string,
  appVersion: string
): void {
  const job = {
    signature,
    status: 'pending' as const,
    pageCount: null,
    error: null,
    appVersion,
    updatedAt: new Date().toISOString()
  }
  db.transaction((tx) => {
    tx.delete(extractedText).where(isSource(ref)).run()
    tx.insert(fileTextJobs)
      .values({ ...ref, ...job })
      .onConflictDoUpdate({ target: [fileTextJobs.noteId, fileTextJobs.source], set: job })
      .run()
  })
}

/**
 * Queue a failed job, or a finished one with unreadable parts, again. Its
 * unreadable parts go and the job reads every part it has no row for, so a gap
 * before a good page is read too; the text it did read stays.
 */
export function retryFileTextJob(db: IndexDb, ref: TextSourceRef, appVersion: string): void {
  db.transaction((tx) => {
    tx.delete(extractedText)
      .where(and(isSource(ref), eq(extractedText.method, 'unreadable')))
      .run()
    tx.update(fileTextJobs)
      .set({ status: 'pending', error: null, appVersion, updatedAt: new Date().toISOString() })
      .where(isJob(ref))
      .run()
  })
}

/** Forget a file that is gone: its job and its text. */
export function deleteTextSource(db: IndexDb, ref: TextSourceRef): void {
  db.transaction((tx) => {
    tx.delete(extractedText).where(isSource(ref)).run()
    tx.delete(fileTextJobs).where(isJob(ref)).run()
  })
}

export function setFileTextPageCount(db: IndexDb, ref: TextSourceRef, pageCount: number): void {
  db.update(fileTextJobs).set({ pageCount }).where(isJob(ref)).run()
}

export function finishFileTextJob(
  db: IndexDb,
  ref: TextSourceRef,
  status: Exclude<FileTextJobStatus, 'pending'>,
  error: string | null = null
): void {
  db.update(fileTextJobs)
    .set({ status, error, updatedAt: new Date().toISOString() })
    .where(isJob(ref))
    .run()
}

export function saveExtractedPart(
  db: IndexDb,
  ref: TextSourceRef,
  part: number,
  method: ExtractedTextMethod,
  text: string
): void {
  db.insert(extractedText)
    .values({ ...ref, part, method, text })
    .onConflictDoUpdate({
      target: [extractedText.noteId, extractedText.source, extractedText.part],
      set: { method, text }
    })
    .run()
}

/** The parts a job already stored, so a resumed job reads only the rest. */
export function storedExtractedParts(db: IndexDb, ref: TextSourceRef): Set<number> {
  return new Set(
    db
      .select({ part: extractedText.part })
      .from(extractedText)
      .where(isSource(ref))
      .all()
      .map((row) => row.part)
  )
}

export function hasUnreadableParts(db: IndexDb, ref: TextSourceRef): boolean {
  return (
    db
      .select({ part: extractedText.part })
      .from(extractedText)
      .where(and(isSource(ref), eq(extractedText.method, 'unreadable')))
      .limit(1)
      .get() !== undefined
  )
}

export function countExtractedParts(db: IndexDb, ref: TextSourceRef): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(extractedText)
    .where(isSource(ref))
    .get()
  return row?.count ?? 0
}

interface PartRow {
  source: string
  part: number
  text: string
}

/**
 * A note's non-empty parts in (source, part) order, from `from` on, read a
 * batch at a time so a reader that stops early never loads a whole long scan.
 */
function* iterateParts(
  db: IndexDb,
  noteId: string,
  options: { source?: string; fromPart?: number } = {}
): Generator<PartRow> {
  let after: { source: string; part: number } | null = null
  for (;;) {
    const rows: PartRow[] = db
      .select({ source: extractedText.source, part: extractedText.part, text: extractedText.text })
      .from(extractedText)
      .where(
        and(
          eq(extractedText.noteId, noteId),
          ne(extractedText.text, ''),
          options.source === undefined ? undefined : eq(extractedText.source, options.source),
          options.fromPart === undefined ? undefined : gte(extractedText.part, options.fromPart),
          after
            ? or(
                gt(extractedText.source, after.source),
                and(eq(extractedText.source, after.source), gt(extractedText.part, after.part))
              )
            : undefined
        )
      )
      .orderBy(asc(extractedText.source), asc(extractedText.part))
      .limit(PART_BATCH)
      .all()
    yield* rows
    if (rows.length < PART_BATCH) return
    after = rows[rows.length - 1]
  }
}

/** Everything read for a note so far, own file first, as one searchable string. */
export function getExtractedText(db: IndexDb, noteId: string): string {
  return Array.from(iterateParts(db, noteId), (row) => row.text).join('\n\n')
}

/** The start of a note's extracted text, about `maxChars` long. */
export function readExtractedOpening(db: IndexDb, noteId: string, maxChars: number): string {
  const parts: string[] = []
  let used = 0
  for (const row of iterateParts(db, noteId)) {
    parts.push(row.text)
    used += row.text.length
    if (used >= maxChars) break
  }
  return parts.join('\n\n').slice(0, maxChars)
}

/**
 * A filed file's pages from `fromPage` on, stopping before the page that would
 * take the total past `maxChars`. The first page always comes back, cut to
 * `maxChars`, so one oversized page cannot stall a reader that pages through
 * with `nextPage`.
 */
export function readExtractedPages(
  db: IndexDb,
  noteId: string,
  fromPage: number,
  maxChars: number
): { pages: ExtractedPage[]; nextPage: number | null } {
  const pages: ExtractedPage[] = []
  let used = 0
  for (const row of iterateParts(db, noteId, { source: OWN_FILE, fromPart: fromPage })) {
    if (pages.length > 0 && used + row.text.length > maxChars) {
      return { pages, nextPage: row.part }
    }
    pages.push({ page: row.part, text: row.text.slice(0, maxChars) })
    used += row.text.length
  }
  return { pages, nextPage: null }
}

/**
 * The text read from a note's attachments, one entry per file, cut once the
 * total passes `maxChars`.
 */
export function readAttachmentText(
  db: IndexDb,
  noteId: string,
  maxChars: number
): { files: Array<{ file: string; text: string }>; truncated: boolean } {
  const files: Array<{ file: string; text: string }> = []
  let used = 0
  for (const row of iterateParts(db, noteId)) {
    if (row.source === OWN_FILE) continue
    if (used >= maxChars) return { files, truncated: true }
    const text = row.text.slice(0, maxChars - used)
    used += text.length
    const last = files.at(-1)
    if (last?.file === row.source) last.text += `\n\n${text}`
    else files.push({ file: row.source, text })
  }
  return { files, truncated: false }
}

/** Filed (non-markdown) notes with any extracted text to search or embed. */
export function listFilesWithExtractedText(db: IndexDb): Array<{ id: string; title: string }> {
  return db
    .select({ id: noteCache.id, title: noteCache.title })
    .from(noteCache)
    .where(
      and(
        ne(noteCache.fileType, 'markdown'),
        inArray(
          noteCache.id,
          db
            .selectDistinct({ noteId: extractedText.noteId })
            .from(extractedText)
            .where(ne(extractedText.text, ''))
        )
      )
    )
    .all()
}
