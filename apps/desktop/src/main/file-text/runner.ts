/**
 * Background text extraction for PDFs and images: filed ones, and the ones in a
 * note's attachments folder, whose text is searchable under that note.
 *
 * One loop, one file at a time, one page at a time. A PDF page with a text
 * layer is read from it; a page without one, and every image, goes through OCR.
 * Every page is stored as it finishes, and a job reads only the pages it has no
 * row for, so a restart resumes where it stopped. Each file's job lives in
 * `file_text_jobs`:
 *
 *   (no job) or signature moved -> pending -> done
 *                                          -> failed (unopenable, missing, or
 *                                             MAX_CONSECUTIVE_FAILURES pages in a row)
 *   failed, under another app version or a day old -> pending again
 *   attachment file gone -> job and text deleted
 *
 * This loop is the only writer of `file_text_jobs` and `extracted_text`. Search
 * and embeddings pick the text up from the `note.text-extracted` events it
 * publishes.
 */
import { readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import { getExtension, getFileType } from '@memry/shared/file-types'
import type { IndexDb } from '../database/types'
import {
  deleteTextSource,
  finishFileTextJob,
  getFileTextJob,
  listAttachmentJobs,
  listFiledTextFiles,
  listMarkdownNotes,
  nextPendingTextJob,
  OWN_FILE,
  retryFileTextJob,
  saveExtractedPart,
  setFileTextPageCount,
  startFileTextJob,
  storedExtractedParts,
  type TextBearingFileType,
  type TextSourceRef
} from '../database/queries/extracted-text'
import type { ExtractedTextMethod, FileTextJobRow } from '@memry/db-schema/schema/extracted-text'
import { createLogger } from '../lib/logger'
import type { OcrImageSource } from './ocr-protocol'
import type { PdfDocument } from './pdf-host'

const logger = createLogger('FileText')

/** About 300 DPI for a Letter page, which is what Tesseract is tuned for. */
const OCR_RENDER_MAX_EDGE = 3300
const MAX_CONSECUTIVE_FAILURES = 3
const ERROR_BACKOFF_MS = 5_000
const FILE_SETTLE_MS = 1_000
/** A failure may be a helper that could not start; give the file another go later. */
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000
/** Where a note's attachments live: `attachments/<noteId>/` (vault/attachments.ts). */
const ATTACHMENTS_DIR = 'attachments'

export interface FileTextDeps {
  vaultPath: string
  /** A job that failed under another version is read again. */
  appVersion: string
  getDb: () => IndexDb
  recognize: (source: OcrImageSource) => Promise<string>
  openPdf: (absolutePath: string, size: number) => Promise<PdfDocument>
  /** Tear down the OCR process and PDF host so in-flight calls fail now. */
  release: () => void
  textChanged: (noteId: string) => void
}

/** A file to read, and the note its text is searchable under. */
interface TextFile extends TextSourceRef {
  path: string
  fileType: TextBearingFileType
}

interface PageText {
  method: ExtractedTextMethod
  text: string
}

/** Same bytes, same signature. A rename keeps it, so a moved file is not read again. */
async function fileSignature(
  absolutePath: string
): Promise<{ signature: string; size: number } | null> {
  try {
    const stats = await stat(absolutePath)
    return { signature: `${stats.size}:${Math.trunc(stats.mtimeMs)}`, size: stats.size }
  } catch {
    return null
  }
}

function textBearingType(fileName: string): TextBearingFileType | null {
  const type = getFileType(getExtension(fileName))
  return type === 'pdf' || type === 'image' ? type : null
}

/** Collapse layout whitespace; keep line and paragraph breaks. */
function normalizeExtractedText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The flush points of a long PDF: pages 1, 2, 4, 8, ... Search sees a long scan
 * fill in as it is read, and the total re-indexing stays within twice the text.
 */
function isFlushPoint(page: number): boolean {
  return (page & (page - 1)) === 0
}

export class FileTextRunner {
  private readonly changed = new Set<string>()
  private rescanAll = true
  private stopped = false
  private wake: (() => void) | null = null
  private loop: Promise<void> | null = null

  constructor(private readonly deps: FileTextDeps) {}

  start(): void {
    this.loop ??= this.run()
  }

  /**
   * A note was indexed: a filed file that may have new bytes, or a note whose
   * attachments may have changed. Compare its files again.
   */
  noteChanged(noteId: string): void {
    this.changed.add(noteId)
    this.wake?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.wake?.()
    this.deps.release()
    await this.loop
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.queueChangedFiles()
        const job = nextPendingTextJob(this.deps.getDb())
        if (job) {
          await this.extract(this.fileOf(job), job.signature)
          continue
        }
        if (this.changed.size > 0 || this.stopped) continue
        await this.sleep()
      } catch (error) {
        if (this.stopped) return
        logger.warn('Text extraction pass failed', { error: errorText(error) })
        await this.sleep(ERROR_BACKOFF_MS)
      }
    }
  }

  /** Until `noteChanged` or `stop`, or `ms` when given. */
  private async sleep(ms?: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(resolve, ms)
      this.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.wake = null
  }

  private fileOf(job: {
    noteId: string
    source: string
    notePath: string
    noteFileType: string
  }): TextFile {
    if (job.source === OWN_FILE) {
      return { ...job, path: job.notePath, fileType: job.noteFileType as TextBearingFileType }
    }
    return {
      noteId: job.noteId,
      source: job.source,
      path: path.join(ATTACHMENTS_DIR, job.noteId, job.source),
      fileType: textBearingType(job.source) ?? 'image'
    }
  }

  /**
   * PDFs and images in the attachments folders of the given notes, or of every
   * note, that the note's body still embeds. A file the note no longer points
   * at stays on disk (only an explicit delete removes it) but is not searchable
   * under the note any more. `unread` lists the notes whose body could not be
   * read: their stored text is left alone.
   */
  private async attachmentFiles(
    ids: readonly string[] | undefined
  ): Promise<{ files: TextFile[]; unread: Set<string> }> {
    const root = path.join(this.deps.vaultPath, ATTACHMENTS_DIR)
    const folders = ids ?? (await readdir(root).catch(() => []))
    const files: TextFile[] = []
    const unread = new Set<string>()
    for (const note of listMarkdownNotes(this.deps.getDb(), folders)) {
      const entries = await readdir(path.join(root, note.id), { withFileTypes: true }).catch(
        () => []
      )
      const candidates = entries.filter(
        (entry) => entry.isFile() && !entry.name.startsWith('.') && textBearingType(entry.name)
      )
      if (candidates.length === 0) continue
      let body: string
      try {
        body = await readFile(path.join(this.deps.vaultPath, note.path), 'utf8')
      } catch {
        unread.add(note.id)
        continue
      }
      for (const entry of candidates) {
        // Every link shape a note uses for its attachments contains this run
        // (vault/attachment-reference-scan.ts).
        if (!body.includes(`${ATTACHMENTS_DIR}/${note.id}/${entry.name}`)) continue
        files.push({
          noteId: note.id,
          source: entry.name,
          path: path.join(ATTACHMENTS_DIR, note.id, entry.name),
          fileType: textBearingType(entry.name) ?? 'image'
        })
      }
    }
    return { files, unread }
  }

  /**
   * Queue every file whose bytes differ from the ones its stored text came
   * from, and forget attachments the note no longer has.
   */
  private async queueChangedFiles(): Promise<void> {
    if (!this.rescanAll && this.changed.size === 0) return
    const ids = this.rescanAll ? undefined : [...this.changed]
    this.rescanAll = false
    this.changed.clear()

    const filed: TextFile[] = listFiledTextFiles(this.deps.getDb(), ids).map((file) => ({
      ...file,
      source: OWN_FILE
    }))
    const attachments = await this.attachmentFiles(ids)
    if (this.stopped) return

    const kept = new Set(attachments.files.map((file) => `${file.noteId}/${file.source}`))
    for (const job of listAttachmentJobs(this.deps.getDb(), ids)) {
      if (attachments.unread.has(job.noteId) || kept.has(`${job.noteId}/${job.source}`)) continue
      deleteTextSource(this.deps.getDb(), job)
      this.deps.textChanged(job.noteId)
    }

    for (const file of [...filed, ...attachments.files]) {
      if (this.stopped) return
      const current = await fileSignature(path.join(this.deps.vaultPath, file.path))
      if (!current) continue
      const db = this.deps.getDb()
      const job = getFileTextJob(db, file)
      if (job?.signature === current.signature) {
        if (job.status === 'failed' && this.isDueForRetry(job)) {
          retryFileTextJob(db, file, this.deps.appVersion)
        }
        continue
      }
      startFileTextJob(db, file, current.signature, this.deps.appVersion)
      if (job) this.deps.textChanged(file.noteId)
    }
  }

  private isDueForRetry(job: FileTextJobRow): boolean {
    return (
      job.appVersion !== this.deps.appVersion ||
      Date.now() - Date.parse(job.updatedAt) >= RETRY_FAILED_AFTER_MS
    )
  }

  private async extract(file: TextFile, signature: string): Promise<void> {
    const db = this.deps.getDb()
    const absolutePath = path.join(this.deps.vaultPath, file.path)
    const current = await fileSignature(absolutePath)
    if (!current) {
      finishFileTextJob(db, file, 'failed', 'File not found')
      return
    }
    if (current.signature !== signature) {
      this.changed.add(file.noteId)
      // Still being written, most likely: let the copy settle before reading.
      await this.sleep(FILE_SETTLE_MS)
      return
    }
    logger.debug('Reading text', {
      noteId: file.noteId,
      attachment: file.source !== OWN_FILE,
      fileType: file.fileType
    })

    if (file.fileType === 'image') {
      const result = await this.readTwice(() => this.ocr({ kind: 'file', path: absolutePath }))
      if (!this.owns(file, signature)) return
      setFileTextPageCount(db, file, 1)
      saveExtractedPart(db, file, 1, result.method, result.text)
      finishFileTextJob(db, file, result.method === 'unreadable' ? 'failed' : 'done')
      this.deps.textChanged(file.noteId)
      return
    }

    await this.extractPdf(file, signature, absolutePath, current.size)
  }

  private async extractPdf(
    file: TextFile,
    signature: string,
    absolutePath: string,
    size: number
  ): Promise<void> {
    const db = this.deps.getDb()
    let pdf: PdfDocument
    try {
      pdf = await this.deps.openPdf(absolutePath, size)
    } catch (error) {
      if (this.stopped || !this.owns(file, signature)) return
      logger.warn('Could not open PDF for text extraction', {
        noteId: file.noteId,
        error: errorText(error)
      })
      finishFileTextJob(db, file, 'failed', errorText(error))
      return
    }

    try {
      setFileTextPageCount(db, file, pdf.pageCount)
      const stored = storedExtractedParts(db, file)
      let failuresInARow = 0
      for (let page = 1; page <= pdf.pageCount; page++) {
        if (stored.has(page)) continue
        if (this.stopped || (await this.rewrittenSince(file, signature, absolutePath))) return
        const result = await this.readTwice(
          () => this.readPdfPage(pdf, page),
          async () => {
            await pdf.close()
            pdf = await this.deps.openPdf(absolutePath, size)
          }
        )
        if (!this.owns(file, signature)) return
        saveExtractedPart(db, file, page, result.method, result.text)

        failuresInARow = result.method === 'unreadable' ? failuresInARow + 1 : 0
        if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
          finishFileTextJob(db, file, 'failed', `Pages up to ${page} could not be read`)
          this.deps.textChanged(file.noteId)
          return
        }
        if (isFlushPoint(page)) this.deps.textChanged(file.noteId)
      }
      finishFileTextJob(db, file, 'done')
      this.deps.textChanged(file.noteId)
    } finally {
      await pdf.close().catch(() => {})
    }
  }

  /**
   * Checked between pages only once the note was flagged, which for an
   * attachment is every edit of its note: only new bytes stop the read.
   */
  private async rewrittenSince(
    file: TextFile,
    signature: string,
    absolutePath: string
  ): Promise<boolean> {
    if (!this.changed.has(file.noteId)) return false
    return (await fileSignature(absolutePath))?.signature !== signature
  }

  private async readPdfPage(pdf: PdfDocument, page: number): Promise<PageText> {
    const layer = normalizeExtractedText(await pdf.pageText(page))
    if (layer) return { method: 'pdf-text', text: layer }
    const rendered = await pdf.renderPage(page, OCR_RENDER_MAX_EDGE)
    return this.ocr({ kind: 'png', data: rendered.png })
  }

  private async ocr(source: OcrImageSource): Promise<PageText> {
    return { method: 'ocr', text: normalizeExtractedText(await this.deps.recognize(source)) }
  }

  /**
   * One retry, because the usual failure is a crashed or timed-out helper that
   * the second call starts fresh. A stop is not a failure: the page is left
   * unstored so the next run reads it.
   */
  private async readTwice(
    read: () => Promise<PageText>,
    beforeRetry?: () => Promise<void>
  ): Promise<PageText> {
    try {
      return await read()
    } catch (error) {
      if (this.stopped) throw error
    }
    try {
      await beforeRetry?.()
      return await read()
    } catch (error) {
      if (this.stopped) throw error
      logger.warn('Text extraction gave up on a page', { error: errorText(error) })
      return { method: 'unreadable', text: '' }
    }
  }

  /**
   * The job still exists with the bytes it started from. False after a stop,
   * after the index was rebuilt under us, or once the file changed.
   */
  private owns(file: TextSourceRef, signature: string): boolean {
    if (this.stopped) return false
    return getFileTextJob(this.deps.getDb(), file)?.signature === signature
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
