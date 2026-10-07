import {
  countExtractedParts,
  getFileTextJob,
  OWN_FILE,
  readExtractedPages
} from '../../../database/queries/extracted-text'
import type { IndexDb } from '../../../database'
import type { ExtractedTextReply } from './handles'

/** Same ceiling as an oversized desktop API reply (AF-013). */
export const EXTRACTED_TEXT_REPLY_CHARS = 100_000

export function extractedTextReply(
  indexDb: IndexDb,
  id: string,
  fromPage: number
): ExtractedTextReply {
  const ref = { noteId: id, source: OWN_FILE }
  const job = getFileTextJob(indexDb, ref)
  const { pages, nextPage } = readExtractedPages(indexDb, id, fromPage, EXTRACTED_TEXT_REPLY_CHARS)
  return {
    status: job?.status === 'done' || job?.status === 'failed' ? job.status : 'extracting',
    page_count: job?.pageCount ?? null,
    pages_read: countExtractedParts(indexDb, ref),
    pages,
    next_page: nextPage,
    ...(job?.error ? { error: job.error } : {})
  }
}
