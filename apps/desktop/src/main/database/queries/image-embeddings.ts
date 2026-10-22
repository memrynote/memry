import { sql } from 'drizzle-orm'
import { getExtension, getFileType } from '@memry/shared/file-types'
import type Database from 'better-sqlite3'
import { MAX_EMBEDDED_PDF_PAGES } from '../../lib/embeddings-constants'
import type { IndexDb } from '../types'

/**
 * An image, or one page of a PDF, that the vision encoder can read, and where
 * its vector is keyed.
 */
export interface ImageSource {
  noteId: string
  /**
   * Empty for a filed image's own file, else a file name in the note's
   * attachments folder; a PDF page adds `#<page>` (`#3`, `scan.pdf#3`).
   */
  source: string
  /**
   * Size and mtime of the bytes, from the text extraction job that read the same
   * file, and the length of the text read from it: the vector joins that text,
   * so a new read (another OCR language) is a new input.
   */
  signature: string
  /** Vault-relative path of the file. */
  path: string
  /** 1-based page of the PDF at `path`; null for an image file. */
  page: number | null
  /** Text read from the image or page, joined to its pixels; empty when none was read. */
  text: string
  /** False while the file's OCR job is still `pending`: its bytes are about to be handed over. */
  settled: boolean
}

export interface ImageEmbeddingStateRow {
  noteId: string
  source: string
  signature: string
  inputVersion: number
}

/** `vec_images` key of an image, the same expression as {@link IMAGE_KEY_SQL}. */
export function imageKey(ref: { noteId: string; source: string }): string {
  return `${ref.noteId}/${ref.source}`
}

/** SQL twin of {@link imageKey} over `image_embedding_state` columns. */
const IMAGE_KEY_SQL = "note_id || '/' || source"

/** Formats the vision encoder's decoder reads. SVG is a text format it cannot rasterize. */
function isEmbeddableImageName(fileName: string): boolean {
  const extension = getExtension(fileName).toLowerCase()
  return extension !== 'svg' && getFileType(extension) === 'image'
}

interface JobRow {
  noteId: string
  source: string
  signature: string
  status: string
  pageCount: number | null
  notePath: string
  noteFileType: string | null
}

/**
 * Images with a text extraction job, for the given notes or every note. The job
 * exists exactly when the file runner found the image (filed, or embedded by a
 * note), and its signature is the one this table's vectors are keyed against,
 * so image embedding never rescans the vault. A `pending` job is listed
 * unsettled: OCR of a file runs first, and its `note.text-extracted` event hands
 * the file over.
 */
export function listImageSources(db: IndexDb, noteIds?: readonly string[]): ImageSource[] {
  const rows = db.all<JobRow>(sql`
    SELECT j.note_id AS noteId, j.source AS source, j.signature AS signature, j.status AS status, j.page_count AS pageCount,
      nc.path AS notePath, nc.file_type AS noteFileType
    FROM file_text_jobs j
    JOIN note_cache nc ON nc.id = j.note_id
    ${
      noteIds
        ? sql`WHERE j.note_id IN (${sql.join(
            noteIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        : sql``
    }
  `)
  const texts = readSourceTexts(db, noteIds)
  const sources: ImageSource[] = []
  for (const row of rows) {
    const settled = row.status !== 'pending'
    const filePath = row.source === '' ? row.notePath : `attachments/${row.noteId}/${row.source}`
    const fileType = row.source === '' ? row.noteFileType : attachmentType(row.source)
    const pageText = (page: number): string =>
      texts.get(`${row.noteId}/${row.source}/${page}`) ?? ''
    if (fileType === 'image' && isEmbeddableImageName(filePath)) {
      const text = pageText(1)
      sources.push({
        noteId: row.noteId,
        source: row.source,
        signature: `${row.signature}|${text.length}`,
        path: filePath,
        page: null,
        text,
        settled
      })
    } else if (fileType === 'pdf') {
      const pages = Math.min(row.pageCount ?? 0, MAX_EMBEDDED_PDF_PAGES)
      for (let page = 1; page <= pages; page++) {
        const text = pageText(page)
        sources.push({
          noteId: row.noteId,
          source: `${row.source}#${page}`,
          signature: `${row.signature}|${text.length}`,
          path: filePath,
          page,
          text,
          settled
        })
      }
    }
  }
  return sources
}

function attachmentType(fileName: string): string | null {
  return getFileType(getExtension(fileName).toLowerCase())
}

/** Extracted text of images and of the first pages of PDFs, by `noteId/source/part`. */
function readSourceTexts(db: IndexDb, noteIds?: readonly string[]): Map<string, string> {
  const rows = db.all<{ noteId: string; source: string; part: number; text: string }>(sql`
    SELECT note_id AS noteId, source, part, text FROM extracted_text
    WHERE part <= ${MAX_EMBEDDED_PDF_PAGES} AND text != ''
    ${
      noteIds
        ? sql`AND note_id IN (${sql.join(
            noteIds.map((id) => sql`${id}`),
            sql`, `
          )})`
        : sql``
    }
  `)
  return new Map(rows.map((row) => [`${row.noteId}/${row.source}/${row.part}`, row.text]))
}

export function listImageEmbeddingState(db: IndexDb, noteId?: string): ImageEmbeddingStateRow[] {
  return db.all<ImageEmbeddingStateRow>(sql`
    SELECT note_id AS noteId, source, signature, input_version AS inputVersion
    FROM image_embedding_state
    ${noteId === undefined ? sql`` : sql`WHERE note_id = ${noteId}`}
  `)
}

export function storeImageEmbedding(
  raw: Database.Database,
  ref: ImageSource,
  embedding: Float32Array,
  inputVersion: number
): void {
  const key = imageKey(ref)
  raw.prepare('DELETE FROM vec_images WHERE image_key = ?').run(key)
  raw.prepare('INSERT INTO vec_images (image_key, embedding) VALUES (?, ?)').run(key, embedding)
  raw
    .prepare(
      `INSERT OR REPLACE INTO image_embedding_state (note_id, source, signature, input_version)
       VALUES (?, ?, ?, ?)`
    )
    .run(ref.noteId, ref.source, ref.signature, inputVersion)
}

export function deleteImageEmbedding(
  raw: Database.Database,
  ref: { noteId: string; source: string }
): void {
  raw.prepare('DELETE FROM vec_images WHERE image_key = ?').run(imageKey(ref))
  raw
    .prepare('DELETE FROM image_embedding_state WHERE note_id = ? AND source = ?')
    .run(ref.noteId, ref.source)
}

/**
 * Drop vectors no state row accounts for (a note removed: its state rows go with
 * the `note_cache` row, so nothing names its vectors any more; or a quit between
 * the two writes) and state rows whose vector is gone.
 */
export function pruneOrphanImageEmbeddings(raw: Database.Database): void {
  raw
    .prepare(
      `DELETE FROM vec_images
       WHERE image_key NOT IN (SELECT ${IMAGE_KEY_SQL} FROM image_embedding_state)`
    )
    .run()
  raw
    .prepare(
      `DELETE FROM image_embedding_state
       WHERE ${IMAGE_KEY_SQL} NOT IN (SELECT image_key FROM vec_images)`
    )
    .run()
}

/** Nearest image vectors to a query vector, as owning-note hits. */
export function nearestImageVectors(
  raw: Database.Database,
  query: Float32Array,
  k: number
): Array<{ noteId: string; cosine: number }> {
  const rows = raw
    .prepare(
      `SELECT image_key, distance FROM vec_images
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    )
    .all(query, k) as Array<{ image_key: string; distance: number }>
  return rows.map((row) => ({
    // A note id has no '/', so the owner is everything before the first one.
    noteId: row.image_key.slice(0, row.image_key.indexOf('/')),
    cosine: 1 - row.distance
  }))
}
