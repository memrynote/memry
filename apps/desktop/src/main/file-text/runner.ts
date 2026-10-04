/**
 * Background text extraction for filed PDFs and images.
 *
 * One loop, one file at a time, one page at a time. A PDF page with a text
 * layer is read from it; a page without one, and every image, goes through OCR.
 * Every page is stored as it finishes, so a restart resumes after the last
 * stored page. Each file's job lives in `file_text_jobs`:
 *
 *   (no job) or signature moved -> pending -> done
 *                                          -> failed (unopenable, missing, or
 *                                             MAX_CONSECUTIVE_FAILURES pages in a row)
 *
 * This loop is the only writer of `file_text_jobs` and `extracted_text`. Search
 * and embeddings pick the text up from the `note.text-extracted` events it
 * publishes.
 */
import { stat } from 'fs/promises'
import path from 'path'
import type { IndexDb } from '../database/types'
import {
  finishFileTextJob,
  getFileTextJob,
  listFileTextCandidates,
  nextExtractedPart,
  nextPendingFileTextJob,
  saveExtractedPart,
  setFileTextPageCount,
  startFileTextJob,
  type FileTextCandidate
} from '../database/queries/extracted-text'
import type { ExtractedTextMethod } from '@memry/db-schema/schema/extracted-text'
import { createLogger } from '../lib/logger'
import type { OcrImageSource } from './ocr-protocol'
import type { PdfDocument } from './pdf-host'

const logger = createLogger('FileText')

/** About 300 DPI for a Letter page, which is what Tesseract is tuned for. */
const OCR_RENDER_MAX_EDGE = 3300
const MAX_CONSECUTIVE_FAILURES = 3
const ERROR_BACKOFF_MS = 5_000
const FILE_SETTLE_MS = 1_000

export interface FileTextDeps {
  vaultPath: string
  getDb: () => IndexDb
  recognize: (source: OcrImageSource) => Promise<string>
  openPdf: (absolutePath: string, size: number) => Promise<PdfDocument>
  /** Tear down the OCR process and PDF host so in-flight calls fail now. */
  release: () => void
  textChanged: (noteId: string) => void
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

  /** A filed note was added, moved, or rewritten; compare its bytes again. */
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
        const job = nextPendingFileTextJob(this.deps.getDb())
        if (job) {
          await this.extract(job)
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

  /** Queue every file whose bytes differ from the ones its stored text came from. */
  private async queueChangedFiles(): Promise<void> {
    if (!this.rescanAll && this.changed.size === 0) return
    const ids = this.rescanAll ? undefined : [...this.changed]
    this.rescanAll = false
    this.changed.clear()

    for (const file of listFileTextCandidates(this.deps.getDb(), ids)) {
      if (this.stopped) return
      const current = await fileSignature(path.join(this.deps.vaultPath, file.path))
      if (!current) continue
      const db = this.deps.getDb()
      const job = getFileTextJob(db, file.id)
      if (job?.signature === current.signature) continue
      startFileTextJob(db, file.id, current.signature)
      if (job) this.deps.textChanged(file.id)
    }
  }

  private async extract(job: FileTextCandidate & { signature: string }): Promise<void> {
    const db = this.deps.getDb()
    const absolutePath = path.join(this.deps.vaultPath, job.path)
    const current = await fileSignature(absolutePath)
    if (!current) {
      finishFileTextJob(db, job.id, 'failed', 'File not found')
      return
    }
    if (current.signature !== job.signature) {
      this.changed.add(job.id)
      // Still being written, most likely: let the copy settle before reading.
      await this.sleep(FILE_SETTLE_MS)
      return
    }
    logger.debug('Reading text', { noteId: job.id, fileType: job.fileType })

    if (job.fileType === 'image') {
      const result = await this.readTwice(() => this.ocr({ kind: 'file', path: absolutePath }))
      if (!this.owns(job)) return
      setFileTextPageCount(db, job.id, 1)
      saveExtractedPart(db, job.id, 1, result.method, result.text)
      finishFileTextJob(db, job.id, result.method === 'unreadable' ? 'failed' : 'done')
      this.deps.textChanged(job.id)
      return
    }

    await this.extractPdf(job, absolutePath, current.size)
  }

  private async extractPdf(
    job: FileTextCandidate & { signature: string },
    absolutePath: string,
    size: number
  ): Promise<void> {
    const db = this.deps.getDb()
    let pdf: PdfDocument
    try {
      pdf = await this.deps.openPdf(absolutePath, size)
    } catch (error) {
      if (this.stopped || !this.owns(job)) return
      logger.warn('Could not open PDF for text extraction', {
        noteId: job.id,
        error: errorText(error)
      })
      finishFileTextJob(db, job.id, 'failed', errorText(error))
      return
    }

    try {
      setFileTextPageCount(db, job.id, pdf.pageCount)
      let failuresInARow = 0
      for (let page = nextExtractedPart(db, job.id); page <= pdf.pageCount; page++) {
        if (this.stopped || this.changed.has(job.id)) return
        const result = await this.readTwice(
          () => this.readPdfPage(pdf, page),
          async () => {
            await pdf.close()
            pdf = await this.deps.openPdf(absolutePath, size)
          }
        )
        if (!this.owns(job)) return
        saveExtractedPart(db, job.id, page, result.method, result.text)

        failuresInARow = result.method === 'unreadable' ? failuresInARow + 1 : 0
        if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
          finishFileTextJob(db, job.id, 'failed', `Pages up to ${page} could not be read`)
          this.deps.textChanged(job.id)
          return
        }
        if (isFlushPoint(page)) this.deps.textChanged(job.id)
      }
      finishFileTextJob(db, job.id, 'done')
      this.deps.textChanged(job.id)
    } finally {
      await pdf.close().catch(() => {})
    }
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
  private owns(job: { id: string; signature: string }): boolean {
    if (this.stopped) return false
    return getFileTextJob(this.deps.getDb(), job.id)?.signature === job.signature
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
