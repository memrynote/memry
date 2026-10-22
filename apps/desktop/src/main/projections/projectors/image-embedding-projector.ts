import { getIndexDatabase, getRawIndexDatabase } from '../../database'
import {
  deleteImageEmbedding,
  listImageEmbeddingState,
  listImageSources,
  pruneOrphanImageEmbeddings,
  storeImageEmbedding,
  type ImageSource
} from '@main/database/queries/image-embeddings'
import { stat } from 'fs/promises'
import { buildInterleavedInput, IMAGE_EMBEDDING_INPUT_VERSION } from '../../lib/embedding-input'
import {
  EMBEDDING_PAGE_RENDER_EDGE,
  EMBEDDING_PAGE_SOFT_TOKENS
} from '../../lib/embeddings-constants'
import type { PdfDocument } from '../../file-text/pdf-host'
import { embedImage, isImageEmbeddingEnabled } from '../../lib/image-embedding'
import { createLogger } from '../../lib/logger'
import { openVaultFile, resolveVaultFile } from '../../lib/paths'
import type { ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:ImageEmbeddings')

/** Larger files are skipped: the bytes cross to the worker in one message. */
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
/** Consecutive failed embeds that end a pass: the encoder is down, offline or backing off. */
const MAX_CONSECUTIVE_FAILURES = 3

async function readImageBytes(vaultPath: string, relativePath: string): Promise<Buffer | null> {
  const handle = await openVaultFile(vaultPath, relativePath)
  if (handle === null) return null
  try {
    if ((await handle.stat()).size > MAX_IMAGE_BYTES) return null
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/**
 * Image vectors beside the text vectors, in `vec_images`, keyed like the text
 * extraction job that found the file (a filed file, or one a note embeds).
 * Searchable by text because both encoders share one space. An image with no
 * text read from it is embedded alone. An image with text (a screenshot, a
 * scan) and every page of a PDF (its first MAX_EMBEDDED_PDF_PAGES) is embedded
 * interleaved: the page image at 280 soft tokens plus that page's text in one
 * vector, which beat OCR text alone and the image alone in the measurement
 * recorded in docs (#3129).
 *
 * An image is embedded once its text extraction job has settled, after the
 * `note.text-extracted` event that job publishes, and again when its bytes
 * change (signature) or `IMAGE_EMBEDDING_INPUT_VERSION` moves. A failed embed
 * stores nothing and is tried again on the next event or vault open; a pass
 * gives up after a few failures in a row. Nothing here loads the vision
 * encoder unless an image is owed a vector and image embeddings are on.
 */
export function createImageEmbeddingProjector(
  getVaultPath: () => string | null,
  openPdf: (absolutePath: string, size: number) => Promise<PdfDocument>
): ProjectionProjector {
  /** The PDF a pass is on; consecutive pages of one file share it. */
  let openDocument: { path: string; pdf: PdfDocument } | null = null

  const closeDocument = async (): Promise<void> => {
    const current = openDocument
    openDocument = null
    await current?.pdf.close().catch(() => {})
  }

  const renderPdfPage = async (
    vaultPath: string,
    relativePath: string,
    page: number
  ): Promise<Uint8Array | null> => {
    if (openDocument?.path !== relativePath) {
      await closeDocument()
      const resolved = await resolveVaultFile(vaultPath, relativePath)
      if (resolved.kind !== 'inside') return null
      const { size } = await stat(resolved.path)
      openDocument = { path: relativePath, pdf: await openPdf(resolved.path, size) }
    }
    if (page > openDocument.pdf.pageCount) return null
    return (await openDocument.pdf.renderPage(page, EMBEDDING_PAGE_RENDER_EDGE)).png
  }

  const embedOne = async (vaultPath: string, image: ImageSource): Promise<boolean> => {
    try {
      const bytes =
        image.page === null
          ? await readImageBytes(vaultPath, image.path)
          : await renderPdfPage(vaultPath, image.path, image.page)
      if (!bytes) return false
      const text = buildInterleavedInput(image.text)
      // Pages and images with text are documents and get the page budget.
      const isDocument = text !== null || image.page !== null
      const embedding = await embedImage(
        bytes,
        isDocument ? { text: text ?? undefined, softTokens: EMBEDDING_PAGE_SOFT_TOKENS } : undefined
      )
      if (!embedding) return false
      storeImageEmbedding(getRawIndexDatabase(), image, embedding, IMAGE_EMBEDDING_INPUT_VERSION)
      return true
    } catch (error) {
      await closeDocument()
      logger.warn('Failed to embed image', { noteId: image.noteId, error })
      return false
    }
  }

  /**
   * Make the vectors of `noteIds` (or of every note) match the images the index
   * knows: drop the ones whose image is gone, embed the missing and outdated
   * ones, images with no vector first.
   */
  const sync = async (noteIds?: readonly string[], signal?: AbortSignal): Promise<void> => {
    const raw = getRawIndexDatabase()
    const indexDb = getIndexDatabase()
    const images = listImageSources(indexDb, noteIds)
    const known = new Set(images.map((image) => `${image.noteId}/${image.source}`))
    const state = noteIds
      ? noteIds.flatMap((id) => listImageEmbeddingState(indexDb, id))
      : listImageEmbeddingState(indexDb)
    for (const row of state) {
      if (!known.has(`${row.noteId}/${row.source}`)) deleteImageEmbedding(raw, row)
    }

    const vaultPath = getVaultPath()
    if (!vaultPath || !isImageEmbeddingEnabled()) return

    const stored = new Map(state.map((row) => [`${row.noteId}/${row.source}`, row]))
    const owed = images.filter((image) => {
      if (!image.settled) return false
      const row = stored.get(`${image.noteId}/${image.source}`)
      return (
        !row ||
        row.signature !== image.signature ||
        row.inputVersion !== IMAGE_EMBEDDING_INPUT_VERSION
      )
    })
    const isNew = (image: ImageSource): boolean => !stored.has(`${image.noteId}/${image.source}`)
    const workList = [...owed.filter(isNew), ...owed.filter((image) => !isNew(image))]

    let failures = 0
    try {
      for (const image of workList) {
        if (signal?.aborted) return
        failures = (await embedOne(vaultPath, image)) ? 0 : failures + 1
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          logger.warn('Image embedding paused after repeated failures', {
            remaining: workList.length
          })
          return
        }
      }
    } finally {
      await closeDocument()
    }
  }

  return {
    name: 'image-embedding',

    // Vision inference takes seconds per image; nothing reads vectors back in
    // the same turn.
    background: true,

    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.deleted' || event.type === 'note.text-extracted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'note.deleted') {
        try {
          // The note's state rows went with its `note_cache` row, so its vectors are
          // found as the ones no state row accounts for.
          pruneOrphanImageEmbeddings(getRawIndexDatabase())
        } catch {
          // ignore missing vec table during shutdown/setup
        }
        return
      }
      if (event.type !== 'note.text-extracted') return
      await sync([event.noteId])
    },

    async rebuild(): Promise<void> {
      const raw = getRawIndexDatabase()
      raw.prepare('DELETE FROM vec_images').run()
      raw.prepare('DELETE FROM image_embedding_state').run()
      await sync()
    },

    /**
     * Backfill for vaults whose images predate this projector, or whose vectors
     * are outdated. Runs after the vault is open, one image at a time in the
     * encoder's own process, and stops when `signal` aborts.
     */
    async reconcile(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return
      pruneOrphanImageEmbeddings(getRawIndexDatabase())
      await sync(undefined, signal)
    }
  }
}
