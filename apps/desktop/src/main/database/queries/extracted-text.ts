import { and, asc, eq, gte, inArray, ne, sql } from 'drizzle-orm'
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
type TextBearingFileType = (typeof TEXT_BEARING_FILE_TYPES)[number]

export interface FileTextCandidate {
  id: string
  path: string
  fileType: TextBearingFileType
}

interface ExtractedPage {
  page: number
  text: string
}

export function getFileTextJob(db: IndexDb, noteId: string): FileTextJobRow | undefined {
  return db.select().from(fileTextJobs).where(eq(fileTextJobs.noteId, noteId)).get()
}

/** Every filed PDF and image in the index. */
export function listFileTextCandidates(db: IndexDb, ids?: readonly string[]): FileTextCandidate[] {
  const byType = inArray(noteCache.fileType, [...TEXT_BEARING_FILE_TYPES])
  return db
    .select({ id: noteCache.id, path: noteCache.path, fileType: noteCache.fileType })
    .from(noteCache)
    .where(ids ? and(byType, inArray(noteCache.id, [...ids])) : byType)
    .all() as FileTextCandidate[]
}

/** The oldest job still owed work, with the file it belongs to. */
export function nextPendingFileTextJob(
  db: IndexDb
): (FileTextCandidate & { signature: string }) | undefined {
  return db
    .select({
      id: noteCache.id,
      path: noteCache.path,
      fileType: noteCache.fileType,
      signature: fileTextJobs.signature
    })
    .from(fileTextJobs)
    .innerJoin(noteCache, eq(noteCache.id, fileTextJobs.noteId))
    .where(eq(fileTextJobs.status, 'pending'))
    .orderBy(asc(fileTextJobs.updatedAt), asc(fileTextJobs.noteId))
    .limit(1)
    .get() as (FileTextCandidate & { signature: string }) | undefined
}

/**
 * Start a file over: drop its stored text and queue it for the bytes that
 * `signature` describes. One transaction, so a crash never leaves text from
 * the old bytes under the new signature.
 */
export function startFileTextJob(
  db: IndexDb,
  noteId: string,
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
    tx.delete(extractedText).where(eq(extractedText.noteId, noteId)).run()
    tx.insert(fileTextJobs)
      .values({ noteId, ...job })
      .onConflictDoUpdate({ target: fileTextJobs.noteId, set: job })
      .run()
  })
}

/**
 * Queue a failed job again. Its unreadable parts go, so the job resumes at the
 * first of them; the text it did read stays.
 */
export function retryFileTextJob(db: IndexDb, noteId: string, appVersion: string): void {
  db.transaction((tx) => {
    tx.delete(extractedText)
      .where(and(eq(extractedText.noteId, noteId), eq(extractedText.method, 'unreadable')))
      .run()
    tx.update(fileTextJobs)
      .set({ status: 'pending', error: null, appVersion, updatedAt: new Date().toISOString() })
      .where(eq(fileTextJobs.noteId, noteId))
      .run()
  })
}

export function setFileTextPageCount(db: IndexDb, noteId: string, pageCount: number): void {
  db.update(fileTextJobs).set({ pageCount }).where(eq(fileTextJobs.noteId, noteId)).run()
}

export function finishFileTextJob(
  db: IndexDb,
  noteId: string,
  status: Exclude<FileTextJobStatus, 'pending'>,
  error: string | null = null
): void {
  db.update(fileTextJobs)
    .set({ status, error, updatedAt: new Date().toISOString() })
    .where(eq(fileTextJobs.noteId, noteId))
    .run()
}

export function saveExtractedPart(
  db: IndexDb,
  noteId: string,
  part: number,
  method: ExtractedTextMethod,
  text: string
): void {
  db.insert(extractedText)
    .values({ noteId, part, method, text })
    .onConflictDoUpdate({
      target: [extractedText.noteId, extractedText.part],
      set: { method, text }
    })
    .run()
}

/** The part a resumed job continues from: one past the last one stored. */
export function nextExtractedPart(db: IndexDb, noteId: string): number {
  const row = db
    .select({ last: sql<number | null>`MAX(${extractedText.part})` })
    .from(extractedText)
    .where(eq(extractedText.noteId, noteId))
    .get()
  return (row?.last ?? 0) + 1
}

export function countExtractedParts(db: IndexDb, noteId: string): number {
  const row = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(extractedText)
    .where(eq(extractedText.noteId, noteId))
    .get()
  return row?.count ?? 0
}

/** Everything read from a note so far, in part order, as one searchable string. */
export function getExtractedText(db: IndexDb, noteId: string): string {
  return db
    .select({ text: extractedText.text })
    .from(extractedText)
    .where(and(eq(extractedText.noteId, noteId), ne(extractedText.text, '')))
    .orderBy(asc(extractedText.part))
    .all()
    .map((row) => row.text)
    .join('\n\n')
}

/**
 * Pages from `fromPage` on, stopping before the page that would take the total
 * past `maxChars`. The first page always comes back, cut to `maxChars`, so one
 * oversized page cannot stall a reader that pages through with `nextPage`.
 */
export function readExtractedPages(
  db: IndexDb,
  noteId: string,
  fromPage: number,
  maxChars: number
): { pages: ExtractedPage[]; nextPage: number | null } {
  const rows = db
    .select({ page: extractedText.part, text: extractedText.text })
    .from(extractedText)
    .where(and(eq(extractedText.noteId, noteId), gte(extractedText.part, fromPage)))
    .orderBy(asc(extractedText.part))
    .all()

  const pages: ExtractedPage[] = []
  let used = 0
  for (const row of rows) {
    if (pages.length > 0 && used + row.text.length > maxChars) {
      return { pages, nextPage: row.page }
    }
    pages.push({ page: row.page, text: row.text.slice(0, maxChars) })
    used += row.text.length
  }
  return { pages, nextPage: null }
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
